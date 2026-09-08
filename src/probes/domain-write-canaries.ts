import { randomUUID } from 'node:crypto';
import { loadConfig, type InflowConfig } from '../config.js';
import { InflowApiError, InflowClient } from '../client/inflow.js';
import { stableStringify } from '../core/canonical-json.js';
import { normalizeDecimal } from '../core/decimal.js';
import { tenantFingerprint } from '../core/preview-token.js';
import {
  canonicalSerialInventoryProjection,
  type CanonicalSerialInventoryRow,
} from '../services/inventory-summaries.js';
import {
  buildDesiredSerialState,
  canonicalManufacturingOrderProjection,
  fetchManufacturingOrderTrace,
  flattenManufacturingLines,
} from '../services/manufacturing-order-trace.js';
import {
  manufacturingOperationCompletionStateHash,
  planManufacturingOperationCompletion,
  planManufacturingRunBegin,
  YOUR_COMPANY_ASSEMBLY_OPERATION_TYPE_ID,
  type BeginManufacturingRunInput,
} from '../services/manufacturing-run-planner.js';
import {
  buildDesiredGroup,
  groupSemantic,
  normalizeSelection,
  validateGroupMatrix,
  writableGroup,
} from '../services/product-group-config.js';
import {
  buildDesiredPrices,
  fetchProductPrices,
  priceSemantic,
  writablePrices,
  type ProductPriceState,
} from '../services/product-prices.js';
import type {
  ManufacturingOrder,
  Product,
  ProductGroup,
  ProductPrice,
} from '../types/inflow.js';
import { isTimestampConcurrencyConflict } from './manufacturing-writes.js';
import { issuePassingCanaryAttestation } from './canary-attestation.js';

export type ProbeDomain =
  | 'prices'
  | 'product-groups'
  | 'mo-serials'
  | 'manufacturing-operation-completion-v1';

type CanaryClient = Pick<InflowClient, 'get' | 'put'>;

export interface DomainCanaryDependencies {
  client?: CanaryClient;
  env?: NodeJS.ProcessEnv;
  uuid?: () => string;
  config?: InflowConfig;
}

export interface CanaryPreflight {
  domain: ProbeDomain;
  approved: false;
  resourceId: string;
  resourceReachable: boolean;
  requiredMatrix: string[];
  nextStep: string;
}

const MATRICES: Record<ProbeDomain, string[]> = {
  prices: ['add/update/remove/clear', 'client versus server row IDs', 'stale timestamp rejection', 'full-scheme preservation', 'restore snapshot'],
  'product-groups': ['option/value/variant add/update/remove/clear', 'full-array preservation', 'deterministic IDs', 'stale timestamp rejection', 'orphan-product deactivation', 'restore snapshot'],
  'mo-serials': ['linked pick/matching add/swap/remove', 'inventory movement readback', 'stale timestamp rejection', 'concurrent unrelated edit', 'net-zero compensating reversal'],
  'manufacturing-operation-completion-v1': [
    'exact Assembly operation shape',
    'tracked-time and timesheet preservation',
    'stale timestamp no-write',
    'response-loss readback',
    'partial-write quarantine classification',
    'output serial and inventory movement',
    'exact cleanup restoration',
  ],
};

function runtime(dependencies: DomainCanaryDependencies = {}): {
  client: CanaryClient;
  env: NodeJS.ProcessEnv;
  uuid: () => string;
  config?: InflowConfig;
} {
  if (dependencies.client) {
    return {
      client: dependencies.client,
      env: dependencies.env ?? process.env,
      uuid: dependencies.uuid ?? randomUUID,
      ...(dependencies.config ? { config: dependencies.config } : {}),
    };
  }
  const config = loadConfig();
  return {
    client: new InflowClient(config),
    env: dependencies.env ?? process.env,
    uuid: dependencies.uuid ?? randomUUID,
    config,
  };
}

function assertApprovedResource(env: NodeJS.ProcessEnv, resourceId: string): void {
  if (env.INFLOW_CANARY_APPROVED !== 'true') {
    throw new Error('Canary refused: INFLOW_CANARY_APPROVED=true is required after explicit approval for this exact inert fixture');
  }
  if (!env.INFLOW_CANARY_RESOURCE_ID || env.INFLOW_CANARY_RESOURCE_ID !== resourceId) {
    throw new Error('Canary refused: INFLOW_CANARY_RESOURCE_ID must exactly match the approved resource argument');
  }
}

