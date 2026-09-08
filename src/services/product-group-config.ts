import type { ProductGroup, ProductGroupOption, ProductGroupOptionValue, ProductVariant } from '../types/inflow.js';

export interface OptionValueInput { productGroupOptionValueId?: string; name: string }
export interface OptionInput { productGroupOptionId?: string; name: string; lineNum?: number; optionValues?: OptionValueInput[] }
export interface VariantInput {
  productVariantId?: string;
  productId: string;
  selection: Array<{ productGroupOptionId: string; productGroupOptionValueId: string }>;
}

export function groupSemantic(group: ProductGroup) {
  return {
    productGroupId: group.productGroupId ?? null,
    name: group.name ?? null,
    description: group.description ?? null,
    isActive: group.isActive ?? false,
    categoryId: group.categoryId ?? null,
    defaultProductId: group.defaultProductId ?? null,
    defaultImageId: group.defaultImageId ?? null,
    options: (group.options ?? []).map((option) => ({
      name: option.name ?? null,
      lineNum: option.lineNum ?? null,
      values: (option.optionValues ?? []).map((value) => ({ name: value.name ?? value.value ?? value.optionValue ?? null })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    })).sort((a, b) => (a.lineNum ?? Number.MAX_SAFE_INTEGER) - (b.lineNum ?? Number.MAX_SAFE_INTEGER) || (a.name ?? '').localeCompare(b.name ?? '')),
    variants: (group.productVariants ?? []).map((variant) => ({
      productId: variant.productId ?? null,
      selection: normalizeSelection(variant.variantOption),
    })).sort((a, b) => (a.productId ?? '').localeCompare(b.productId ?? '')),
  };
}

export function groupWriteShape(group: ProductGroup) {
  return {
    ...groupSemantic(group),
    timestamp: group.timestamp ?? null,
    options: (group.options ?? []).map((option) => ({
      productGroupOptionId: option.productGroupOptionId ?? null,
      timestamp: option.timestamp ?? null,
      values: (option.optionValues ?? []).map((value) => ({ productGroupOptionValueId: value.productGroupOptionValueId ?? null, timestamp: value.timestamp ?? null })).sort((a, b) => (a.productGroupOptionValueId ?? '').localeCompare(b.productGroupOptionValueId ?? '')),
    })).sort((a, b) => (a.productGroupOptionId ?? '').localeCompare(b.productGroupOptionId ?? '')),
    variants: (group.productVariants ?? []).map((variant) => ({ productVariantId: variant.productVariantId ?? null, productId: variant.productId ?? null, timestamp: variant.timestamp ?? null })).sort((a, b) => (a.productVariantId ?? '').localeCompare(b.productVariantId ?? '')),
  };
}

export function normalizeSelection(raw: ProductVariant['variantOption']) {
  if (Array.isArray(raw)) {
    return raw.map((row) => row as Record<string, unknown>).filter((row) => typeof row.productGroupOptionId === 'string' && typeof row.productGroupOptionValueId === 'string').map((row) => ({ productGroupOptionId: row.productGroupOptionId as string, productGroupOptionValueId: row.productGroupOptionValueId as string })).sort((a, b) => a.productGroupOptionId.localeCompare(b.productGroupOptionId));
  }
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([productGroupOptionId, value]) => ({ productGroupOptionId, productGroupOptionValueId: typeof value === 'string' ? value : String((value as Record<string, unknown>).productGroupOptionValueId ?? '') })).sort((a, b) => a.productGroupOptionId.localeCompare(b.productGroupOptionId));
  return [];
}

function requireUnique<T>(rows: T[], label: string): T | undefined {
  if (rows.length > 1) throw new Error(`AMBIGUOUS_GROUP_ROW: ${label}`);
  return rows[0];
}

