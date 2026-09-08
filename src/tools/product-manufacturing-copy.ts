import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { canonicalHash } from '../core/canonical-json.js';
import { assertCapability } from '../core/capabilities.js';
import {
  executeMutation,
  explicitMutationConfirmationSchema,
  type MutationAdapter,
  type MutationControl,
} from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { textResult } from '../core/results.js';
import { assertMasterSafeWritesEnabled } from '../core/write-policy.js';
import type { Product } from '../types/inflow.js';
import {
  buildDesiredProduct,
  canonicalizeManufacturingConfig,
  fetchManufacturingProduct,
  normalizeManufacturingProduct,
  validateComponentsAndCycles,
  validateDesiredLocally,
  type ComponentInput,
  type OperationInput,
} from './product-manufacturing.js';

type Section = 'components' | 'operations' | 'settings';
interface CopyInput extends MutationControl {
  sourceProductId: string;
  targetProductId: string;
  sections?: Section[];
  mode?: 'patch' | 'replace';
  allowInactiveComponents?: boolean;
  expectedSourceConfigHash?: string;
  expectedTargetConfigHash?: string;
  expectedSourceWriteShapeHash?: string;
  expectedTargetWriteShapeHash?: string;
  expectedTargetTimestamp?: string;
}
interface CopyState { source: Product; target: Product }

function semantic(product: Product) {
  return canonicalizeManufacturingConfig(normalizeManufacturingProduct(product));
}

function writeShape(product: Product) {
  const envelope = normalizeManufacturingProduct(product);
  return {
    productId: product.productId,
    name: product.name,
    sku: product.sku ?? null,
    timestamp: product.timestamp ?? null,
    config: semantic(product),
    itemBoms: envelope.components.map((row) => ({ itemBomId: row.itemBomId ?? null, timestamp: row.timestamp ?? null, childProductId: row.childProductId })).sort((a, b) => a.childProductId.localeCompare(b.childProductId)),
    productOperations: envelope.productOperations.map((row) => ({ productOperationId: row.productOperationId ?? null, timestamp: row.timestamp ?? null, operationTypeId: row.operationTypeId, lineNum: row.lineNum })).sort((a, b) => (a.lineNum ?? Number.MAX_SAFE_INTEGER) - (b.lineNum ?? Number.MAX_SAFE_INTEGER) || a.operationTypeId.localeCompare(b.operationTypeId)),
  };
}

function hashSource(source: Product) {
  return {
    sourceSemanticHash: canonicalHash(semantic(source), 'semantic/manufacturing-copy-source/v1'),
    sourceWriteShapeHash: canonicalHash(writeShape(source), 'write-shape/manufacturing-copy-source/v1'),
  };
}

function componentInputs(source: Product): ComponentInput[] {
  return (source.itemBoms ?? []).map((row) => {
    if (!row.childProductId || row.quantity?.standardQuantity === undefined) throw new Error('SOURCE_BOM_INCOMPLETE');
    return {
      childProductId: row.childProductId,
      quantity: row.quantity.standardQuantity,
      uomQuantity: row.quantity.uomQuantity,
      uom: row.quantity.uom?.trim() || null,
    };
  });
}

function operationInputs(source: Product): OperationInput[] {
  return (source.productOperations ?? []).map((row) => {
    if (!row.operationTypeId) throw new Error('SOURCE_OPERATION_INCOMPLETE');
    return {
      operationTypeId: row.operationTypeId,
      lineNum: row.lineNum,
      cost: row.cost,
      estimatedPerHourCost: row.estimatedPerHourCost,
      estimatedSeconds: row.estimatedSeconds,
      instructions: row.instructions,
      trackTime: row.trackTime,
    };
  });
}

