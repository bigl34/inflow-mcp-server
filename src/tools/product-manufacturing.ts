import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type {
  ItemBom,
  Product,
  ProductOperation,
  QuantityWithUom,
} from '../types/inflow.js';
import {
  ZERO_DECIMAL,
  compareDecimal,
  normalizeDecimal as normalizeExactDecimal,
  parseDecimal,
} from '../core/decimal.js';
import {
  executeMutation,
  explicitMutationConfirmationSchema,
  type MutationAdapter,
  type MutationControl,
} from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { assertMasterSafeWritesEnabled } from '../core/write-policy.js';

export const MANUFACTURING_API_VERSION = '2026-04-13';
export const MANUFACTURING_INCLUDE = [
  'itemBoms',
  'productOperations.operationType',
  'productVariant',
];

type DecimalInput = string | number;

export interface ComponentInput {
  itemBomId?: string;
  childProductId: string;
  quantity: DecimalInput;
  uomQuantity?: DecimalInput;
  uom?: string | null;
}

export interface OperationInput {
  productOperationId?: string;
  operationTypeId: string;
  lineNum?: number;
  cost?: DecimalInput | null;
  estimatedPerHourCost?: DecimalInput | null;
  estimatedSeconds?: DecimalInput | null;
  instructions?: string;
  trackTime?: boolean;
}

export interface ManufacturingConfigInput {
  productId: string;
  mode: 'patch' | 'replace';
  components?: ComponentInput[];
  removeItemBomIds?: string[];
  productOperations?: OperationInput[];
  removeProductOperationIds?: string[];
  autoAssemble?: boolean;
  includeQuantityBuildable?: boolean;
  allowInactiveComponents?: boolean;
}

interface SafeManufacturingConfigInput extends ManufacturingConfigInput, MutationControl {}

interface NormalizedComponent {
  itemBomId?: string;
  timestamp?: string;
  childProductId: string;
  childProductName?: string;
  childProductSku?: string;
  childProductIsActive?: boolean;
  quantity: string;
  uomQuantity: string;
  uom: string | null;
}

interface NormalizedOperation {
  productOperationId?: string;
  timestamp?: string;
  operationTypeId: string;
  operationTypeName?: string;
  lineNum: number | null;
  cost: string | null;
  estimatedPerHourCost: string | null;
  estimatedSeconds: string | null;
  instructions: string | null;
  trackTime: boolean;
}

export interface ManufacturingEnvelope {
  productId: string;
  productName?: string;
  productSku?: string;
  productTimestamp?: string;
  isManufacturable: boolean;
  componentCount: number;
  components: NormalizedComponent[];
  itemBoms: ItemBom[];
  productOperations: NormalizedOperation[];
  settings: {
    autoAssemble: boolean;
    includeQuantityBuildable: boolean;
  };
  productVariant?: Product['productVariant'];
  warnings: string[];
}

interface CanonicalConfig {
  components: Array<{
    childProductId: string;
    quantity: string;
    uomQuantity: string;
    uom: string | null;
  }>;
  productOperations: Array<{
    operationTypeId: string;
    lineNum: number | null;
    cost: string | null;
    estimatedPerHourCost: string | null;
    estimatedSeconds: string | null;
    instructions: string | null;
    trackTime: boolean;
  }>;
  autoAssemble: boolean;
  includeQuantityBuildable: boolean;
}

function asNullableString(value: unknown): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : String(value);
}

export function normalizeDecimal(value: DecimalInput): string {
  return normalizeExactDecimal(value);
}

function normalizeNullableDecimal(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizeDecimal(value as DecimalInput);
}

function standardQuantity(quantity: QuantityWithUom | undefined): string {
  return normalizeDecimal(quantity?.standardQuantity ?? '1');
}

export function assertManufacturingApiVersion(apiVersion: string): void {
  if (apiVersion < MANUFACTURING_API_VERSION) {
    throw new Error(
      `UNSUPPORTED_API_VERSION: manufacturing and product-group tools require ${MANUFACTURING_API_VERSION}; configured ${apiVersion}`
    );
  }
}

