import type { InflowClient } from '../client/inflow.js';
import { semanticDiff } from '../core/canonical-json.js';
import type { ProductGroup, ProductGroupQuantity, ProductVariant } from '../types/inflow.js';
import {
  canonicalizeManufacturingConfig,
  fetchManufacturingProduct,
  manufacturingConfigHash,
  normalizeManufacturingProduct,
} from '../tools/product-manufacturing.js';

export interface VariantSelection {
  productGroupOptionId: string;
  productGroupOptionValueId: string;
}

function selectionFromVariant(variant: ProductVariant): VariantSelection[] | undefined {
  const raw = variant.variantOption;
  if (Array.isArray(raw)) {
    const rows = raw.map((entry) => entry as Record<string, unknown>);
    if (!rows.every((row) => typeof row.productGroupOptionId === 'string' && typeof row.productGroupOptionValueId === 'string')) return undefined;
    return rows.map((row) => ({ productGroupOptionId: row.productGroupOptionId as string, productGroupOptionValueId: row.productGroupOptionValueId as string }));
  }
  if (raw && typeof raw === 'object') {
    const rows: VariantSelection[] = [];
    for (const [optionId, value] of Object.entries(raw)) {
      if (typeof value === 'string') rows.push({ productGroupOptionId: optionId, productGroupOptionValueId: value });
      else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).productGroupOptionValueId === 'string') {
        rows.push({ productGroupOptionId: optionId, productGroupOptionValueId: (value as Record<string, unknown>).productGroupOptionValueId as string });
      } else return undefined;
    }
    return rows;
  }
  return undefined;
}

function key(rows: VariantSelection[]): string {
  return [...rows].sort((a, b) => a.productGroupOptionId.localeCompare(b.productGroupOptionId)).map((row) => `${row.productGroupOptionId}=${row.productGroupOptionValueId}`).join('|');
}

function cartesian(options: Array<{ id: string; values: string[] }>, limit: number): string[] {
  let keys = [''];
  for (const option of options) {
    if (keys.length * option.values.length > limit) throw new Error(`PRODUCT_GROUP_MATRIX_LIMIT_EXCEEDED: ${limit}`);
    keys = keys.flatMap((prefix) => option.values.map((value) => `${prefix}${prefix ? '|' : ''}${option.id}=${value}`));
  }
  return keys.sort();
}