export function buildDesiredGroup(args: {
  current: ProductGroup;
  mode: 'patch' | 'replace';
  options?: OptionInput[];
  variants?: VariantInput[];
  removeOptionIds?: string[];
  removeOptionValueIds?: string[];
  removeVariantIds?: string[];
  plannedOptionIds: string[];
  plannedValueIds: string[];
  plannedVariantIds: string[];
}): ProductGroup {
  if (args.mode === 'replace' && ((args.removeOptionIds?.length ?? 0) || (args.removeOptionValueIds?.length ?? 0) || (args.removeVariantIds?.length ?? 0))) throw new Error('GROUP_REMOVALS_ONLY_VALID_IN_PATCH');
  const currentOptions = (args.current.options ?? []).map((option) => ({ ...option, optionValues: (option.optionValues ?? []).map((value) => ({ ...value })) }));
  const currentVariants = (args.current.productVariants ?? []).map((variant) => ({ ...variant, product: undefined }));
  let optionIndex = 0;
  let valueIndex = 0;
  let variantIndex = 0;
  let options = args.mode === 'replace' && args.options !== undefined ? [] as ProductGroupOption[] : currentOptions;
  if (args.mode === 'patch') {
    for (const id of args.removeOptionIds ?? []) if (!currentOptions.some((row) => row.productGroupOptionId === id)) throw new Error(`UNKNOWN_OPTION_REMOVAL: ${id}`);
    const knownValues = currentOptions.flatMap((option) => option.optionValues ?? []);
    for (const id of args.removeOptionValueIds ?? []) if (!knownValues.some((row) => row.productGroupOptionValueId === id)) throw new Error(`UNKNOWN_OPTION_VALUE_REMOVAL: ${id}`);
    const removeOptions = new Set(args.removeOptionIds ?? []);
    const removeValues = new Set(args.removeOptionValueIds ?? []);
    options = options.filter((row) => !row.productGroupOptionId || !removeOptions.has(row.productGroupOptionId)).map((option) => ({ ...option, optionValues: (option.optionValues ?? []).filter((value) => !value.productGroupOptionValueId || !removeValues.has(value.productGroupOptionValueId)) }));
  }
  for (const input of args.options ?? []) {
    const existing = input.productGroupOptionId ? requireUnique(currentOptions.filter((row) => row.productGroupOptionId === input.productGroupOptionId), input.productGroupOptionId) : undefined;
    if (input.productGroupOptionId && !existing) throw new Error(`UNKNOWN_OPTION_ID: ${input.productGroupOptionId}`);
    const optionId = existing?.productGroupOptionId ?? args.plannedOptionIds[optionIndex++];
    if (!optionId) throw new Error('MISSING_PLANNED_OPTION_ID');
    const existingValues = existing?.optionValues ?? [];
    const values: ProductGroupOptionValue[] = input.optionValues === undefined ? existingValues : input.optionValues.map((value) => {
      const existingValue = value.productGroupOptionValueId ? requireUnique(existingValues.filter((row) => row.productGroupOptionValueId === value.productGroupOptionValueId), value.productGroupOptionValueId) : undefined;
      if (value.productGroupOptionValueId && !existingValue) throw new Error(`UNKNOWN_OPTION_VALUE_ID: ${value.productGroupOptionValueId}`);
      const valueId = existingValue?.productGroupOptionValueId ?? args.plannedValueIds[valueIndex++];
      if (!valueId) throw new Error('MISSING_PLANNED_OPTION_VALUE_ID');
      return { ...existingValue, productGroupOptionValueId: valueId, productGroupOptionId: optionId, name: value.name };
    });
    const next: ProductGroupOption = { ...existing, productGroupOptionId: optionId, productGroupId: args.current.productGroupId, name: input.name, lineNum: input.lineNum ?? existing?.lineNum, optionValues: values };
    const at = options.findIndex((row) => row.productGroupOptionId === optionId);
    if (at >= 0) options[at] = next; else options.push(next);
  }
  let variants = args.mode === 'replace' && args.variants !== undefined ? [] as ProductVariant[] : currentVariants;
  if (args.mode === 'patch') {
    for (const id of args.removeVariantIds ?? []) if (!currentVariants.some((row) => row.productVariantId === id)) throw new Error(`UNKNOWN_VARIANT_REMOVAL: ${id}`);
    const removals = new Set(args.removeVariantIds ?? []);
    variants = variants.filter((row) => !row.productVariantId || !removals.has(row.productVariantId));
  }
  for (const input of args.variants ?? []) {
    const existing = input.productVariantId ? requireUnique(currentVariants.filter((row) => row.productVariantId === input.productVariantId), input.productVariantId) : undefined;
    if (input.productVariantId && !existing) throw new Error(`UNKNOWN_VARIANT_ID: ${input.productVariantId}`);
    const variantId = existing?.productVariantId ?? args.plannedVariantIds[variantIndex++];
    if (!variantId) throw new Error('MISSING_PLANNED_VARIANT_ID');
    const next: ProductVariant = { ...existing, productVariantId: variantId, productGroupId: args.current.productGroupId, productId: input.productId, variantOption: Object.fromEntries(input.selection.map((row) => [row.productGroupOptionId, row.productGroupOptionValueId])) };
    const at = variants.findIndex((row) => row.productVariantId === variantId);
    if (at >= 0) variants[at] = next; else variants.push(next);
  }
  return { ...args.current, options, productVariants: variants };
}