export async function fetchManufacturingProduct(
  client: InflowClient,
  productId: string
): Promise<Product> {
  const product = await client.get<Product>(`/products/${productId}`, {
    include: MANUFACTURING_INCLUDE,
  });
  return enrichBomChildren(client, product);
}

async function fetchLegacyBomProduct(
  client: InflowClient,
  productId: string
): Promise<Product> {
  const product = await client.get<Product>(`/products/${productId}`, {
    include: ['itemBoms'],
  });
  return enrichBomChildren(client, product);
}

async function enrichBomChildren(
  client: InflowClient,
  product: Product
): Promise<Product> {
  const childIds = Array.from(
    new Set(
      (product.itemBoms ?? [])
        .filter((row) => !row.childProduct && row.childProductId)
        .map((row) => row.childProductId!)
    )
  );
  if (childIds.length === 0) return product;

  // The 2026-04-13 API rejects include=itemBoms.childProduct and productId
  // array filters do not return the requested rows. Resolve children with a
  // bounded concurrency of four and preserve partial results on failures.
  const children = new Map<string, Product>();
  for (let index = 0; index < childIds.length; index += 4) {
    const ids = childIds.slice(index, index + 4);
    const results = await Promise.all(
      ids.map((id) =>
        client.get<Product>(`/products/${id}`).catch(() => undefined)
      )
    );
    for (const child of results) {
      if (child?.productId) children.set(child.productId, child);
    }
  }

  return {
    ...product,
    itemBoms: (product.itemBoms ?? []).map((row) => ({
      ...row,
      childProduct:
        row.childProduct ??
        (row.childProductId ? children.get(row.childProductId) : undefined),
    })),
  };
}

export function normalizeManufacturingProduct(product: Product): ManufacturingEnvelope {
  const warnings: string[] = [];
  const itemBoms = product.itemBoms ?? [];
  const components = itemBoms.map((bom): NormalizedComponent => {
    if (!bom.childProduct) {
      warnings.push(
        `Component ${bom.childProductId ?? bom.itemBomId ?? 'unknown'} was returned without child product enrichment`
      );
    }
    return {
      itemBomId: bom.itemBomId,
      timestamp: bom.timestamp,
      childProductId: bom.childProductId ?? '',
      childProductName: bom.childProduct?.name,
      childProductSku: bom.childProduct?.sku,
      childProductIsActive: bom.childProduct?.isActive,
      quantity: standardQuantity(bom.quantity),
      uomQuantity: normalizeDecimal(
        bom.quantity?.uomQuantity ?? bom.quantity?.standardQuantity ?? '1'
      ),
      uom: asNullableString(bom.quantity?.uom),
    };
  });

  const productOperations = (product.productOperations ?? [])
    .map((operation): NormalizedOperation => ({
      productOperationId: operation.productOperationId,
      timestamp: operation.timestamp,
      operationTypeId: operation.operationTypeId ?? '',
      operationTypeName: operation.operationType?.name,
      lineNum: operation.lineNum ?? null,
      cost: normalizeNullableDecimal(operation.cost),
      estimatedPerHourCost: normalizeNullableDecimal(operation.estimatedPerHourCost),
      estimatedSeconds: normalizeNullableDecimal(operation.estimatedSeconds),
      instructions: asNullableString(operation.instructions),
      trackTime: Boolean(operation.trackTime),
    }))
    .sort((a, b) =>
      (a.lineNum ?? Number.MAX_SAFE_INTEGER) -
        (b.lineNum ?? Number.MAX_SAFE_INTEGER) ||
      a.operationTypeId.localeCompare(b.operationTypeId)
    );

  return {
    productId: product.productId ?? '',
    productName: product.name,
    productSku: product.sku,
    productTimestamp: product.timestamp,
    isManufacturable: Boolean(product.isManufacturable),
    componentCount: components.length,
    components,
    itemBoms,
    productOperations,
    settings: {
      autoAssemble: Boolean(product.autoAssemble),
      includeQuantityBuildable: Boolean(product.includeQuantityBuildable),
    },
    productVariant: product.productVariant,
    warnings,
  };
}

