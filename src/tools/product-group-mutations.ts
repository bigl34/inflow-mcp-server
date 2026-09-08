import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InflowApiError, type InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { assertCapability } from '../core/capabilities.js';
import { stableStringify } from '../core/canonical-json.js';
import { executeMutation, type MutationAdapter, type MutationControl } from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { textResult } from '../core/results.js';
import { assertSafeWriteAuthorized, getSafeWritePolicy } from '../core/write-policy.js';
import {
  buildDesiredGroup,
  groupSemantic,
  groupWriteShape,
  normalizeSelection,
  validateGroupMatrix,
  writableGroup,
  type OptionInput,
  type VariantInput,
} from '../services/product-group-config.js';
import type { Product, ProductGroup } from '../types/inflow.js';

interface SetGroupInput extends MutationControl {
  productGroupId: string; mode: 'patch' | 'replace'; options?: OptionInput[]; variants?: VariantInput[];
  removeOptionIds?: string[]; removeOptionValueIds?: string[]; removeVariantIds?: string[];
}
interface CreateVariantInput extends MutationControl {
  productGroupId: string;
  variants: Array<{ name: string; sku: string; isActive?: boolean; selection: VariantInput['selection'] }>;
}

interface PlannedVariantProduct {
  productId: string;
  productVariantId: string;
  name: string;
  sku: string;
  isActive: boolean;
  selection: VariantInput['selection'];
  exists: boolean;
}

type VariantSagaState = ProductGroup & { plannedProducts: PlannedVariantProduct[] };

const selection = z.array(z.object({ productGroupOptionId: z.string().min(1), productGroupOptionValueId: z.string().min(1) })).min(1);
const controls = {
  dryRun: z.boolean().default(true), previewToken: z.string().optional(), idempotencyKey: z.string().min(1).optional(),
  expectedSemanticHash: z.string().optional(), expectedWriteShapeHash: z.string().optional(), expectedEntityTimestamp: z.string().optional(), expectedDesiredHash: z.string().optional(),
};

async function fetchGroup(client: InflowClient, id: string) {
  return client.get<ProductGroup>(`/product-groups/${id}`, { include: ['options.optionValues', 'productVariants.product'] });
}

function productReadback(
  expected: PlannedVariantProduct,
  actual: Product | undefined
): PlannedVariantProduct {
  return {
    ...expected,
    name: actual?.name ?? '',
    sku: actual?.sku ?? '',
    isActive: actual?.isActive ?? false,
    exists: actual?.productId === expected.productId,
  };
}

function sagaSemantic(value: VariantSagaState) {
  return {
    group: groupSemantic(value),
    plannedProducts: value.plannedProducts.map((row) => ({
      productId: row.productId,
      productVariantId: row.productVariantId,
      name: row.name,
      sku: row.sku,
      isActive: row.isActive,
      selection: row.selection,
      exists: row.exists,
    })),
  };
}

function groupReadbackShape(group: ProductGroup) {
  return {
    semantic: groupSemantic(group),
    options: (group.options ?? []).map((option) => ({
      productGroupOptionId: option.productGroupOptionId ?? null,
      optionValues: (option.optionValues ?? []).map((value) => value.productGroupOptionValueId ?? null).sort(),
    })).sort((left, right) => String(left.productGroupOptionId).localeCompare(String(right.productGroupOptionId))),
    variants: (group.productVariants ?? []).map((variant) => ({
      productVariantId: variant.productVariantId ?? null,
      productId: variant.productId ?? null,
      selection: normalizeSelection(variant.variantOption),
    })).sort((left, right) => String(left.productVariantId).localeCompare(String(right.productVariantId))),
  };
}