function parseFixture<T extends Record<string, unknown>>(env: NodeJS.ProcessEnv, name: string): T {
  const raw = env[name];
  if (!raw) throw new Error(`${name} is required and must describe the exact approved fixture`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as T;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function canaryMarked(value: string, path: string): string {
  if (!/canary/i.test(value)) throw new Error(`${path} must contain CANARY to identify a disposable fixture`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function rowversionAdvanced(before: string | undefined, after: string | undefined): boolean {
  return Boolean(before && after && before !== after);
}

async function fetchGroup(client: CanaryClient, id: string): Promise<ProductGroup> {
  return client.get<ProductGroup>(`/product-groups/${id}`, {
    include: ['options.optionValues', 'productVariants.product'],
  });
}

async function putGroup(
  client: CanaryClient,
  current: ProductGroup,
  desired: ProductGroup
): Promise<ProductGroup> {
  if (!current.timestamp) throw new Error('PRODUCT_GROUP_CANARY_TIMESTAMP_REQUIRED');
  await client.put<ProductGroup>('/product-groups', writableGroup({
    ...desired,
    timestamp: current.timestamp,
  }));
  return fetchGroup(client, current.productGroupId!);
}

async function putManufacturingOrder(
  client: CanaryClient,
  current: ManufacturingOrder,
  desired: ManufacturingOrder,
  timestamp = current.timestamp
): Promise<ManufacturingOrder> {
  if (!current.manufacturingOrderId || !timestamp) {
    throw new Error('MO_SERIAL_CANARY_TIMESTAMP_REQUIRED');
  }
  const body = structuredClone(current);
  body.timestamp = timestamp;
  body.lines = structuredClone(desired.lines ?? []);
  body.pickLines = structuredClone(desired.pickLines ?? []);
  body.pickMatchings = structuredClone(desired.pickMatchings ?? []);
  body.remarks = desired.remarks;
  await client.put<ManufacturingOrder>('/manufacturing-orders', body);
  return fetchManufacturingOrderTrace(client as InflowClient, current.manufacturingOrderId);
}

export async function preflightDomainCanary(
  domain: ProbeDomain,
  resourceId: string,
  dependencies: DomainCanaryDependencies = {}
): Promise<CanaryPreflight> {
  const { client } = runtime(dependencies);
  const endpoint = domain === 'product-groups'
    ? `/product-groups/${resourceId}`
    : domain === 'mo-serials' ||
        domain === 'manufacturing-operation-completion-v1'
      ? `/manufacturing-orders/${resourceId}`
      : `/products/${resourceId}`;
  await client.get(endpoint);
  return {
    domain,
    approved: false,
    resourceId,
    resourceReachable: true,
    requiredMatrix: MATRICES[domain],
    nextStep: 'Obtain explicit approval for this exact inert resource and rerun with --approve-external-write. A passing canary is release evidence only and never issues runtime authorization.',
  };
}

export interface PriceProbeResult {
  evidenceType: 'release-canary/v1';
  domain: 'prices';
  resourceId: string;
  addWorked: boolean;
  updateWorked: boolean;
  removeWorked: boolean;
  clearWorked: boolean;
  projectionPreserved: boolean;
  clientSuppliedIdRetained: boolean;
  adapterParityPassed: boolean;
  staleTimestampRejected: boolean;
  rowIdStrategy: 'client-supplied' | 'server-assigned' | 'unknown';
  cleanupSucceeded: boolean;
  errors: string[];
  passed: boolean;
}

async function putPrices(
  client: CanaryClient,
  current: ProductPriceState,
  prices: ProductPrice[]
): Promise<ProductPriceState> {
  await client.put<Product>('/products', {
    productId: current.productId,
    timestamp: current.timestamp,
    prices,
  });
  return fetchProductPrices(client as InflowClient, current.productId);
}

export async function runApprovedPriceCanary(
  resourceId: string,
  dependencies: DomainCanaryDependencies = {}
): Promise<PriceProbeResult> {
  const { client, env, uuid } = runtime(dependencies);
  assertApprovedResource(env, resourceId);
  const baselineSchemeId = env.INFLOW_CANARY_BASELINE_PRICING_SCHEME_ID;
  const candidateSchemeId = env.INFLOW_CANARY_PRICING_SCHEME_ID;
  if (!baselineSchemeId || !candidateSchemeId || baselineSchemeId === candidateSchemeId) {
    throw new Error('Two distinct INFLOW_CANARY_BASELINE_PRICING_SCHEME_ID and INFLOW_CANARY_PRICING_SCHEME_ID values are required');
  }
  const before = await fetchProductPrices(client as InflowClient, resourceId);
  if (before.isActive || before.prices.length > 0 || !/canary/i.test(`${before.name} ${before.sku ?? ''}`)) {
    throw new Error('PRICE_CANARY_RESOURCE_NOT_BLANK_INACTIVE: provide a CANARY-marked inactive disposable product with no price rows');
  }
  const result: PriceProbeResult = {
    evidenceType: 'release-canary/v1',
    domain: 'prices', resourceId, addWorked: false, updateWorked: false,
    removeWorked: false, clearWorked: false, projectionPreserved: false,
    clientSuppliedIdRetained: false, adapterParityPassed: false,
    staleTimestampRejected: false, rowIdStrategy: 'unknown', cleanupSucceeded: false,
    errors: [], passed: false,
  };
  let current = before;
  let afterCleanup: ProductPriceState | undefined;
  try {
    const baselineId = uuid();
    current = await putPrices(client, current, [{
      productPriceId: baselineId, productId: resourceId, pricingSchemeId: baselineSchemeId, unitPrice: '1.01', fixedMarkup: null,
    }]);
    const baseline = current.prices.find((row) => row.pricingSchemeId === baselineSchemeId);
    result.addWorked = normalizeDecimal(baseline?.unitPrice ?? '') === '1.01';
    result.clientSuppliedIdRetained = baseline?.productPriceId === baselineId;

    const staleTimestamp = current.timestamp;
    const candidateCreate = buildDesiredPrices({
      current,
      mode: 'patch',
      prices: [{ pricingSchemeId: candidateSchemeId, unitPrice: '2.01', fixedMarkup: null }],
    });
    current = await putPrices(client, current, writablePrices(candidateCreate));
    const candidate = current.prices.find((row) => row.pricingSchemeId === candidateSchemeId);
    result.rowIdStrategy = candidate?.productPriceId ? 'server-assigned' : 'unknown';
    result.adapterParityPassed = Boolean(candidate?.productPriceId) && normalizeDecimal(candidate?.unitPrice ?? '') === '2.01';
    result.projectionPreserved = normalizeDecimal(current.prices.find((row) => row.pricingSchemeId === baselineSchemeId)?.unitPrice ?? '') === '1.01';

    const candidateUpdate = buildDesiredPrices({
      current,
      mode: 'patch',
      prices: [{ productPriceId: candidate?.productPriceId, pricingSchemeId: candidateSchemeId, unitPrice: '2.02' }],
    });
    current = await putPrices(client, current, writablePrices(candidateUpdate));
    result.updateWorked = normalizeDecimal(current.prices.find((row) => row.pricingSchemeId === candidateSchemeId)?.unitPrice ?? '') === '2.02';

    if (!staleTimestamp || staleTimestamp === current.timestamp) {
      throw new Error('PRICE_CANARY_ROWVERSION_DID_NOT_ADVANCE');
    }
    try {
      await client.put<Product>('/products', {
        productId: resourceId,
        timestamp: staleTimestamp,
        prices: writablePrices(current),
      });
    } catch (error) {
      if (!isTimestampConcurrencyConflict(error)) throw error;
      result.staleTimestampRejected = true;
    }

    const candidateId = current.prices.find((row) => row.pricingSchemeId === candidateSchemeId)?.productPriceId;
    if (!candidateId) throw new Error('PRICE_CANARY_ADAPTER_PARITY_FAILED: server did not assign a productPriceId');
    const candidateRemoval = buildDesiredPrices({ current, mode: 'patch', removeProductPriceIds: [candidateId] });
    current = await putPrices(client, current, writablePrices(candidateRemoval));
    result.removeWorked = !current.prices.some((row) => row.pricingSchemeId === candidateSchemeId) && current.prices.some((row) => row.pricingSchemeId === baselineSchemeId);

    const cleared = buildDesiredPrices({ current, mode: 'replace', prices: [] });
    current = await putPrices(client, current, writablePrices(cleared));
    result.clearWorked = current.prices.length === 0;
  } catch (error) {
    result.errors.push(messageOf(error));
  } finally {
    try {
      current = await fetchProductPrices(client as InflowClient, resourceId);
      if (current.prices.length > 0) current = await putPrices(client, current, []);
      afterCleanup = await fetchProductPrices(client as InflowClient, resourceId);
      result.cleanupSucceeded = same(priceSemantic(before), priceSemantic(afterCleanup));
      if (!result.cleanupSucceeded) result.errors.push(`Cleanup failed; inspect product ${resourceId}`);
    } catch (error) {
      result.errors.push(`Cleanup failed; inspect product ${resourceId}: ${messageOf(error)}`);
    }
  }
  result.passed = result.addWorked && result.updateWorked && result.removeWorked && result.clearWorked &&
    result.projectionPreserved && result.adapterParityPassed && result.staleTimestampRejected &&
    result.rowIdStrategy !== 'unknown' && result.cleanupSucceeded && result.errors.length === 0;
  return result;
}

interface ProductGroupFixture {
  expectedTimestamp: string;
  expectedName: string;
  productName: string;
  productSku: string;
}

function parseProductGroupFixture(env: NodeJS.ProcessEnv): ProductGroupFixture {
  const value = parseFixture<Record<string, unknown>>(env, 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE');
  return {
    expectedTimestamp: requiredString(value.expectedTimestamp, 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.expectedTimestamp'),
    expectedName: canaryMarked(requiredString(value.expectedName, 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.expectedName'), 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.expectedName'),
    productName: canaryMarked(requiredString(value.productName, 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.productName'), 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.productName'),
    productSku: canaryMarked(requiredString(value.productSku, 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.productSku'), 'INFLOW_CANARY_PRODUCT_GROUP_FIXTURE.productSku'),
  };
}

export interface ProductGroupProbeResult {
  evidenceType: 'release-canary/v1';
  domain: 'product-groups';
  resourceId: string;
  productId: string;
  addWorked: boolean;
  updateWorked: boolean;
  removeWorked: boolean;
  clearWorked: boolean;
  fullArrayPreserved: boolean;
  deterministicIdsRetained: boolean;
  staleTimestampRejected: boolean;
  productCompensationVerified: boolean;
  cleanupSucceeded: boolean;
  errors: string[];
  passed: boolean;
}

function assertProductGroupFixture(group: ProductGroup, fixture: ProductGroupFixture): void {
  if (!group.productGroupId || !group.timestamp || group.timestamp !== fixture.expectedTimestamp ||
    group.name !== fixture.expectedName || group.isActive !== false ||
    (group.options?.length ?? 0) !== 0 || (group.productVariants?.length ?? 0) !== 0) {
    throw new Error('PRODUCT_GROUP_CANARY_FIXTURE_MISMATCH: expected the exact approved inactive, empty, timestamp-bound CANARY group');
  }
}

export async function runApprovedProductGroupCanary(
  resourceId: string,
  dependencies: DomainCanaryDependencies = {}
): Promise<ProductGroupProbeResult> {
  const { client, env, uuid } = runtime(dependencies);
  assertApprovedResource(env, resourceId);
  const fixture = parseProductGroupFixture(env);
  const before = await fetchGroup(client, resourceId);
  assertProductGroupFixture(before, fixture);

  const ids = {
    product: uuid(), optionA: uuid(), valueA1: uuid(), valueA2: uuid(),
    variant: uuid(), optionB: uuid(), valueB1: uuid(), staleOption: uuid(), staleValue: uuid(),
  };
  const result: ProductGroupProbeResult = {
    evidenceType: 'release-canary/v1', domain: 'product-groups', resourceId,
    productId: ids.product, addWorked: false, updateWorked: false,
    removeWorked: false, clearWorked: false, fullArrayPreserved: false,
    deterministicIdsRetained: false, staleTimestampRejected: false,
    productCompensationVerified: false, cleanupSucceeded: false,
    errors: [], passed: false,
  };
  let current = before;
  let groupMutationStarted = false;
  let productWriteAttempted = false;
  let productCreated = false;
  try {
    productWriteAttempted = true;
    await client.put<Product>('/products', {
      productId: ids.product,
      name: fixture.productName,
      sku: fixture.productSku,
      isActive: false,
    });
    const createdProduct = await client.get<Product>(`/products/${ids.product}`);
    productCreated = createdProduct.productId === ids.product && createdProduct.sku === fixture.productSku && createdProduct.isActive === false;
    if (!productCreated) throw new Error('PRODUCT_GROUP_CANARY_PRODUCT_CREATE_READBACK_FAILED');

    const added = buildDesiredGroup({
      current,
      mode: 'patch',
      options: [{
        name: '__CANARY_OPTION_A__',
        lineNum: 1,
        optionValues: [{ name: '__CANARY_VALUE_A1__' }, { name: '__CANARY_VALUE_A2__' }],
      }],
      variants: [{
        productId: ids.product,
        selection: [{ productGroupOptionId: ids.optionA, productGroupOptionValueId: ids.valueA1 }],
      }],
      plannedOptionIds: [ids.optionA],
      plannedValueIds: [ids.valueA1, ids.valueA2],
      plannedVariantIds: [ids.variant],
    });
    validateGroupMatrix(added);
    groupMutationStarted = true;
    current = await putGroup(client, current, added);
    const optionA = current.options?.find((row) => row.productGroupOptionId === ids.optionA);
    const variant = current.productVariants?.find((row) => row.productVariantId === ids.variant);
    result.addWorked = Boolean(optionA && optionA.optionValues?.length === 2 && variant?.productId === ids.product);
    result.deterministicIdsRetained = Boolean(
      optionA?.optionValues?.some((row) => row.productGroupOptionValueId === ids.valueA1) &&
      optionA?.optionValues?.some((row) => row.productGroupOptionValueId === ids.valueA2) &&
      variant
    );
    const staleTimestamp = current.timestamp;

    const updated = buildDesiredGroup({
      current,
      mode: 'patch',
      options: [
        {
          productGroupOptionId: ids.optionA,
          name: '__CANARY_OPTION_A_UPDATED__',
          lineNum: 1,
          optionValues: [
            { productGroupOptionValueId: ids.valueA1, name: '__CANARY_VALUE_A1__' },
            { productGroupOptionValueId: ids.valueA2, name: '__CANARY_VALUE_A2_UPDATED__' },
          ],
        },
        { name: '__CANARY_OPTION_B__', lineNum: 2, optionValues: [{ name: '__CANARY_VALUE_B1__' }] },
      ],
      variants: [{
        productVariantId: ids.variant,
        productId: ids.product,
        selection: [
          { productGroupOptionId: ids.optionA, productGroupOptionValueId: ids.valueA1 },
          { productGroupOptionId: ids.optionB, productGroupOptionValueId: ids.valueB1 },
        ],
      }],
      plannedOptionIds: [ids.optionB],
      plannedValueIds: [ids.valueB1],
      plannedVariantIds: [],
    });
    validateGroupMatrix(updated);
    current = await putGroup(client, current, updated);
    const updatedA = current.options?.find((row) => row.productGroupOptionId === ids.optionA);
    const addedB = current.options?.find((row) => row.productGroupOptionId === ids.optionB);
    const updatedVariant = current.productVariants?.find((row) => row.productVariantId === ids.variant);
    result.updateWorked = updatedA?.name === '__CANARY_OPTION_A_UPDATED__' &&
      updatedA.optionValues?.find((row) => row.productGroupOptionValueId === ids.valueA2)?.name === '__CANARY_VALUE_A2_UPDATED__';
    result.fullArrayPreserved = Boolean(
      updatedA && addedB && updatedVariant && normalizeSelection(updatedVariant.variantOption).length === 2
    );
    result.deterministicIdsRetained = result.deterministicIdsRetained && Boolean(
      addedB?.optionValues?.some((row) => row.productGroupOptionValueId === ids.valueB1)
    );

    if (!staleTimestamp || staleTimestamp === current.timestamp) {
      throw new Error('PRODUCT_GROUP_CANARY_ROWVERSION_DID_NOT_ADVANCE');
    }
    const staleDesired = buildDesiredGroup({
      current,
      mode: 'patch',
      options: [{ name: '__CANARY_STALE_OPTION__', optionValues: [{ name: '__CANARY_STALE_VALUE__' }] }],
      plannedOptionIds: [ids.staleOption],
      plannedValueIds: [ids.staleValue],
      plannedVariantIds: [],
    });
    const beforeStale = current;
    try {
      await client.put<ProductGroup>('/product-groups', writableGroup({ ...staleDesired, timestamp: staleTimestamp }));
    } catch (error) {
      if (!isTimestampConcurrencyConflict(error)) throw error;
      result.staleTimestampRejected = true;
    }
    current = await fetchGroup(client, resourceId);
    if (!same(groupSemantic(current), groupSemantic(beforeStale)) || current.timestamp !== beforeStale.timestamp) {
      throw new Error('PRODUCT_GROUP_CANARY_STALE_REJECTION_CHANGED_STATE');
    }

    const withoutB = buildDesiredGroup({
      current,
      mode: 'patch',
      variants: [{
        productVariantId: ids.variant,
        productId: ids.product,
        selection: [{ productGroupOptionId: ids.optionA, productGroupOptionValueId: ids.valueA1 }],
      }],
      removeOptionIds: [ids.optionB],
      plannedOptionIds: [], plannedValueIds: [], plannedVariantIds: [],
    });
    validateGroupMatrix(withoutB);
    current = await putGroup(client, current, withoutB);
    const withoutA2 = buildDesiredGroup({
      current,
      mode: 'patch',
      removeOptionValueIds: [ids.valueA2],
      plannedOptionIds: [], plannedValueIds: [], plannedVariantIds: [],
    });
    validateGroupMatrix(withoutA2);
    current = await putGroup(client, current, withoutA2);
    result.removeWorked = current.options?.length === 1 &&
      current.options[0]?.productGroupOptionId === ids.optionA &&
      current.options[0]?.optionValues?.length === 1 &&
      current.productVariants?.length === 1;

    const cleared = buildDesiredGroup({
      current,
      mode: 'replace', options: [], variants: [],
      plannedOptionIds: [], plannedValueIds: [], plannedVariantIds: [],
    });
    validateGroupMatrix(cleared);
    current = await putGroup(client, current, cleared);
    result.clearWorked = (current.options?.length ?? 0) === 0 && (current.productVariants?.length ?? 0) === 0;
  } catch (error) {
    result.errors.push(messageOf(error));
  } finally {
    if (groupMutationStarted) {
      try {
        current = await fetchGroup(client, resourceId);
        const restored = await putGroup(client, current, before);
        result.cleanupSucceeded = same(groupSemantic(restored), groupSemantic(before));
        if (!result.cleanupSucceeded) result.errors.push(`Group cleanup failed; inspect product group ${resourceId}`);
      } catch (error) {
        result.errors.push(`Group cleanup failed; inspect product group ${resourceId}: ${messageOf(error)}`);
      }
    }
    if (productWriteAttempted) {
      try {
        const product = await client.get<Product>(`/products/${ids.product}`);
        await client.put<Product>('/products', {
          productId: ids.product,
          timestamp: product.timestamp,
          isActive: false,
        });
        const deactivated = await client.get<Product>(`/products/${ids.product}`);
        const group = await fetchGroup(client, resourceId);
        result.productCompensationVerified = deactivated.isActive === false &&
          !(group.productVariants ?? []).some((row) => row.productId === ids.product);
        if (!result.productCompensationVerified) {
          result.errors.push(`Product compensation failed; deactivate residual product ${ids.product}`);
        }
      } catch (error) {
        if (error instanceof InflowApiError && error.statusCode === 404 && !productCreated) {
          result.productCompensationVerified = true;
        } else {
          result.errors.push(`Product compensation failed; deactivate residual product ${ids.product}: ${messageOf(error)}`);
        }
      }
    }
  }
  result.passed = result.addWorked && result.updateWorked && result.removeWorked && result.clearWorked &&
    result.fullArrayPreserved && result.deterministicIdsRetained && result.staleTimestampRejected &&
    result.productCompensationVerified && result.cleanupSucceeded && result.errors.length === 0;
  return result;
}

interface MoSerialFixture {
  expectedTimestamp: string;
  lineId: string;
  pickLineId: string;
  productId: string;
  serialA: string;
  serialB: string;
  locationId: string;
  sublocation: string;
  expectedRemarks: string;
}

function parseMoSerialFixture(env: NodeJS.ProcessEnv): MoSerialFixture {
  const value = parseFixture<Record<string, unknown>>(env, 'INFLOW_CANARY_MO_SERIAL_FIXTURE');
  const serialA = canaryMarked(requiredString(value.serialA, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.serialA'), 'INFLOW_CANARY_MO_SERIAL_FIXTURE.serialA');
  const serialB = canaryMarked(requiredString(value.serialB, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.serialB'), 'INFLOW_CANARY_MO_SERIAL_FIXTURE.serialB');
  if (serialA.normalize('NFKC').trim().toUpperCase() === serialB.normalize('NFKC').trim().toUpperCase()) {
    throw new Error('INFLOW_CANARY_MO_SERIAL_FIXTURE serialA and serialB must be distinct');
  }
  if (typeof value.expectedRemarks !== 'string' || typeof value.sublocation !== 'string') {
    throw new Error('INFLOW_CANARY_MO_SERIAL_FIXTURE.expectedRemarks and sublocation must be strings');
  }
  return {
    expectedTimestamp: requiredString(value.expectedTimestamp, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.expectedTimestamp'),
    lineId: requiredString(value.lineId, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.lineId'),
    pickLineId: requiredString(value.pickLineId, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.pickLineId'),
    productId: requiredString(value.productId, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.productId'),
    serialA, serialB,
    locationId: requiredString(value.locationId, 'INFLOW_CANARY_MO_SERIAL_FIXTURE.locationId'),
    sublocation: value.sublocation,
    expectedRemarks: value.expectedRemarks,
  };
}

async function readSerialInventory(
  client: CanaryClient,
  fixture: MoSerialFixture
): Promise<CanonicalSerialInventoryRow[]> {
  const product = await client.get<Product>(`/products/${fixture.productId}`, { include: ['inventoryLines'] });
  if (!Array.isArray(product.inventoryLines)) {
    throw new Error(`MO_SERIAL_CANARY_INVENTORY_LINES_MISSING: ${fixture.productId}`);
  }
  return canonicalSerialInventoryProjection([product], [
    { productId: fixture.productId, serial: fixture.serialA },
    { productId: fixture.productId, serial: fixture.serialB },
  ]);
}

function holding(
  projection: CanonicalSerialInventoryRow[],
  fixture: MoSerialFixture,
  serial: string
): CanonicalSerialInventoryRow['holdings'] {
  return projection.find((row) => row.productId === fixture.productId && row.serial === serial.normalize('NFKC').trim().toUpperCase())?.holdings ?? [];
}

function assertMoSerialFixture(
  order: ManufacturingOrder,
  fixture: MoSerialFixture,
  inventory: CanonicalSerialInventoryRow[]
): void {
  if (!order.manufacturingOrderId || order.timestamp !== fixture.expectedTimestamp ||
    order.isCancelled || order.isCompleted || ['closed', 'cancelled', 'completed'].includes((order.status ?? '').toLowerCase()) ||
    (order.remarks ?? '') !== fixture.expectedRemarks) {
    throw new Error('MO_SERIAL_CANARY_FIXTURE_MISMATCH: order identity, rowversion, state, or remarks differ from the exact approval');
  }
  const line = flattenManufacturingLines(order.lines ?? [])
    .find((row) => row.manufacturingOrderLineId === fixture.lineId);
  const pick = (order.pickLines ?? []).find((row) => row.manufacturingOrderPickLineId === fixture.pickLineId);
  const matchings = (order.pickMatchings ?? []).filter((row) =>
    row.manufacturingOrderLineId === fixture.lineId && row.manufacturingOrderPickLineId === fixture.pickLineId
  );
  if (!line || line.productId !== fixture.productId || !pick || pick.productId !== fixture.productId ||
    normalizeDecimal(pick.quantity?.standardQuantity ?? '') !== '1' ||
    (pick.quantity?.serialNumbers?.length ?? 0) !== 0 || matchings.length !== 1 || Boolean(matchings[0]?.serial)) {
    throw new Error('MO_SERIAL_CANARY_FIXTURE_MISMATCH: expected one exact un-serialized linked pick/matching pair with quantity 1');
  }
  for (const serial of [fixture.serialA, fixture.serialB]) {
    const holdings = holding(inventory, fixture, serial);
    if (holdings.length !== 1 || holdings[0]?.locationId !== fixture.locationId ||
      holdings[0]?.sublocation !== fixture.sublocation || holdings[0]?.quantityOnHand !== '1') {
      throw new Error(`MO_SERIAL_CANARY_FIXTURE_MISMATCH: ${serial} must have exactly one approved unit at the approved location`);
    }
  }
}

function serialStateMatches(
  order: ManufacturingOrder,
  fixture: MoSerialFixture,
  serials: string[]
): boolean {
  const pick = (order.pickLines ?? []).find((row) => row.manufacturingOrderPickLineId === fixture.pickLineId);
  const matchingSerials = (order.pickMatchings ?? [])
    .filter((row) => row.manufacturingOrderLineId === fixture.lineId && row.manufacturingOrderPickLineId === fixture.pickLineId)
    .map((row) => row.serial)
    .filter((serial): serial is string => Boolean(serial));
  const expected = serials.map((serial) => serial.normalize('NFKC').trim().toUpperCase()).sort();
  const actualPick = (pick?.quantity?.serialNumbers ?? []).map((serial) => serial.normalize('NFKC').trim().toUpperCase()).sort();
  const actualMatchings = matchingSerials.map((serial) => serial.normalize('NFKC').trim().toUpperCase()).sort();
  return same(actualPick, expected) && same(actualMatchings, expected);
}

export interface MoSerialProbeResult {
  evidenceType: 'release-canary/v1';
  domain: 'mo-serials';
  resourceId: string;
  addWorked: boolean;
  swapWorked: boolean;
  removeWorked: boolean;
  inventoryMovementVerified: boolean;
  staleTimestampRejected: boolean;
  concurrentUnrelatedEditPreserved: boolean;
  netZeroReversalVerified: boolean;
  cleanupSucceeded: boolean;
  errors: string[];
  passed: boolean;
}

export async function runApprovedMoSerialCanary(
  resourceId: string,
  dependencies: DomainCanaryDependencies = {}
): Promise<MoSerialProbeResult> {
  const { client, env, uuid } = runtime(dependencies);
  assertApprovedResource(env, resourceId);
  const fixture = parseMoSerialFixture(env);
  const before = await fetchManufacturingOrderTrace(client as InflowClient, resourceId);
  const inventoryBefore = await readSerialInventory(client, fixture);
  assertMoSerialFixture(before, fixture, inventoryBefore);
  const result: MoSerialProbeResult = {
    evidenceType: 'release-canary/v1', domain: 'mo-serials', resourceId,
    addWorked: false, swapWorked: false, removeWorked: false,
    inventoryMovementVerified: false, staleTimestampRejected: false,
    concurrentUnrelatedEditPreserved: false, netZeroReversalVerified: false,
    cleanupSucceeded: false, errors: [], passed: false,
  };
  let current = before;
  let mutationStarted = false;
  try {
    const addA = buildDesiredSerialState(current, {
      mode: 'patch',
      inputPicks: [{
        manufacturingOrderLineId: fixture.lineId,
        manufacturingOrderPickLineId: fixture.pickLineId,
        serialNumbers: [fixture.serialA],
      }],
    }, [uuid()]);
    mutationStarted = true;
    const preAddTimestamp = current.timestamp;
    current = await putManufacturingOrder(client, current, addA);
    if (!rowversionAdvanced(preAddTimestamp, current.timestamp)) throw new Error('MO_SERIAL_CANARY_ROWVERSION_DID_NOT_ADVANCE');
    result.addWorked = serialStateMatches(current, fixture, [fixture.serialA]);
    const inventoryAfterA = await readSerialInventory(client, fixture);
    const aMoved = holding(inventoryAfterA, fixture, fixture.serialA).length === 0;
    const bStayed = same(holding(inventoryAfterA, fixture, fixture.serialB), holding(inventoryBefore, fixture, fixture.serialB));

    const swapBForStaleProbe = buildDesiredSerialState(current, {
      mode: 'patch',
      inputPicks: [{
        manufacturingOrderLineId: fixture.lineId,
        manufacturingOrderPickLineId: fixture.pickLineId,
        serialNumbers: [fixture.serialB],
      }],
    }, [uuid()]);
    const beforeStale = current;
    try {
      await putManufacturingOrder(client, current, swapBForStaleProbe, fixture.expectedTimestamp);
    } catch (error) {
      if (!isTimestampConcurrencyConflict(error)) throw error;
      result.staleTimestampRejected = true;
    }
    current = await fetchManufacturingOrderTrace(client as InflowClient, resourceId);
    if (!same(canonicalManufacturingOrderProjection(current), canonicalManufacturingOrderProjection(beforeStale)) ||
      current.timestamp !== beforeStale.timestamp) {
      throw new Error('MO_SERIAL_CANARY_STALE_REJECTION_CHANGED_STATE');
    }

    const unrelatedMarker = `${fixture.expectedRemarks}\n[MO-SERIAL-CANARY:${uuid()}]`.trim();
    const unrelatedEdit = structuredClone(current);
    unrelatedEdit.remarks = unrelatedMarker;
    const beforeUnrelatedTimestamp = current.timestamp;
    current = await putManufacturingOrder(client, current, unrelatedEdit);
    result.concurrentUnrelatedEditPreserved = rowversionAdvanced(beforeUnrelatedTimestamp, current.timestamp) &&
      current.remarks === unrelatedMarker && serialStateMatches(current, fixture, [fixture.serialA]);

    const swapB = buildDesiredSerialState(current, {
      mode: 'patch',
      inputPicks: [{
        manufacturingOrderLineId: fixture.lineId,
        manufacturingOrderPickLineId: fixture.pickLineId,
        serialNumbers: [fixture.serialB],
      }],
    }, [uuid()]);
    current = await putManufacturingOrder(client, current, swapB);
    result.swapWorked = serialStateMatches(current, fixture, [fixture.serialB]) && current.remarks === unrelatedMarker;
    const inventoryAfterB = await readSerialInventory(client, fixture);
    const aRestored = same(holding(inventoryAfterB, fixture, fixture.serialA), holding(inventoryBefore, fixture, fixture.serialA));
    const bMoved = holding(inventoryAfterB, fixture, fixture.serialB).length === 0;
    result.inventoryMovementVerified = aMoved && bStayed && aRestored && bMoved;

    // The production helper correctly rejects a quantity-one pick with zero
    // serials as a desired steady state. The release probe must still
    // characterize the provider's compensating removal semantics, so build
    // that one net-zero reversal explicitly from the latest full document.
    const remove = structuredClone(current);
    const removePick = (remove.pickLines ?? []).find((row) =>
      row.manufacturingOrderPickLineId === fixture.pickLineId
    );
    if (!removePick) throw new Error('MO_SERIAL_CANARY_REMOVE_PICK_MISSING');
    removePick.quantity = { ...removePick.quantity, serialNumbers: [] };
    remove.pickMatchings = (remove.pickMatchings ?? []).filter((row) => !(
      row.manufacturingOrderLineId === fixture.lineId &&
      row.manufacturingOrderPickLineId === fixture.pickLineId
    ));
    current = await putManufacturingOrder(client, current, remove);
    result.removeWorked = serialStateMatches(current, fixture, []);
    const inventoryAfterRemove = await readSerialInventory(client, fixture);
    result.netZeroReversalVerified = same(inventoryAfterRemove, inventoryBefore);
  } catch (error) {
    result.errors.push(messageOf(error));
  } finally {
    if (mutationStarted) {
      try {
        current = await fetchManufacturingOrderTrace(client as InflowClient, resourceId);
        const restored = await putManufacturingOrder(client, current, before);
        const inventoryRestored = await readSerialInventory(client, fixture);
        result.cleanupSucceeded = same(
          canonicalManufacturingOrderProjection(restored),
          canonicalManufacturingOrderProjection(before)
        ) && same(inventoryRestored, inventoryBefore);
        if (!result.cleanupSucceeded) result.errors.push(`MO serial cleanup failed; inspect manufacturing order ${resourceId}`);
      } catch (error) {
        result.errors.push(`MO serial cleanup failed; inspect manufacturing order ${resourceId}: ${messageOf(error)}`);
      }
    }
  }
  result.passed = result.addWorked && result.swapWorked && result.removeWorked &&
    result.inventoryMovementVerified && result.staleTimestampRejected &&
    result.concurrentUnrelatedEditPreserved && result.netZeroReversalVerified &&
    result.cleanupSucceeded && result.errors.length === 0;
  return result;
}

interface OperationCompletionCanaryFixture {
  schemaVersion: 'manufacturing-operation-completion-canary-fixture/v1';
  beginInput: BeginManufacturingRunInput;
  expectedTimestamp: string;
  expectedPreStateHash: string;
  staleTimestamp: string;
  staleExpectedRejection: {
    statusCode: number;
    code: string | null;
  };
  sourceProductId: string;
  output: {
    serialNumber: string;
    locationId: string;
    sublocation?: string;
  };
  approvedInertArtifactIds: string[];
}

export interface OperationCompletionProbeResult {
  evidenceType: 'release-canary/v1';
  domain: 'manufacturing-operation-completion-v1';
  resourceId: string;
  exactAssemblyShape: boolean;
  trackTimePreserved: boolean;
  timesheetsPreserved: boolean;
  operationsCompleted: boolean;
  outputSerial: boolean;
  putAway: boolean;
  orderCompleted: boolean;
  unknownFieldsPreserved: boolean;
  staleRowversionNoWrite: boolean;
  responseLossReadback: boolean;
  partialWriteQuarantine: boolean;
  inventoryMovement: boolean;
  exactReadback: boolean;
  cleanupSucceeded: boolean;
  attestationIssued: boolean;
  errors: string[];
  passed: boolean;
}

function parseOperationCompletionFixture(
  env: NodeJS.ProcessEnv
): OperationCompletionCanaryFixture {
  const value = parseFixture<Record<string, unknown>>(
    env,
    'INFLOW_CANARY_OPERATION_COMPLETION_JSON'
  );
  if (
    value.schemaVersion !==
      'manufacturing-operation-completion-canary-fixture/v1' ||
    !value.beginInput ||
    typeof value.beginInput !== 'object' ||
    Array.isArray(value.beginInput) ||
    !value.output ||
    typeof value.output !== 'object' ||
    Array.isArray(value.output) ||
    !Array.isArray(value.approvedInertArtifactIds)
  ) {
    throw new Error('OPERATION_COMPLETION_CANARY_FIXTURE_INVALID');
  }
  const output = value.output as Record<string, unknown>;
  const staleExpectedRejection = value.staleExpectedRejection;
  if (
    !staleExpectedRejection ||
    typeof staleExpectedRejection !== 'object' ||
    Array.isArray(staleExpectedRejection)
  ) {
    throw new Error('OPERATION_COMPLETION_CANARY_FIXTURE_INVALID');
  }
  const expectedRejection = staleExpectedRejection as Record<string, unknown>;
  if (
    expectedRejection.statusCode !== 409 ||
    !(
      expectedRejection.code === null ||
      (typeof expectedRejection.code === 'string' &&
        expectedRejection.code.trim() === expectedRejection.code &&
        expectedRejection.code.length > 0)
    )
  ) {
    throw new Error('OPERATION_COMPLETION_CANARY_FIXTURE_INVALID');
  }
  return {
    schemaVersion:
      'manufacturing-operation-completion-canary-fixture/v1',
    beginInput: value.beginInput as unknown as BeginManufacturingRunInput,
    expectedTimestamp: requiredString(
      value.expectedTimestamp,
      'expectedTimestamp'
    ),
    expectedPreStateHash: requiredString(
      value.expectedPreStateHash,
      'expectedPreStateHash'
    ),
    staleTimestamp: requiredString(value.staleTimestamp, 'staleTimestamp'),
    staleExpectedRejection: {
      statusCode: 409,
      code: expectedRejection.code as string | null,
    },
    sourceProductId: requiredString(
      value.sourceProductId,
      'sourceProductId'
    ),
    output: {
      serialNumber: canaryMarked(
        requiredString(output.serialNumber, 'output.serialNumber'),
        'output.serialNumber'
      ),
      locationId: requiredString(output.locationId, 'output.locationId'),
      ...(typeof output.sublocation === 'string'
        ? { sublocation: output.sublocation }
        : {}),
    },
    approvedInertArtifactIds: value.approvedInertArtifactIds.map(
      (id, index) => requiredString(id, `approvedInertArtifactIds[${index}]`)
    ),
  };
}

function serialHoldings(product: Product, serial: string): Array<{
  locationId: string;
  sublocation: string;
  quantityOnHand: string;
}> {
  const normalizedSerial = serial.normalize('NFKC').trim().toUpperCase();
  return (product.inventoryLines ?? [])
    .filter(
      (line) =>
        (line.serial ?? '').normalize('NFKC').trim().toUpperCase() ===
          normalizedSerial &&
        Number(normalizeDecimal(line.quantityOnHand ?? '0')) > 0
    )
    .map((line) => ({
      locationId: line.locationId ?? '',
      sublocation: line.sublocation ?? '',
      quantityOnHand: normalizeDecimal(line.quantityOnHand ?? '0'),
    }))
    .sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right))
    );
}

async function readOperationCompletionCanarySnapshot(
  client: CanaryClient,
  resourceId: string,
  fixture: OperationCompletionCanaryFixture
): Promise<{
  order: ManufacturingOrder;
  outputProduct: Product;
  sourceProduct: Product;
  semantic: {
    orderStateHash: string;
    outputHoldings: ReturnType<typeof serialHoldings>;
    sourceHoldings: ReturnType<typeof serialHoldings>;
  };
}> {
  const begin = planManufacturingRunBegin(fixture.beginInput);
  const [order, outputProduct, sourceProduct] = await Promise.all([
    fetchManufacturingOrderTrace(client as InflowClient, resourceId),
    client.get<Product>(
      `/products/${begin.normalizedIdentity.finishedProductId}`,
      { include: ['inventoryLines'] }
    ),
    client.get<Product>(
      `/products/${fixture.sourceProductId}`,
      { include: ['inventoryLines'] }
    ),
  ]);
  return {
    order,
    outputProduct,
    sourceProduct,
    semantic: {
      orderStateHash: manufacturingOperationCompletionStateHash(order),
      outputHoldings: serialHoldings(
        outputProduct,
        fixture.output.serialNumber
      ),
      sourceHoldings: serialHoldings(
        sourceProduct,
        begin.normalizedIdentity.sourceSerial
      ),
    },
  };
}

function operationCompletionCleanupProjection(
  order: ManufacturingOrder
): unknown {
  const normalized = structuredClone(order);
  for (const line of flattenManufacturingLines(normalized.lines ?? [])) {
    for (const operation of line.manufacturingOrderOperations ?? []) {
      operation.completedDate = null;
    }
  }
  return manufacturingOperationCompletionStateHash(normalized);
}

function operationCompletionCleanupBody(
  current: ManufacturingOrder,
  before: ManufacturingOrder
): ManufacturingOrder {
  const body = structuredClone(current);
  body.pickLines = [];
  body.pickMatchings = [];
  body.putLines = [];
  body.isCompleted = before.isCompleted ?? false;
  body.isCancelled = before.isCancelled ?? false;
  body.status = 'open';
  body.completedDate = before.completedDate ?? null;
  const baselineLines = new Map(
    flattenManufacturingLines(before.lines ?? []).map((line) => [
      line.manufacturingOrderLineId,
      line,
    ])
  );
  for (const line of flattenManufacturingLines(body.lines ?? [])) {
    const baseline = baselineLines.get(line.manufacturingOrderLineId);
    if (!baseline) {
      throw new Error('OPERATION_COMPLETION_CLEANUP_LINE_DRIFT');
    }
    line.quantity = {
      ...line.quantity,
      serialNumbers: [...(baseline.quantity?.serialNumbers ?? [])],
    };
  }
  return body;
}

function operationCompletionCleanupSourceHoldings(
  before: ManufacturingOrder,
  sourceProductId: string,
  sourceSerial: string
): ReturnType<typeof serialHoldings> {
  const normalizedSerial = sourceSerial.normalize('NFKC').trim().toUpperCase();
  const matchingPicks = (before.pickLines ?? []).filter(
    (line) =>
      line.productId === sourceProductId &&
      (line.quantity?.serialNumbers ?? []).some(
        (serial) =>
          serial.normalize('NFKC').trim().toUpperCase() ===
          normalizedSerial
      )
  );
  if (matchingPicks.length !== 1) {
    throw new Error('OPERATION_COMPLETION_CLEANUP_SOURCE_PICK_INVALID');
  }
  const pick = matchingPicks[0]!;
  return [{
    locationId: pick.locationId ?? '',
    sublocation: pick.sublocation ?? '',
    quantityOnHand: '1',
  }];
}

export async function runApprovedOperationCompletionCanary(
  resourceId: string,
  dependencies: DomainCanaryDependencies = {}
): Promise<OperationCompletionProbeResult> {
  const { client, env, config } = runtime(dependencies);
  assertApprovedResource(env, resourceId);
  const fixture = parseOperationCompletionFixture(env);
  const begin = planManufacturingRunBegin(fixture.beginInput);
  if (
    begin.manufacturingOrderId !== resourceId ||
    !fixture.approvedInertArtifactIds.includes(resourceId) ||
    !fixture.approvedInertArtifactIds.includes(
      begin.normalizedIdentity.finishedProductId
    ) ||
    !fixture.approvedInertArtifactIds.includes(fixture.sourceProductId)
  ) {
    throw new Error('OPERATION_COMPLETION_CANARY_RESOURCE_NOT_APPROVED');
  }
  const before = await readOperationCompletionCanarySnapshot(
    client,
    resourceId,
    fixture
  );
  if (
    before.order.timestamp !== fixture.expectedTimestamp ||
    before.semantic.orderStateHash !== fixture.expectedPreStateHash ||
    before.order.manufacturingOrderId !== begin.manufacturingOrderId ||
    before.outputProduct.isActive !== true ||
    before.outputProduct.trackSerials !== true ||
    before.sourceProduct.isActive !== true ||
    before.sourceProduct.trackSerials !== true ||
    before.semantic.outputHoldings.length !== 0 ||
    before.semantic.sourceHoldings.length !== 0
  ) {
    throw new Error('OPERATION_COMPLETION_CANARY_FIXTURE_DRIFT');
  }
  const result: OperationCompletionProbeResult = {
    evidenceType: 'release-canary/v1',
    domain: 'manufacturing-operation-completion-v1',
    resourceId,
    exactAssemblyShape: false,
    trackTimePreserved: false,
    timesheetsPreserved: false,
    operationsCompleted: false,
    outputSerial: false,
    putAway: false,
    orderCompleted: false,
    unknownFieldsPreserved: false,
    staleRowversionNoWrite: false,
    responseLossReadback: false,
    partialWriteQuarantine: false,
    inventoryMovement: false,
    exactReadback: false,
    cleanupSucceeded: false,
    attestationIssued: false,
    errors: [],
    passed: false,
  };
  const completionAt = new Date().toISOString();
  const plan = planManufacturingOperationCompletion({
    current: before.order,
    begin,
    completedAt: completionAt,
    output: fixture.output,
  });
  let afterCleanupSemantic: typeof before.semantic | undefined;
  const beforeOperations = flattenManufacturingLines(before.order.lines ?? [])
    .flatMap((line) => line.manufacturingOrderOperations ?? [])
    .sort((left, right) =>
      String(left.manufacturingOrderOperationId).localeCompare(
        String(right.manufacturingOrderOperationId)
      )
    );
  result.exactAssemblyShape =
    beforeOperations.length === plan.operationIds.length &&
    beforeOperations.every(
      (operation) =>
        operation.operationTypeId === YOUR_COMPANY_ASSEMBLY_OPERATION_TYPE_ID &&
        operation.completedDate == null
    );
  let mutationStarted = false;
  try {
    const stale = structuredClone(plan.request.body);
    stale.timestamp = fixture.staleTimestamp;
    try {
      await client.put<ManufacturingOrder>(
        '/manufacturing-orders',
        stale
      );
      throw new Error('OPERATION_COMPLETION_STALE_WRITE_UNEXPECTEDLY_APPLIED');
    } catch (error) {
      const exactExpectedRejection =
        error instanceof InflowApiError &&
        error.statusCode === fixture.staleExpectedRejection.statusCode &&
        (error.apiError?.code ?? null) ===
          fixture.staleExpectedRejection.code;
      if (
        !isTimestampConcurrencyConflict(error) &&
        !exactExpectedRejection
      ) {
        throw error;
      }
    }
    const afterStale = await readOperationCompletionCanarySnapshot(
      client,
      resourceId,
      fixture
    );
    if (
      afterStale.order.timestamp !== before.order.timestamp ||
      !same(afterStale.semantic, before.semantic)
    ) {
      throw new Error('OPERATION_COMPLETION_STALE_WRITE_CHANGED_STATE');
    }
    result.staleRowversionNoWrite = true;

    mutationStarted = true;
    await client.put<ManufacturingOrder>(
      '/manufacturing-orders',
      plan.request.body
    );
    // Deliberately discard the mutation response. Production recovery is
    // proven only from the fresh authoritative GET below.
    const after = await readOperationCompletionCanarySnapshot(
      client,
      resourceId,
      fixture
    );
    const afterOperations = flattenManufacturingLines(after.order.lines ?? [])
      .flatMap((line) => line.manufacturingOrderOperations ?? [])
      .sort((left, right) =>
        String(left.manufacturingOrderOperationId).localeCompare(
          String(right.manufacturingOrderOperationId)
        )
      );
    result.exactReadback =
      after.semantic.orderStateHash === plan.hashes.expectedPostState &&
      rowversionAdvanced(before.order.timestamp, after.order.timestamp);
    result.responseLossReadback = result.exactReadback;
    result.trackTimePreserved =
      afterOperations.length === beforeOperations.length &&
      afterOperations.every(
        (operation, index) =>
          operation.trackTime === beforeOperations[index]!.trackTime
      );
    result.timesheetsPreserved =
      afterOperations.length === beforeOperations.length &&
      afterOperations.every((operation, index) =>
        same(
          operation.manufacturingOrderOperationTimesheets ?? [],
          beforeOperations[index]!
            .manufacturingOrderOperationTimesheets ?? []
        )
      );
    result.operationsCompleted =
      afterOperations.map((operation) =>
        operation.manufacturingOrderOperationId
      ).sort().join('\0') === plan.operationIds.join('\0') &&
      afterOperations.every(
        (operation) =>
          Date.parse(operation.completedDate ?? '') ===
          Date.parse(plan.completedAt)
      );
    const root = flattenManufacturingLines(after.order.lines ?? []).find(
      (line) => line.manufacturingOrderLineId === begin.rootLineId
    );
    result.outputSerial =
      root?.quantity?.serialNumbers?.length === 1 &&
      root.quantity.serialNumbers[0] === fixture.output.serialNumber;
    const puts = after.order.putLines ?? [];
    const exactPut = puts[0];
    result.putAway =
      puts.length === 1 &&
      exactPut !== undefined &&
      (
        exactPut.manufacturingOrderLineId == null ||
        exactPut.manufacturingOrderLineId === begin.rootLineId
      ) &&
      exactPut.productId === begin.normalizedIdentity.finishedProductId &&
      exactPut.locationId === fixture.output.locationId &&
      (exactPut.sublocation ?? '') === (fixture.output.sublocation ?? '') &&
      normalizeDecimal(exactPut.quantity?.standardQuantity ?? '') === '1' &&
      same(exactPut.quantity?.serialNumbers ?? [], [
        fixture.output.serialNumber,
      ]);
    result.orderCompleted =
      after.order.isCompleted === true &&
      after.order.status?.toLowerCase() === 'completed' &&
      Date.parse(after.order.completedDate ?? '') ===
        Date.parse(plan.completedAt);
    result.unknownFieldsPreserved = result.exactReadback;
    result.inventoryMovement =
      after.semantic.outputHoldings.length === 1 &&
      after.semantic.outputHoldings[0]!.locationId ===
        fixture.output.locationId &&
      after.semantic.outputHoldings[0]!.sublocation ===
        (fixture.output.sublocation ?? '') &&
      after.semantic.outputHoldings[0]!.quantityOnHand === '1' &&
      after.semantic.sourceHoldings.length === 0 &&
      same(
        after.semantic.sourceHoldings,
        before.semantic.sourceHoldings
      );
    const partial = structuredClone(before.order);
    const partialOperation = flattenManufacturingLines(partial.lines ?? [])
      .flatMap((line) => line.manufacturingOrderOperations ?? [])[0];
    if (!partialOperation) {
      throw new Error('OPERATION_COMPLETION_PARTIAL_FIXTURE_MISSING');
    }
    partialOperation.completedDate = plan.completedAt;
    const partialHash = manufacturingOperationCompletionStateHash(partial);
    result.partialWriteQuarantine =
      partialHash !== plan.hashes.preState &&
      partialHash !== plan.hashes.expectedPostState;
  } catch (error) {
    result.errors.push(messageOf(error));
  } finally {
    if (mutationStarted) {
      try {
        const current = await fetchManufacturingOrderTrace(
          client as InflowClient,
          resourceId
        );
        const restore = operationCompletionCleanupBody(
          current,
          before.order
        );
        const expectedSourceHoldings =
          operationCompletionCleanupSourceHoldings(
            before.order,
            fixture.sourceProductId,
            begin.normalizedIdentity.sourceSerial
          );
        restore.timestamp = current.timestamp;
        await client.put<ManufacturingOrder>(
          '/manufacturing-orders',
          restore
        );
        const restored = await readOperationCompletionCanarySnapshot(
          client,
          resourceId,
          fixture
        );
        afterCleanupSemantic = restored.semantic;
        result.cleanupSucceeded =
          same(
            operationCompletionCleanupProjection(restored.order),
            operationCompletionCleanupProjection(restore)
          ) &&
          same(
            restored.semantic.outputHoldings,
            before.semantic.outputHoldings
          ) &&
          same(
            restored.semantic.sourceHoldings,
            expectedSourceHoldings
          ) &&
          restored.semantic.sourceHoldings.length === 1;
        if (!result.cleanupSucceeded) {
          result.errors.push(
            `operation completion cleanup failed; inspect manufacturing order ${resourceId}`
          );
        }
      } catch (error) {
        result.errors.push(
          `operation completion cleanup failed; inspect manufacturing order ${resourceId}: ${messageOf(error)}`
        );
      }
    }
  }
  result.passed =
    result.exactAssemblyShape &&
    result.trackTimePreserved &&
    result.timesheetsPreserved &&
    result.operationsCompleted &&
    result.outputSerial &&
    result.putAway &&
    result.orderCompleted &&
    result.unknownFieldsPreserved &&
    result.staleRowversionNoWrite &&
    result.responseLossReadback &&
    result.partialWriteQuarantine &&
    result.inventoryMovement &&
    result.exactReadback &&
    result.cleanupSucceeded &&
    result.errors.length === 0;
  if (result.passed) {
    if (!config) {
      result.errors.push('OPERATION_COMPLETION_ATTESTATION_CONFIG_REQUIRED');
      result.passed = false;
    } else {
      await issuePassingCanaryAttestation(config, {
        domain: 'manufacturing-operation-completion-v1',
        approvalNonce: env.INFLOW_CANARY_APPROVAL_NONCE,
        observedSemantics: {
          exactAssemblyShape: result.exactAssemblyShape,
          trackTimePreserved: result.trackTimePreserved,
          timesheetsPreserved: result.timesheetsPreserved,
          operationsCompleted: result.operationsCompleted,
          outputSerial: result.outputSerial,
          putAway: result.putAway,
          orderCompleted: result.orderCompleted,
          unknownFieldsPreserved: result.unknownFieldsPreserved,
          staleRowversionNoWrite: result.staleRowversionNoWrite,
          responseLossReadback: result.responseLossReadback,
          partialWriteQuarantine: result.partialWriteQuarantine,
          inventoryMovement: result.inventoryMovement,
          exactReadback: result.exactReadback,
          cleanup: result.cleanupSucceeded,
        },
        optimisticConcurrency: 'enforced',
        beforeSnapshot: before.semantic,
        afterCleanupSnapshot: afterCleanupSemantic,
        confirmedResidualIds: [resourceId],
        approvedInertArtifactIds: fixture.approvedInertArtifactIds,
      });
      result.attestationIssued = true;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const domain = process.argv[2] as ProbeDomain | undefined;
  const resourceId = process.argv[3];
  if (!domain || !MATRICES[domain] || !resourceId) {
    throw new Error('Usage: probe:domain <prices|product-groups|mo-serials|manufacturing-operation-completion-v1> <resourceId> [--approve-external-write]');
  }
  if (process.argv.includes('--approve-external-write')) {
    const result = domain === 'prices'
      ? await runApprovedPriceCanary(resourceId)
      : domain === 'product-groups'
        ? await runApprovedProductGroupCanary(resourceId)
        : domain === 'mo-serials'
          ? await runApprovedMoSerialCanary(resourceId)
          : await runApprovedOperationCompletionCanary(resourceId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  const result = await preflightDomainCanary(domain, resourceId);
  const config = loadConfig();
  const host = new URL(config.baseUrl).host.toLowerCase();
  console.log(JSON.stringify({
    ...result,
    tenantFingerprint: tenantFingerprint(config.companyId, config.apiKey, host),
    apiVersion: config.apiVersion,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  });
}