export function canonicalizeManufacturingConfig(
  envelope: ManufacturingEnvelope
): CanonicalConfig {
  return {
    components: envelope.components
      .map((component) => ({
        childProductId: component.childProductId,
        quantity: normalizeDecimal(component.quantity),
        uomQuantity: normalizeDecimal(component.uomQuantity),
        uom: asNullableString(component.uom),
      }))
      .sort((a, b) => a.childProductId.localeCompare(b.childProductId)),
    productOperations: envelope.productOperations
      .map((operation) => ({
        operationTypeId: operation.operationTypeId,
        lineNum: operation.lineNum,
        cost: normalizeNullableDecimal(operation.cost),
        estimatedPerHourCost: normalizeNullableDecimal(
          operation.estimatedPerHourCost
        ),
        estimatedSeconds: normalizeNullableDecimal(operation.estimatedSeconds),
        instructions: asNullableString(operation.instructions),
        trackTime: operation.trackTime,
      }))
      .sort((a, b) =>
        (a.lineNum ?? Number.MAX_SAFE_INTEGER) -
          (b.lineNum ?? Number.MAX_SAFE_INTEGER) ||
        a.operationTypeId.localeCompare(b.operationTypeId)
      ),
    autoAssemble: envelope.settings.autoAssemble,
    includeQuantityBuildable: envelope.settings.includeQuantityBuildable,
  };
}

export function manufacturingConfigHash(envelope: ManufacturingEnvelope): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeManufacturingConfig(envelope)))
    .digest('hex');
}

function toWritableBom(bom: ItemBom): ItemBom {
  return {
    itemBomId: bom.itemBomId,
    productId: bom.productId,
    childProductId: bom.childProductId,
    quantity: bom.quantity ? { ...bom.quantity } : undefined,
    timestamp: bom.timestamp,
  };
}

function toWritableOperation(operation: ProductOperation): ProductOperation {
  return {
    productOperationId: operation.productOperationId,
    productId: operation.productId,
    operationTypeId: operation.operationTypeId,
    lineNum: operation.lineNum,
    cost: operation.cost,
    estimatedPerHourCost: operation.estimatedPerHourCost,
    estimatedSeconds: operation.estimatedSeconds,
    instructions: operation.instructions,
    trackTime: operation.trackTime,
    timestamp: operation.timestamp,
  };
}

function componentToBom(
  productId: string,
  input: ComponentInput,
  existing?: ItemBom,
  plannedId?: string
): ItemBom {
  const hasUom = Object.prototype.hasOwnProperty.call(input, 'uom');
  const hasUomQuantity = Object.prototype.hasOwnProperty.call(
    input,
    'uomQuantity'
  );
  const existingQuantity = existing?.quantity;
  const standard = normalizeDecimal(input.quantity);
  const existingStandard = normalizeDecimal(
    existingQuantity?.standardQuantity ?? standard
  );
  const existingUomQuantity = normalizeDecimal(
    existingQuantity?.uomQuantity ?? existingStandard
  );
  const existingUom = asNullableString(existingQuantity?.uom);
  const effectiveUom = hasUom
    ? asNullableString(input.uom)
    : existingUom;
  if (
    effectiveUom !== null &&
    (!existing || effectiveUom !== existingUom) &&
    !hasUomQuantity
  ) {
    throw new Error(
      'uomQuantity is required when adding or changing a component UOM'
    );
  }
  if (
    existing &&
    standard !== existingStandard &&
    effectiveUom !== null &&
    existingUomQuantity !== existingStandard &&
    !hasUomQuantity
  ) {
    throw new Error(
      `uomQuantity is required when changing quantity for UOM-backed itemBomId ${existing.itemBomId ?? input.itemBomId ?? 'unknown'}`
    );
  }
  const uomQuantity = hasUomQuantity
    ? normalizeDecimal(input.uomQuantity!)
    : hasUom && effectiveUom === null
      ? standard
    : existing && standard === existingStandard
      ? existingUomQuantity
      : standard;
  return {
    itemBomId: existing?.itemBomId ?? input.itemBomId ?? plannedId ?? randomUUID(),
    productId,
    childProductId: input.childProductId,
    quantity: {
      ...existingQuantity,
      standardQuantity: standard,
      uomQuantity,
      ...(hasUom
        ? { uom: input.uom === null ? '' : String(input.uom ?? '') }
        : {}),
    },
    timestamp: existing?.timestamp,
  };
}