export async function auditProductGroupManufacturing(client: InflowClient, input: {
  productGroupId: string;
  baselineProductId?: string;
  locationId?: string;
  includeInactive: boolean;
  maxVariants: number;
}) {
  const group = await client.get<ProductGroup>(`/product-groups/${input.productGroupId}`, { include: ['options.optionValues', 'productVariants.product'] });
  const variants = group.productVariants ?? [];
  if (variants.length > input.maxVariants) throw new Error(`PRODUCT_GROUP_VARIANT_LIMIT_EXCEEDED: ${input.maxVariants}`);
  const optionOrder = (group.options ?? []).map((option) => ({
    id: option.productGroupOptionId ?? '',
    values: (option.optionValues ?? []).map((value) => value.productGroupOptionValueId ?? '').filter(Boolean).sort(),
  })).filter((option) => option.id).sort((a, b) => a.id.localeCompare(b.id));
  const expectedKeys = cartesian(optionOrder, input.maxVariants);
  const knownOptions = new Map(optionOrder.map((option) => [option.id, new Set(option.values)]));
  const combinationCounts = new Map<string, number>();
  const duplicateAttachments = new Set<string>();
  const seenVariantIds = new Set<string>();
  const seenProductIds = new Set<string>();
  const duplicateProductAttachments = new Set<string>();
  const normalized = variants.map((variant) => {
    const selection = selectionFromVariant(variant);
    const issues: string[] = [];
    if (variant.productVariantId && seenVariantIds.has(variant.productVariantId)) duplicateAttachments.add(variant.productVariantId);
    if (variant.productVariantId) seenVariantIds.add(variant.productVariantId);
    if (!selection) issues.push('UNKNOWN_VARIANT_OPTION_SHAPE');
    else {
      if (selection.length !== knownOptions.size) issues.push('INCOMPLETE_OPTION_SELECTION');
      if (new Set(selection.map((row) => row.productGroupOptionId)).size !== selection.length) issues.push('DUPLICATE_OPTION_SELECTION');
      for (const row of selection) {
        if (!knownOptions.has(row.productGroupOptionId)) issues.push(`UNKNOWN_OPTION:${row.productGroupOptionId}`);
        else if (!knownOptions.get(row.productGroupOptionId)!.has(row.productGroupOptionValueId)) issues.push(`UNKNOWN_OPTION_VALUE:${row.productGroupOptionValueId}`);
      }
      const combination = key(selection);
      combinationCounts.set(combination, (combinationCounts.get(combination) ?? 0) + 1);
    }
    if (!variant.productId) issues.push('MISSING_PRODUCT_ID');
    else if (seenProductIds.has(variant.productId)) {
      issues.push('DUPLICATE_PRODUCT_ATTACHMENT');
      duplicateProductAttachments.add(variant.productId);
    } else seenProductIds.add(variant.productId);
    if (variant.product?.isActive === false) issues.push('INACTIVE_PRODUCT');
    return { variant, selection, combinationKey: selection ? key(selection) : null, issues };
  });

  const fetchRows = normalized.filter((row) => row.variant.productId && (input.includeInactive || row.variant.product?.isActive !== false));
  const manufacturing = new Map<string, { envelope: ReturnType<typeof normalizeManufacturingProduct>; hash: string }>();
  const failures = new Map<string, string>();
  for (let index = 0; index < fetchRows.length; index += 4) {
    await Promise.all(fetchRows.slice(index, index + 4).map(async (row) => {
      const id = row.variant.productId!;
      try {
        const envelope = normalizeManufacturingProduct(await fetchManufacturingProduct(client, id));
        manufacturing.set(id, { envelope, hash: manufacturingConfigHash(envelope) });
      } catch (error) { failures.set(id, error instanceof Error ? error.message : String(error)); }
    }));
  }
  let quantities: ProductGroupQuantity[] = [];
  if (input.locationId) {
    try {
      const response = await client.get<ProductGroupQuantity[] | { data: ProductGroupQuantity[] }>(`/product-groups/${input.productGroupId}/quantities/${input.locationId}`, { params: { locationId: input.locationId } });
      quantities = Array.isArray(response) ? response : response.data;
    } catch (error) { failures.set('group-quantities', error instanceof Error ? error.message : String(error)); }
  }
  const attachedIds = new Set(variants.map((variant) => variant.productId).filter((id): id is string => Boolean(id)));
  if (input.baselineProductId && !attachedIds.has(input.baselineProductId)) throw new Error('BASELINE_PRODUCT_NOT_ATTACHED');
  const hashMembers = new Map<string, string[]>();
  for (const [id, value] of manufacturing) hashMembers.set(value.hash, [...(hashMembers.get(value.hash) ?? []), id]);
  const clusters = [...hashMembers.entries()].map(([hash, productIds]) => ({ hash, productIds: productIds.sort() })).sort((a, b) => b.productIds.length - a.productIds.length || a.productIds[0]!.localeCompare(b.productIds[0]!));
  const baselineProductId = input.baselineProductId ?? clusters[0]?.productIds[0];
  const baseline = baselineProductId ? manufacturing.get(baselineProductId) : undefined;
  const presentKeys = new Set(normalized.map((row) => row.combinationKey).filter((value): value is string => Boolean(value)));
  const duplicateCombinations = [...combinationCounts.entries()].filter(([, count]) => count > 1).map(([combinationKey, count]) => ({ combinationKey, count })).sort((a, b) => a.combinationKey.localeCompare(b.combinationKey));
  const rows = normalized.map((row) => {
    const id = row.variant.productId;
    const config = id ? manufacturing.get(id) : undefined;
    const issues = [...row.issues];
    if (row.combinationKey && (combinationCounts.get(row.combinationKey) ?? 0) > 1) issues.push('DUPLICATE_COMBINATION');
    if (id && failures.has(id)) issues.push('MANUFACTURING_FETCH_FAILED');
    if (config?.envelope.components.length === 0) issues.push('EMPTY_BOM');
    if (config?.envelope.components.some((component) => component.childProductIsActive === false)) issues.push('INACTIVE_COMPONENT');
    if (config?.envelope.components.some((component) => !component.childProductName)) issues.push('UNRESOLVED_COMPONENT');
    const quantity = quantities.find((candidate) => candidate.productId === id || candidate.productVariantId === row.variant.productVariantId);
    return {
      productVariantId: row.variant.productVariantId,
      productId: id,
      productName: row.variant.product?.name,
      productSku: row.variant.product?.sku,
      isActive: row.variant.product?.isActive,
      selection: row.selection,
      combinationKey: row.combinationKey,
      manufacturingHash: config?.hash,
      matchesBaseline: baseline && config ? baseline.hash === config.hash : null,
      differenceFromBaseline: baseline && config ? semanticDiff(canonicalizeManufacturingConfig(baseline.envelope), canonicalizeManufacturingConfig(config.envelope)) : null,
      quantity: quantity ?? null,
      issues: [...new Set(issues)].sort(),
    };
  });
  const missingCombinations = expectedKeys.filter((combination) => !presentKeys.has(combination));
  const complete = failures.size === 0 && rows.every((row) => row.issues.length === 0) && missingCombinations.length === 0 && duplicateCombinations.length === 0 && duplicateAttachments.size === 0 && duplicateProductAttachments.size === 0;
  return {
    schemaVersion: 'product-group-manufacturing-audit/v1',
    productGroupId: input.productGroupId,
    groupName: group.name,
    complete,
    baselineProductId: baselineProductId ?? null,
    baselineHash: baseline?.hash ?? null,
    expectedCombinationCount: expectedKeys.length,
    attachedVariantCount: variants.length,
    missingCombinations,
    duplicateCombinations,
    duplicateVariantAttachmentIds: [...duplicateAttachments].sort(),
    duplicateProductAttachmentIds: [...duplicateProductAttachments].sort(),
    clusters,
    variants: rows,
    failures: [...failures.entries()].map(([resourceId, message]) => ({ resourceId, message })),
  };
}