export function registerManufacturingCopyTool(server: McpServer, client: InflowClient, config: InflowConfig): void {
  server.tool('copy_product_manufacturing_config', 'Preview or copy selected manufacturing sections from one product to another without reusing source row IDs. Apply requires the exact full confirmation scope and hash returned by a fresh preview.', {
    sourceProductId: z.string().min(1),
    targetProductId: z.string().min(1),
    sections: z.array(z.enum(['components', 'operations', 'settings'])).min(1).optional(),
    mode: z.enum(['patch', 'replace']).default('replace'),
    allowInactiveComponents: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    previewToken: z.string().optional(),
    idempotencyKey: z.string().min(1).optional(),
    expectedSourceConfigHash: z.string().optional(),
    expectedTargetConfigHash: z.string().optional(),
    expectedSourceWriteShapeHash: z.string().optional(),
    expectedTargetWriteShapeHash: z.string().optional(),
    expectedTargetTimestamp: z.string().optional(),
    expectedDesiredHash: z.string().optional(),
    expectedSemanticHash: z.string().optional(),
    expectedWriteShapeHash: z.string().optional(),
    expectedEntityTimestamp: z.string().optional(),
    confirmation: explicitMutationConfirmationSchema.optional(),
  }, async (rawArgs) => {
    assertCapability('manufacturing.write', config.apiVersion);
    if (rawArgs.sourceProductId === rawArgs.targetProductId) throw new Error('COPY_SOURCE_EQUALS_TARGET');
    const args: CopyInput = {
      ...rawArgs,
      expectedSemanticHash: rawArgs.expectedSemanticHash ?? rawArgs.expectedTargetConfigHash,
      expectedWriteShapeHash: rawArgs.expectedWriteShapeHash ?? rawArgs.expectedTargetWriteShapeHash,
      expectedEntityTimestamp: rawArgs.expectedEntityTimestamp ?? rawArgs.expectedTargetTimestamp,
    };
    const adapter: MutationAdapter<CopyInput, CopyState, CopyState, ReturnType<typeof normalizeManufacturingProduct>> = {
      operation: 'copy_product_manufacturing_config',
      resourceType: 'product-manufacturing-config',
      resourceId: (input) => input.targetProductId,
      lockResourceIds: (input) => [input.sourceProductId, input.targetProductId],
      mode: (input) => `${input.mode ?? 'replace'}:${[...(input.sections ?? ['components', 'operations', 'settings'])].sort().join(',')}`,
      adapterVersion: 'manufacturing-copy/v1',
      read: async (input) => {
        const [source, target] = await Promise.all([fetchManufacturingProduct(client, input.sourceProductId), fetchManufacturingProduct(client, input.targetProductId)]);
        return { source, target };
      },
      planIds: (input, _operationId, current) => ({
        itemBomIds: Array.from({ length: input.sections?.includes('components') === false ? 0 : current?.source.itemBoms?.length ?? 0 }, () => randomUUID()),
        productOperationIds: Array.from({ length: input.sections?.includes('operations') === false ? 0 : current?.source.productOperations?.length ?? 0 }, () => randomUUID()),
      }),
      buildDesired: (input, current, plannedIds) => {
        const sections = new Set(input.sections ?? ['components', 'operations', 'settings']);
        const desiredTarget = buildDesiredProduct(current!.target, {
          productId: input.targetProductId,
          mode: input.mode ?? 'replace',
          ...(sections.has('components') ? { components: componentInputs(current!.source) } : {}),
          ...(sections.has('operations') ? { productOperations: operationInputs(current!.source) } : {}),
          ...(sections.has('settings') ? { autoAssemble: Boolean(current!.source.autoAssemble), includeQuantityBuildable: Boolean(current!.source.includeQuantityBuildable) } : {}),
        }, { itemBomIds: plannedIds.itemBomIds, productOperationIds: plannedIds.productOperationIds });
        return { source: current!.source, target: desiredTarget };
      },
      semantic: (state) => semantic(state.target),
      writeShape: (state) => state ? writeShape(state.target) : null,
      timestamp: (state) => state?.target.timestamp,
      sourceHashes: (_input, state) => state ? hashSource(state.source) : {},
      output: (state) => normalizeManufacturingProduct(state.target),
      validate: async (input, current, desired) => {
        const sourceHashes = hashSource(current!.source);
        if (!(input.dryRun ?? true)) {
          if (!input.expectedSourceConfigHash || !input.expectedSourceWriteShapeHash) throw new Error('MUTATION_PRECONDITION_REQUIRED: source hashes');
          if (input.expectedSourceConfigHash !== sourceHashes.sourceSemanticHash || input.expectedSourceWriteShapeHash !== sourceHashes.sourceWriteShapeHash) throw new Error('MUTATION_CONFLICT: source changed; re-run preview');
        }
        validateDesiredLocally(input.targetProductId, desired.target);
        await validateComponentsAndCycles(client, input.targetProductId, desired.target, input.allowInactiveComponents ?? false);
      },
      validateBeforeDispatch: async (input, current) => {
        const freshSource = await fetchManufacturingProduct(client, input.sourceProductId);
        if (
          canonicalHash(hashSource(freshSource), 'manufacturing-copy-source-recheck/v1') !==
          canonicalHash(hashSource(current!.source), 'manufacturing-copy-source-recheck/v1')
        ) {
          throw new Error('MUTATION_CONFLICT: source changed before dispatch; re-run preview');
        }
      },
      prepareDispatch: async (input, current, desired) => {
        const sections = new Set(input.sections ?? ['components', 'operations', 'settings']);
        const body: Partial<Product> = { productId: input.targetProductId, timestamp: current?.target.timestamp };
        if (sections.has('components')) body.itemBoms = desired.target.itemBoms;
        if (sections.has('operations')) body.productOperations = desired.target.productOperations;
        if (sections.has('settings')) {
          body.autoAssemble = desired.target.autoAssemble;
          body.includeQuantityBuildable = desired.target.includeQuantityBuildable;
        }
        const prepared = await client.prepareMutation<Product>('PUT', '/products', { body });
        return prepared.dispatch;
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: (input) => [{ type: 'product', id: input.targetProductId }, { type: 'product-manufacturing-config', id: input.targetProductId }],
      invalidationTags: (input) => [`product:${input.targetProductId}`, `bom:${input.targetProductId}`, `bom-compare:${input.targetProductId}`],
      writesEnabled: true,
      authorizeApply: () => assertMasterSafeWritesEnabled(config),
      requiresExplicitConfirmation: true,
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, args));
  });
}