function operationFromInput(
  productId: string,
  input: OperationInput,
  existing?: ProductOperation,
  plannedId?: string
): ProductOperation {
  const has = (key: keyof OperationInput) =>
    Object.prototype.hasOwnProperty.call(input, key);
  return {
    productOperationId:
      existing?.productOperationId ?? input.productOperationId ?? plannedId ?? randomUUID(),
    productId,
    operationTypeId: input.operationTypeId,
    lineNum: has('lineNum') ? input.lineNum : existing?.lineNum ?? 0,
    cost: has('cost')
      ? normalizeNullableDecimal(input.cost)
      : existing?.cost,
    estimatedPerHourCost: has('estimatedPerHourCost')
      ? normalizeNullableDecimal(input.estimatedPerHourCost)
      : existing?.estimatedPerHourCost,
    estimatedSeconds: has('estimatedSeconds')
      ? normalizeNullableDecimal(input.estimatedSeconds)
      : existing?.estimatedSeconds,
    instructions: has('instructions')
      ? input.instructions
      : existing?.instructions ?? '',
    trackTime: has('trackTime')
      ? input.trackTime
      : existing?.trackTime ?? false,
    timestamp: existing?.timestamp,
  };
}

function uniqueMatch<T>(rows: T[], description: string): T | undefined {
  if (rows.length > 1) throw new Error(`Ambiguous ${description}`);
  return rows[0];
}