export function registerProductGroupMutationTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  server.tool('set_product_group_config', 'Preview exact-ID product-group option/value/variant changes. Apply stays blocked until group nested-write semantics are canary-proven.', {
    productGroupId: z.string().min(1), mode: z.enum(['patch', 'replace']),
    options: z.array(z.object({ productGroupOptionId: z.string().min(1).optional(), name: z.string().min(1), lineNum: z.number().int().optional(), optionValues: z.array(z.object({ productGroupOptionValueId: z.string().min(1).optional(), name: z.string().min(1) })).optional() })).optional(),
    variants: z.array(z.object({ productVariantId: z.string().min(1).optional(), productId: z.string().min(1), selection })).optional(),
    removeOptionIds: z.array(z.string().min(1)).optional(), removeOptionValueIds: z.array(z.string().min(1)).optional(), removeVariantIds: z.array(z.string().min(1)).optional(), ...controls,
  }, async (args) => {
    assertCapability('product-groups.write', config.apiVersion);
    const policy = getSafeWritePolicy('set_product_group_config');
    const adapter: MutationAdapter<SetGroupInput, ProductGroup, ProductGroup, ProductGroup> = {
      operation: 'set_product_group_config', resourceType: 'product-group', resourceId: (input) => input.productGroupId, mode: (input) => input.mode, adapterVersion: 'product-group/v1',
      read: (input) => fetchGroup(client, input.productGroupId),
      planIds: (input) => ({
        optionIds: (input.options ?? []).filter((row) => !row.productGroupOptionId).map(() => randomUUID()),
        valueIds: (input.options ?? []).flatMap((row) => row.optionValues ?? []).filter((row) => !row.productGroupOptionValueId).map(() => randomUUID()),
        variantIds: (input.variants ?? []).filter((row) => !row.productVariantId).map(() => randomUUID()),
      }),
      buildDesired: (input, current, ids) => buildDesiredGroup({ current: current!, mode: input.mode, options: input.options, variants: input.variants, removeOptionIds: input.removeOptionIds, removeOptionValueIds: input.removeOptionValueIds, removeVariantIds: input.removeVariantIds, plannedOptionIds: ids.optionIds ?? [], plannedValueIds: ids.valueIds ?? [], plannedVariantIds: ids.variantIds ?? [] }),
      semantic: groupSemantic, writeShape: (current) => current ? groupWriteShape(current) : null, timestamp: (current) => current?.timestamp, output: (value) => value,
      validate: (_input, _current, desired) => validateGroupMatrix(desired),
      prepareDispatch: async (_input, _current, desired) => { const prepared = await client.prepareMutation<ProductGroup>('PUT', '/product-groups', { body: writableGroup(desired) }); return prepared.dispatch; },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); }, affectedResources: (input) => [{ type: 'product-group', id: input.productGroupId }], invalidationTags: (input) => [`product-group:${input.productGroupId}`, `group-qty:${input.productGroupId}`],
      verifyReadback: (_input, _current, desired, actual) => actual !== undefined &&
        stableStringify(groupReadbackShape(actual)) === stableStringify(groupReadbackShape(desired)),
      writesEnabled: policy.staticSupport,
      authorizeApply: () => assertSafeWriteAuthorized(config, 'set_product_group_config'),
      requiresIdempotency: (input) => input.mode === 'patch',
      disabledCode: 'OPERATION_UNSUPPORTED', disabledMessage: 'Product-group apply stays unavailable until its release canary passes for this build.',
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, args as SetGroupInput));
  });

  server.tool('create_product_group_variants', 'Preview deterministic product/variant IDs for a compensated create-and-attach saga. Apply stays blocked until its canary.', {
    productGroupId: z.string().min(1), variants: z.array(z.object({ name: z.string().min(1), sku: z.string().min(1), isActive: z.boolean().default(false), selection })).min(1).max(100), ...controls,
  }, async (args) => {
    assertCapability('product-groups.write', config.apiVersion);
    const policy = getSafeWritePolicy('create_product_group_variants');
    let expectedProducts: PlannedVariantProduct[] = [];
    const adapter: MutationAdapter<CreateVariantInput, VariantSagaState, VariantSagaState, VariantSagaState> = {
      operation: 'create_product_group_variants', resourceType: 'product-group-variant-saga', resourceId: (input) => input.productGroupId, mode: () => 'create-attach', adapterVersion: 'product-group-variant-saga/v1', isSaga: true,
      read: async (input) => {
        const group = await fetchGroup(client, input.productGroupId);
        const plannedProducts = await Promise.all(expectedProducts.map(async (expected) => {
          try {
            const actual = await client.get<Product>(`/products/${expected.productId}`);
            return productReadback(expected, actual);
          } catch {
            return { ...expected, exists: false };
          }
        }));
        return { ...group, plannedProducts };
      },
      planIds: (input) => ({ productIds: input.variants.map(() => randomUUID()), variantIds: input.variants.map(() => randomUUID()) }),
      buildDesired: (input, current, ids) => {
        const plannedProducts: PlannedVariantProduct[] = input.variants.map((row, index) => ({ productId: ids.productIds![index]!, productVariantId: ids.variantIds![index]!, name: row.name, sku: row.sku, isActive: row.isActive ?? false, selection: row.selection, exists: true }));
        expectedProducts = plannedProducts;
        const group = buildDesiredGroup({ current: current!, mode: 'patch', variants: plannedProducts.map((row) => ({ productId: row.productId, selection: row.selection })), plannedOptionIds: [], plannedValueIds: [], plannedVariantIds: ids.variantIds ?? [] });
        return { ...group, plannedProducts };
      },
      semantic: sagaSemantic,
      writeShape: (current) => current ? groupWriteShape(current) : null, timestamp: (current) => current?.timestamp, output: (value) => value,
      validate: (input, current, desired) => {
        const requestedSkus = input.variants.map((row) => row.sku.trim());
        if (requestedSkus.some((sku) => !sku) || new Set(requestedSkus).size !== requestedSkus.length) throw new Error('DUPLICATE_OR_BLANK_VARIANT_SKU');
        const attachedSkus = new Set((current?.productVariants ?? []).map((row) => row.product?.sku).filter((sku): sku is string => Boolean(sku)));
        const conflict = requestedSkus.find((sku) => attachedSkus.has(sku));
        if (conflict) throw new Error(`DUPLICATE_VARIANT_SKU: ${conflict}`);
        validateGroupMatrix(desired);
      },
      prepareDispatch: async (_input, _current, desired) => {
        for (const row of desired.plannedProducts) {
          try {
            await client.get<Product>(`/products/${row.productId}`);
            throw new Error(`PLANNED_PRODUCT_ID_ALREADY_EXISTS: ${row.productId}`);
          } catch (error) {
            if (error instanceof InflowApiError && error.statusCode === 404) continue;
            throw error;
          }
        }
        const productWrites = await Promise.all(desired.plannedProducts.map((row) => client.prepareMutation<Product>('PUT', '/products', { body: {
          productId: row.productId,
          name: row.name,
          sku: row.sku,
          isActive: row.isActive,
        } })));
        const groupWrite = await client.prepareMutation<ProductGroup>('PUT', '/product-groups', { body: writableGroup(desired) });
        return async () => {
          const attempted: PlannedVariantProduct[] = [];
          let groupAttempted = false;
          try {
            for (let index = 0; index < productWrites.length; index += 1) {
              attempted.push(desired.plannedProducts[index]!);
              await productWrites[index]!.dispatch();
            }
            groupAttempted = true;
            await groupWrite.dispatch();
          } catch (error) {
            if (groupAttempted) {
              let actualGroup: ProductGroup;
              try {
                actualGroup = await fetchGroup(client, desired.productGroupId!);
              } catch {
                // An unreadable outcome is not proof that the products are
                // orphaned. Preserve it for journal reconciliation.
                throw error;
              }
              const plannedIds = new Set(desired.plannedProducts.map((row) => row.productId));
              const attachedPlannedProduct = (actualGroup.productVariants ?? [])
                .some((variant) => variant.productId && plannedIds.has(variant.productId));
              // A failed response can still mean the full group PUT applied.
              // Do not deactivate anything that may now be attached; the
              // shared executor will read back and reconcile the outcome.
              if (attachedPlannedProduct) throw error;
            }
            const compensationErrors: string[] = [];
            for (const planned of attempted.reverse()) {
              try {
                const current = await client.get<Product>(`/products/${planned.productId}`);
                if (current.productId !== planned.productId || current.sku !== planned.sku) {
                  compensationErrors.push(`${planned.productId}: identity mismatch`);
                  continue;
                }
                const compensation = await client.prepareMutation<Product>('PUT', '/products', { body: {
                  productId: planned.productId,
                  timestamp: current.timestamp,
                  isActive: false,
                } });
                await compensation.dispatch();
              } catch (compensationError) {
                compensationErrors.push(`${planned.productId}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
              }
            }
            if (compensationErrors.length > 0) {
              throw new Error(`PRODUCT_GROUP_SAGA_COMPENSATION_FAILED: ${compensationErrors.join('; ')}`);
            }
            throw error;
          }
        };
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: (input) => [{ type: 'product-group', id: input.productGroupId }, { type: 'products' }], invalidationTags: (input) => [`product-group:${input.productGroupId}`, `group-qty:${input.productGroupId}`, 'products:list'],
      verifyReadback: (_input, _current, desired, actual) => actual !== undefined &&
        stableStringify(groupReadbackShape(actual)) === stableStringify(groupReadbackShape(desired)) &&
        stableStringify(actual.plannedProducts) === stableStringify(desired.plannedProducts),
      writesEnabled: policy.staticSupport,
      authorizeApply: () => assertSafeWriteAuthorized(config, 'create_product_group_variants'),
      requiresIdempotency: true,
      disabledCode: 'OPERATION_UNSUPPORTED', disabledMessage: 'The create/attach/compensate saga stays unavailable until its release canary passes for this build.',
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, args as CreateVariantInput));
  });
}