export function validateGroupMatrix(group: ProductGroup): void {
  const options = group.options ?? [];
  const optionIds = options.map((option) => option.productGroupOptionId);
  if (optionIds.some((id) => !id) || new Set(optionIds).size !== optionIds.length) throw new Error('INVALID_GROUP_OPTION_IDS');
  const allValueIds = options.flatMap((option) => (option.optionValues ?? []).map((value) => value.productGroupOptionValueId));
  if (allValueIds.some((id) => !id) || new Set(allValueIds).size !== allValueIds.length) throw new Error('INVALID_GROUP_OPTION_VALUE_IDS');
  const ownership = new Map(options.map((option) => [option.productGroupOptionId!, new Set((option.optionValues ?? []).map((value) => value.productGroupOptionValueId!))]));
  const combinations = new Set<string>();
  const attachedProducts = new Set<string>();
  for (const variant of group.productVariants ?? []) {
    if (!variant.productId || !variant.productVariantId) throw new Error('INVALID_GROUP_VARIANT_IDS');
    if (attachedProducts.has(variant.productId)) throw new Error(`DUPLICATE_VARIANT_PRODUCT: ${variant.productId}`);
    attachedProducts.add(variant.productId);
    const selection = normalizeSelection(variant.variantOption);
    if (selection.length !== options.length) throw new Error(`INCOMPLETE_VARIANT_SELECTION: ${variant.productVariantId}`);
    if (new Set(selection.map((row) => row.productGroupOptionId)).size !== options.length) throw new Error(`DUPLICATE_VARIANT_OPTION: ${variant.productVariantId}`);
    for (const row of selection) if (!ownership.get(row.productGroupOptionId)?.has(row.productGroupOptionValueId)) throw new Error(`INVALID_VARIANT_SELECTION: ${variant.productVariantId}`);
    const key = selection.map((row) => `${row.productGroupOptionId}=${row.productGroupOptionValueId}`).join('|');
    if (combinations.has(key)) throw new Error(`DUPLICATE_VARIANT_COMBINATION: ${key}`);
    combinations.add(key);
  }
}

export function writableGroup(group: ProductGroup): ProductGroup {
  return {
    productGroupId: group.productGroupId,
    name: group.name,
    description: group.description,
    isActive: group.isActive,
    categoryId: group.categoryId,
    defaultProductId: group.defaultProductId,
    defaultImageId: group.defaultImageId,
    images: group.images,
    timestamp: group.timestamp,
    options: group.options,
    productVariants: (group.productVariants ?? []).map((variant) => ({ ...variant, product: undefined })),
  };
}