export function buildDesiredProduct(
  current: Product,
  input: ManufacturingConfigInput,
  plannedIds: { itemBomIds?: string[]; productOperationIds?: string[] } = {}
): Product {
  const productId = current.productId ?? input.productId;
  if (input.mode === 'replace' &&
      ((input.removeItemBomIds?.length ?? 0) > 0 ||
        (input.removeProductOperationIds?.length ?? 0) > 0)) {
    throw new Error('Removal ID arrays are only valid in patch mode');
  }

  const existingBoms = (current.itemBoms ?? []).map(toWritableBom);
  const existingOperations = (current.productOperations ?? []).map(
    toWritableOperation
  );

  let itemBoms = existingBoms;
  if (input.mode === 'replace' && input.components !== undefined) {
    itemBoms = input.components.map((component, componentIndex) => {
      const match = component.itemBomId
        ? uniqueMatch(
            existingBoms.filter((row) => row.itemBomId === component.itemBomId),
            `itemBomId ${component.itemBomId}`
          )
        : uniqueMatch(
            existingBoms.filter(
              (row) => row.childProductId === component.childProductId
            ),
            `component ${component.childProductId}`
          );
      if (component.itemBomId && !match) {
        throw new Error(`Unknown itemBomId: ${component.itemBomId}`);
      }
      return componentToBom(productId, component, match, plannedIds.itemBomIds?.[componentIndex]);
    });
  } else if (input.mode === 'patch') {
    const removals = new Set(input.removeItemBomIds ?? []);
    for (const id of removals) {
      if (!existingBoms.some((row) => row.itemBomId === id)) {
        throw new Error(`Unknown itemBomId removal: ${id}`);
      }
    }
    itemBoms = existingBoms.filter((row) => !row.itemBomId || !removals.has(row.itemBomId));
    for (const [componentIndex, component] of (input.components ?? []).entries()) {
      const match = component.itemBomId
        ? uniqueMatch(
            itemBoms.filter((row) => row.itemBomId === component.itemBomId),
            `itemBomId ${component.itemBomId}`
          )
        : uniqueMatch(
            itemBoms.filter((row) => row.childProductId === component.childProductId),
            `component ${component.childProductId}`
          );
      if (component.itemBomId && !match) {
        throw new Error(`Unknown itemBomId: ${component.itemBomId}`);
      }
      const next = componentToBom(productId, component, match, plannedIds.itemBomIds?.[componentIndex]);
      if (match) itemBoms[itemBoms.indexOf(match)] = next;
      else itemBoms.push(next);
    }
  }

  let productOperations = existingOperations;
  if (input.mode === 'replace' && input.productOperations !== undefined) {
    productOperations = input.productOperations.map((operation, operationIndex) => {
      const match = operation.productOperationId
        ? uniqueMatch(
            existingOperations.filter(
              (row) => row.productOperationId === operation.productOperationId
            ),
            `productOperationId ${operation.productOperationId}`
          )
        : uniqueMatch(
            existingOperations.filter(
              (row) =>
                row.operationTypeId === operation.operationTypeId &&
                (row.lineNum ?? null) === (operation.lineNum ?? null)
            ),
            `operation ${operation.operationTypeId}/${operation.lineNum ?? 'null'}`
          );
      if (operation.productOperationId && !match) {
        throw new Error(
          `Unknown productOperationId: ${operation.productOperationId}`
        );
      }
      return operationFromInput(productId, operation, match, plannedIds.productOperationIds?.[operationIndex]);
    });
  } else if (input.mode === 'patch') {
    const removals = new Set(input.removeProductOperationIds ?? []);
    for (const id of removals) {
      if (!existingOperations.some((row) => row.productOperationId === id)) {
        throw new Error(`Unknown productOperationId removal: ${id}`);
      }
    }
    productOperations = existingOperations.filter(
      (row) => !row.productOperationId || !removals.has(row.productOperationId)
    );
    for (const [operationIndex, operation] of (input.productOperations ?? []).entries()) {
      const match = operation.productOperationId
        ? uniqueMatch(
            productOperations.filter(
              (row) => row.productOperationId === operation.productOperationId
            ),
            `productOperationId ${operation.productOperationId}`
          )
        : uniqueMatch(
            productOperations.filter(
              (row) =>
                row.operationTypeId === operation.operationTypeId &&
                (row.lineNum ?? null) === (operation.lineNum ?? null)
            ),
            `operation ${operation.operationTypeId}/${operation.lineNum ?? 'null'}`
          );
      if (operation.productOperationId && !match) {
        throw new Error(
          `Unknown productOperationId: ${operation.productOperationId}`
        );
      }
      const next = operationFromInput(productId, operation, match, plannedIds.productOperationIds?.[operationIndex]);
      if (match) productOperations[productOperations.indexOf(match)] = next;
      else productOperations.push(next);
    }
  }

  return {
    ...current,
    productId,
    itemBoms,
    productOperations,
    autoAssemble: input.autoAssemble ?? current.autoAssemble,
    includeQuantityBuildable:
      input.includeQuantityBuildable ?? current.includeQuantityBuildable,
  };
}

export function validateDesiredLocally(productId: string, desired: Product): void {
  const componentIds = (desired.itemBoms ?? []).map((row) => row.childProductId ?? '');
  if (componentIds.some((id) => !id)) throw new Error('Every component requires a childProductId');
  if (componentIds.includes(productId)) throw new Error('A product cannot include itself in its BOM');
  if (new Set(componentIds).size !== componentIds.length) {
    throw new Error('Duplicate child products are not allowed in a BOM');
  }
  for (const row of desired.itemBoms ?? []) {
    const quantity = normalizeDecimal(row.quantity?.standardQuantity ?? '0');
    const uomQuantity = normalizeDecimal(
      row.quantity?.uomQuantity ?? quantity
    );
    if (compareDecimal(parseDecimal(quantity), ZERO_DECIMAL) <= 0 || compareDecimal(parseDecimal(uomQuantity), ZERO_DECIMAL) <= 0) {
      throw new Error(
        'Component standard and UOM quantities must be positive finite values'
      );
    }
    if (
      asNullableString(row.quantity?.uom) === null &&
      uomQuantity !== quantity
    ) {
      throw new Error(
        'A component without a UOM must use the standard quantity as its UOM quantity'
      );
    }
  }

  const operationKeys = (desired.productOperations ?? []).map(
    (operation) => `${operation.operationTypeId ?? ''}:${operation.lineNum ?? 'null'}`
  );
  if (operationKeys.some((key) => key.startsWith(':'))) {
    throw new Error('Every product operation requires an operationTypeId');
  }
  if (new Set(operationKeys).size !== operationKeys.length) {
    throw new Error('Duplicate operationTypeId/lineNum combinations are not allowed');
  }
  if (
    (desired.itemBoms?.length ?? 0) === 0 &&
    ((desired.productOperations?.length ?? 0) > 0 ||
      desired.autoAssemble ||
      desired.includeQuantityBuildable)
  ) {
    throw new Error('Operations and manufacturing flags require a non-empty BOM');
  }
}

export async function validateComponentsAndCycles(
  client: InflowClient,
  productId: string,
  desired: Product,
  allowInactive: boolean
): Promise<void> {
  const childIds = (desired.itemBoms ?? []).map((row) => row.childProductId!);
  const loaded = new Map<string, Product>();

  async function load(id: string): Promise<Product> {
    const cached = loaded.get(id);
    if (cached) return cached;
    const product = await client.get<Product>(`/products/${id}`, {
      include: ['itemBoms'],
    });
    loaded.set(id, product);
    return product;
  }

  for (const childId of childIds) {
    const child = await load(childId);
    if (!allowInactive && child.isActive === false) {
      throw new Error(`Inactive component is not allowed: ${childId}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  async function reachesTarget(id: string): Promise<boolean> {
    if (id === productId) return true;
    if (visited.has(id)) return false;
    if (visiting.has(id)) return false;
    if (loaded.size > 250) throw new Error('BOM cycle validation exceeded 250 products');
    visiting.add(id);
    const product = await load(id);
    for (const row of product.itemBoms ?? []) {
      if (row.childProductId && (await reachesTarget(row.childProductId))) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const childId of childIds) {
    if (await reachesTarget(childId)) {
      throw new Error(`Indirect BOM cycle detected through component ${childId}`);
    }
  }
}

function manufacturingWriteShape(product: Product) {
  const envelope = normalizeManufacturingProduct(product);
  return {
    productId: product.productId ?? null,
    name: product.name,
    sku: product.sku ?? null,
    timestamp: product.timestamp ?? null,
    config: canonicalizeManufacturingConfig(envelope),
    itemBoms: envelope.components.map((row) => ({ itemBomId: row.itemBomId ?? null, timestamp: row.timestamp ?? null, childProductId: row.childProductId })).sort((a, b) => a.childProductId.localeCompare(b.childProductId)),
    productOperations: envelope.productOperations.map((row) => ({ productOperationId: row.productOperationId ?? null, timestamp: row.timestamp ?? null, operationTypeId: row.operationTypeId, lineNum: row.lineNum })).sort((a, b) => (a.lineNum ?? Number.MAX_SAFE_INTEGER) - (b.lineNum ?? Number.MAX_SAFE_INTEGER) || a.operationTypeId.localeCompare(b.operationTypeId)),
  };
}

async function setProductManufacturingConfigSafe(
  client: InflowClient,
  config: InflowConfig,
  input: SafeManufacturingConfigInput
) {
  const adapter: MutationAdapter<SafeManufacturingConfigInput, Product, Product, ManufacturingEnvelope> = {
    operation: 'set_product_manufacturing_config',
    resourceType: 'product-manufacturing-config',
    resourceId: (args) => args.productId,
    mode: (args) => args.mode,
    adapterVersion: 'product-manufacturing/v2',
    read: (args) => fetchManufacturingProduct(client, args.productId),
    planIds: (args) => ({
      itemBomIds: (args.components ?? []).map(() => randomUUID()),
      productOperationIds: (args.productOperations ?? []).map(() => randomUUID()),
    }),
    buildDesired: (args, current, ids) => buildDesiredProduct(current!, args, { itemBomIds: ids.itemBomIds, productOperationIds: ids.productOperationIds }),
    semantic: (value) => canonicalizeManufacturingConfig(normalizeManufacturingProduct(value)),
    writeShape: (current) => current ? manufacturingWriteShape(current) : null,
    timestamp: (current) => current?.timestamp,
    output: normalizeManufacturingProduct,
    validate: async (args, _current, desired) => {
      validateDesiredLocally(args.productId, desired);
      await validateComponentsAndCycles(client, args.productId, desired, args.allowInactiveComponents ?? false);
    },
    prepareDispatch: async (args, current, desired) => {
      const body: Partial<Product> = { productId: args.productId, timestamp: current?.timestamp };
      if (args.components !== undefined || (args.removeItemBomIds?.length ?? 0) > 0) body.itemBoms = desired.itemBoms;
      if (args.productOperations !== undefined || (args.removeProductOperationIds?.length ?? 0) > 0) body.productOperations = desired.productOperations;
      if (args.autoAssemble !== undefined) body.autoAssemble = desired.autoAssemble;
      if (args.includeQuantityBuildable !== undefined) body.includeQuantityBuildable = desired.includeQuantityBuildable;
      const prepared = await client.prepareMutation<Product>('PUT', '/products', { body });
      return prepared.dispatch;
    },
    dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
    affectedResources: (args) => [{ type: 'product', id: args.productId }, { type: 'product-manufacturing-config', id: args.productId }],
    invalidationTags: (args) => [`product:${args.productId}`, `bom:${args.productId}`, `bom-compare:${args.productId}`],
    writesEnabled: true,
    authorizeApply: () => assertMasterSafeWritesEnabled(config),
    requiresExplicitConfirmation: true,
  };
  return executeMutation(createMutationRuntime(config), adapter, input);
}

const decimalSchema = z.union([
  z.string().min(1),
  z.number().finite(),
]);

const componentSchema = z.object({
  itemBomId: z.string().optional(),
  childProductId: z.string().min(1),
  quantity: decimalSchema,
  uomQuantity: decimalSchema.optional(),
  uom: z.string().nullable().optional(),
});

const operationSchema = z.object({
  productOperationId: z.string().optional(),
  operationTypeId: z.string().min(1),
  lineNum: z.number().int().optional(),
  cost: decimalSchema.nullable().optional(),
  estimatedPerHourCost: decimalSchema.nullable().optional(),
  estimatedSeconds: decimalSchema.nullable().optional(),
  instructions: z.string().optional(),
  trackTime: z.boolean().optional(),
});

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerProductManufacturingTools(
  server: McpServer,
  client: InflowClient,
  config: InflowConfig
): void {
  const apiVersion = config.apiVersion;
  server.tool(
    'get_bill_of_materials',
    'Get a stable, enriched product manufacturing configuration including BOM rows, components, operations, settings, and concurrency metadata.',
    { productId: z.string().min(1) },
    async ({ productId }) => {
      return textResult(
        normalizeManufacturingProduct(
          apiVersion < MANUFACTURING_API_VERSION
            ? await fetchLegacyBomProduct(client, productId)
            : await fetchManufacturingProduct(client, productId)
        )
      );
    }
  );

  server.tool(
    'compare_product_boms',
    'Compare manufacturing components, operations, and settings for 2-25 products.',
    { productIds: z.array(z.string().min(1)).min(2).max(25) },
    async ({ productIds }) => {
      assertManufacturingApiVersion(apiVersion);
      if (new Set(productIds).size !== productIds.length) {
        throw new Error('productIds must be unique');
      }
      const sortedProductIds = [...productIds].sort();
      const products: ManufacturingEnvelope[] = [];
      const failures: Array<{ productId: string; message: string }> = [];
      for (let index = 0; index < sortedProductIds.length; index += 4) {
        const batch = sortedProductIds.slice(index, index + 4);
        const rows = await Promise.all(batch.map(async (id) => {
          try {
            return { product: normalizeManufacturingProduct(await fetchManufacturingProduct(client, id)) };
          } catch (error) {
            return { failure: { productId: id, message: error instanceof Error ? error.message : String(error) } };
          }
        }));
        for (const row of rows) {
          if (row.product) products.push(row.product);
          else if (row.failure) failures.push(row.failure);
        }
      }

      const componentIds = Array.from(
        new Set(products.flatMap((product) => product.components.map((row) => row.childProductId)))
      ).sort();
      const componentMatrix = componentIds.map((childProductId) => {
        const first = products
          .flatMap((product) => product.components)
          .find((row) => row.childProductId === childProductId);
        return {
          childProductId,
          childProductName: first?.childProductName,
          childProductSku: first?.childProductSku,
          products: products.map((product) => {
            const component = product.components.find(
              (row) => row.childProductId === childProductId
            );
            return {
              productId: product.productId,
              quantity: component?.quantity ?? null,
              uomQuantity: component?.uomQuantity ?? null,
              uom: component?.uom ?? null,
            };
          }),
        };
      });
      const hashes = products.map(manufacturingConfigHash);
      return textResult({
        complete: failures.length === 0,
        equivalent: failures.length === 0 && new Set(hashes).size === 1,
        products: products.map((product, index) => ({
          productId: product.productId,
          productName: product.productName,
          productSku: product.productSku,
          configHash: hashes[index],
          settings: product.settings,
          productOperations: product.productOperations,
          warnings: product.warnings,
        })),
        componentMatrix,
        failures,
      });
    }
  );

  server.tool(
    'set_product_manufacturing_config',
    'Preview or apply a concurrency-checked product BOM, operation-template, and manufacturing-settings change. Apply requires the exact full confirmation scope and hash returned by a fresh preview.',
    {
      productId: z.string().min(1),
      mode: z.enum(['patch', 'replace']).default('patch'),
      components: z.array(componentSchema).optional(),
      removeItemBomIds: z.array(z.string()).optional(),
      productOperations: z.array(operationSchema).optional(),
      removeProductOperationIds: z.array(z.string()).optional(),
      autoAssemble: z.boolean().optional(),
      includeQuantityBuildable: z.boolean().optional(),
      allowInactiveComponents: z.boolean().default(false),
      expectedConfigHash: z.string().optional(),
      expectedProductTimestamp: z.string().optional(),
      previewToken: z.string().optional(),
      idempotencyKey: z.string().min(1).optional(),
      expectedSemanticHash: z.string().optional(),
      expectedWriteShapeHash: z.string().optional(),
      expectedEntityTimestamp: z.string().optional(),
      expectedDesiredHash: z.string().optional(),
      confirmation: explicitMutationConfirmationSchema.optional(),
      dryRun: z.boolean().default(true),
    },
    async (args) => {
      assertManufacturingApiVersion(apiVersion);
      const safeArgs = {
        ...args,
        expectedSemanticHash: args.expectedSemanticHash ?? args.expectedConfigHash,
        expectedEntityTimestamp: args.expectedEntityTimestamp ?? args.expectedProductTimestamp,
      } as SafeManufacturingConfigInput;
      const result = await setProductManufacturingConfigSafe(client, config, safeArgs);
      return textResult({
        ...result,
        currentConfigHash: result.currentSemanticHash,
        desiredConfigHash: result.desiredHash,
        expectedProductTimestamp: result.entityTimestamp,
      });
    }
  );
}
