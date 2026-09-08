#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { PreparedMutation } from '../client/inflow.js';
import { canonicalHash, stableStringify } from '../core/canonical-json.js';
import {
  addDecimal,
  decimalToString,
  normalizeDecimal,
  parseDecimal,
  ZERO_DECIMAL,
} from '../core/decimal.js';
import {
  canonicalInventorySummaryProjection,
  canonicalSerialInventoryProjection,
  normalizeProductSummary,
  type CanonicalInventorySummaryRow,
  type CanonicalSerialInventoryRow,
} from '../services/inventory-summaries.js';
import type { Product, ProductSummary } from '../types/inflow.js';

export const MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN =
  'manufacturing-pick-batch-fixture/v2' as const;
const LEGACY_MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN =
  'manufacturing-pick-batch-fixture/v1' as const;
export const MANUFACTURING_PICK_BATCH_FIXTURE_STATE_FILE =
  'manufacturing-pick-batch-fixtures.json' as const;

// Product detail responses include customFields by default; explicitly naming
// customFields is rejected by the live detail route with HTTP 400.
const PRODUCT_INCLUDE = [
  'itemBoms',
  'productOperations.operationType',
  'inventoryLines',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCENARIO = /^mpb-canary-[a-z0-9][a-z0-9-]{3,63}$/;
const MARKER = /^__MPB_CANARY__[A-Z0-9][A-Z0-9_]{3,48}$/;
const SKU = /^MPB-CANARY-[A-Z0-9][A-Z0-9-]{3,64}$/;
const SERIAL = /^MPB-CANARY-[A-Z0-9][A-Z0-9-]{3,80}$/;

export type ManufacturingPickBatchFixtureStage =
  | 'create-products'
  | 'configure-products'
  | 'seed-stock'
  | 'reverse-stock'
  | 'clear-config'
  | 'deactivate-products';

export type ManufacturingPickBatchFixtureCommand =
  | 'plan'
  | ManufacturingPickBatchFixtureStage
  | 'handoff'
  | 'verify-cleanup'
  | 'status';

export interface ManufacturingPickBatchFixtureProductIdentity {
  productId: string;
  name: string;
  sku: string;
}

export interface ManufacturingPickBatchFixtureManifest {
  schemaVersion: 'manufacturing-pick-batch-fixture-manifest/v1' | 'manufacturing-pick-batch-fixture-manifest/v2';
  scenarioId: string;
  marker: string;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  locationId: string;
  categoryId: string;
  adjustmentDate: string;
  adjustmentReasonIds: { add: string; remove: string };
  operationTypeId: string;
  products: {
    finishedComplete: ManufacturingPickBatchFixtureProductIdentity;
    finishedStaging: ManufacturingPickBatchFixtureProductIdentity;
    expandedSubassembly?: ManufacturingPickBatchFixtureProductIdentity;
    serializedInput: ManufacturingPickBatchFixtureProductIdentity;
    bulkInput: ManufacturingPickBatchFixtureProductIdentity;
  };
  serials: [string, string];
  quantities: { serialized: '2'; bulk: '4' };
  itemBomIds: {
    finishedCompleteSerialized?: string;
    finishedCompleteBulk?: string;
    finishedStagingSerialized?: string;
    finishedStagingBulk?: string;
    finishedCompleteSubassembly?: string;
    finishedStagingSubassembly?: string;
    expandedSubassemblySerialized?: string;
    expandedSubassemblyBulk?: string;
  };
  productOperationId: string;
  stockAdjustmentIds: { seed: string; reversal: string };
  stockAdjustmentItemIds: {
    seedSerialized: string;
    seedBulk: string;
    reversalSerialized: string;
    reversalBulk: string;
  };
  approvedInertArtifactIds: string[];
}

export interface ManufacturingPickBatchFixtureApproval {
  schemaVersion: 'manufacturing-pick-batch-fixture-approval/v1';
  approved: true;
  stage: ManufacturingPickBatchFixtureStage;
  approvalNonce: string;
  manifestHash: string;
  stagePlanHash: string;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  scenarioId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ManufacturingPickBatchFixtureRuntimeIdentity {
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
}

export interface ManufacturingPickBatchFixtureClient {
  get<T>(path: string, options?: Record<string, unknown>): Promise<T>;
  postRead<T>(path: string, body: unknown, options?: Record<string, unknown>): Promise<T>;
  getList<T>(path: string, options?: Record<string, unknown>): Promise<{ data: T[]; totalCount?: number }>;
  prepareMutation<T>(
    method: 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: { body?: unknown; [key: string]: unknown },
  ): Promise<PreparedMutation<T>>;
}

interface FixtureStockProjection {
  inventory: CanonicalInventorySummaryRow[];
  serials: CanonicalSerialInventoryRow[];
}

type FixtureCheckpointStage =
  | 'planned'
  | 'products-created'
  | 'configured'
  | 'stock-seeded'
  | 'handoff-complete'
  | 'stock-reversed'
  | 'config-cleared'
  | 'deactivated'
  | 'complete';

interface FixtureInFlightMutation {
  stage: ManufacturingPickBatchFixtureStage;
  mutationIndex: number;
  requestHash: string;
  path: string;
  dispatchState: 'armed' | 'dispatching';
  correlationId?: string;
}

interface FixtureCheckpoint {
  schemaVersion: 'manufacturing-pick-batch-fixture-checkpoint/v1';
  ownerId: string;
  manifestHash: string;
  stage: FixtureCheckpointStage;
  completedMutationHashes: string[];
  inFlight?: FixtureInFlightMutation;
  stockBaseline?: FixtureStockProjection;
  seededStock?: FixtureStockProjection;
  updatedAt: string;
}

export interface ManufacturingPickBatchFixtureCommandResult {
  schemaVersion: 'manufacturing-pick-batch-fixture-command-result/v1';
  command: ManufacturingPickBatchFixtureCommand;
  stage: FixtureCheckpointStage;
  manifestHash: string;
  nextApproval?: {
    stage: ManufacturingPickBatchFixtureStage;
    stagePlanHash: string;
  };
  stockBaselineHash?: string;
  seededStockHash?: string;
  approvedInertResiduals?: Array<{
    type: 'product' | 'stock-adjustment';
    id: string;
    state: 'deactivated' | 'retained';
  }>;
}

export interface ManufacturingPickBatchFixtureCommandInput {
  command: ManufacturingPickBatchFixtureCommand;
  manifest: unknown;
  approval?: unknown;
  client: ManufacturingPickBatchFixtureClient;
  stateDir: string;
  ownerId: string;
  runtimeIdentity: ManufacturingPickBatchFixtureRuntimeIdentity;
  now?: Date;
  hooks?: {
    lockAcquired?(path: string): Promise<void> | void;
    checkpointDurable?(path: string): Promise<void> | void;
    beforeDispatch?(inFlight: Readonly<FixtureInFlightMutation>): Promise<void> | void;
  };
}

export interface ManufacturingPickBatchFixtureCliArguments {
  command: ManufacturingPickBatchFixtureCommand;
  manifestPath: string;
  approvalPath?: string;
  stateDir: string;
  ownerId: string;
}

type JsonObject = Record<string, unknown>;

function invalid(scope: 'MANIFEST' | 'APPROVAL' | 'CHECKPOINT', detail: string): never {
  throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_${scope}_INVALID: ${detail}`);
}

function object(value: unknown, label: string, scope: 'MANIFEST' | 'APPROVAL' | 'CHECKPOINT' = 'MANIFEST'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(scope, `${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string, scope: 'MANIFEST' | 'APPROVAL' | 'CHECKPOINT' = 'MANIFEST'): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) invalid(scope, `${label}.${extra} is not allowed`);
  const missing = keys.find((key) => !(key in value));
  if (missing) invalid(scope, `${label}.${missing} is required`);
}

function nonEmpty(value: unknown, label: string, scope: 'MANIFEST' | 'APPROVAL' | 'CHECKPOINT' = 'MANIFEST'): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1) invalid(scope, `${label} must be a non-empty normalized string`);
  return value;
}

function iso(value: unknown, label: string, scope: 'MANIFEST' | 'APPROVAL' = 'MANIFEST'): string {
  const text = nonEmpty(value, label, scope);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) invalid(scope, `${label} must be a canonical ISO timestamp`);
  return text;
}

function normalizedInstant(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: ${label}`);
  return parsed.toISOString();
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) invalid('MANIFEST', `${label} values must be unique`);
}

function parseProductIdentity(value: unknown, label: string, marker: string): ManufacturingPickBatchFixtureProductIdentity {
  const row = object(value, label);
  exactKeys(row, ['productId', 'name', 'sku'], label);
  const productId = nonEmpty(row.productId, `${label}.productId`);
  const name = nonEmpty(row.name, `${label}.name`);
  const sku = nonEmpty(row.sku, `${label}.sku`);
  if (!UUID.test(productId)) invalid('MANIFEST', `${label}.productId must be a deterministic UUID`);
  if (!name.startsWith(`${marker} `) || !SKU.test(sku)) invalid('MANIFEST', `${label} name/SKU must use the canary marker`);
  return { productId, name, sku };
}

export function parseManufacturingPickBatchFixtureManifest(value: unknown): ManufacturingPickBatchFixtureManifest {
  const root = object(value, 'manifest');
  exactKeys(root, [
    'schemaVersion', 'scenarioId', 'marker', 'tenantFingerprint', 'baseHost', 'apiVersion',
    'probeBuild', 'adapterManifestHash', 'locationId', 'categoryId', 'adjustmentDate',
    'adjustmentReasonIds', 'operationTypeId', 'products', 'serials', 'quantities',
    'itemBomIds', 'productOperationId', 'stockAdjustmentIds', 'stockAdjustmentItemIds',
    'approvedInertArtifactIds',
  ], 'manifest');
  if (root.schemaVersion !== 'manufacturing-pick-batch-fixture-manifest/v1' &&
      root.schemaVersion !== 'manufacturing-pick-batch-fixture-manifest/v2') {
    invalid('MANIFEST', 'unsupported schemaVersion');
  }
  const scenarioId = nonEmpty(root.scenarioId, 'manifest.scenarioId');
  const marker = nonEmpty(root.marker, 'manifest.marker');
  if (!SCENARIO.test(scenarioId)) invalid('MANIFEST', 'scenarioId format is invalid');
  if (!MARKER.test(marker)) invalid('MANIFEST', 'marker format is invalid');
  const baseHost = nonEmpty(root.baseHost, 'manifest.baseHost');
  if (baseHost !== baseHost.toLowerCase() || /[:/]/.test(baseHost)) invalid('MANIFEST', 'baseHost must be a lowercase host without scheme or port');

  const reasons = object(root.adjustmentReasonIds, 'manifest.adjustmentReasonIds');
  exactKeys(reasons, ['add', 'remove'], 'manifest.adjustmentReasonIds');
  const products = object(root.products, 'manifest.products');
  const expandedTopology = root.schemaVersion === 'manufacturing-pick-batch-fixture-manifest/v2' ||
    'expandedSubassembly' in products;
  exactKeys(products, expandedTopology
    ? ['finishedComplete', 'finishedStaging', 'expandedSubassembly', 'serializedInput', 'bulkInput']
    : ['finishedComplete', 'finishedStaging', 'serializedInput', 'bulkInput'], 'manifest.products');
  const parsedProducts = {
    finishedComplete: parseProductIdentity(products.finishedComplete, 'manifest.products.finishedComplete', marker),
    finishedStaging: parseProductIdentity(products.finishedStaging, 'manifest.products.finishedStaging', marker),
    ...(expandedTopology ? {
      expandedSubassembly: parseProductIdentity(products.expandedSubassembly, 'manifest.products.expandedSubassembly', marker),
    } : {}),
    serializedInput: parseProductIdentity(products.serializedInput, 'manifest.products.serializedInput', marker),
    bulkInput: parseProductIdentity(products.bulkInput, 'manifest.products.bulkInput', marker),
  };
  unique(Object.values(parsedProducts).map((entry) => entry.name), 'product names');
  unique(Object.values(parsedProducts).map((entry) => entry.sku), 'product SKUs');

  if (!Array.isArray(root.serials) || root.serials.length !== 2) invalid('MANIFEST', 'serials must contain exactly two values');
  const serials = root.serials.map((entry, index) => nonEmpty(entry, `manifest.serials[${index}]`)) as [string, string];
  if (serials.some((entry) => !SERIAL.test(entry))) invalid('MANIFEST', 'serials must use the canary marker');
  unique(serials, 'serials');

  const quantities = object(root.quantities, 'manifest.quantities');
  exactKeys(quantities, ['serialized', 'bulk'], 'manifest.quantities');
  if (quantities.serialized !== '2' || quantities.bulk !== '4') invalid('MANIFEST', 'quantities must be exactly serialized=2 and bulk=4');

  const bomIds = object(root.itemBomIds, 'manifest.itemBomIds');
  exactKeys(bomIds, expandedTopology ? [
    'finishedCompleteSubassembly', 'finishedStagingSubassembly',
    'expandedSubassemblySerialized', 'expandedSubassemblyBulk',
  ] : [
    'finishedCompleteSerialized', 'finishedCompleteBulk',
    'finishedStagingSerialized', 'finishedStagingBulk',
  ], 'manifest.itemBomIds');
  const parsedBomIds = expandedTopology ? {
    finishedCompleteSubassembly: nonEmpty(bomIds.finishedCompleteSubassembly, 'manifest.itemBomIds.finishedCompleteSubassembly'),
    finishedStagingSubassembly: nonEmpty(bomIds.finishedStagingSubassembly, 'manifest.itemBomIds.finishedStagingSubassembly'),
    expandedSubassemblySerialized: nonEmpty(bomIds.expandedSubassemblySerialized, 'manifest.itemBomIds.expandedSubassemblySerialized'),
    expandedSubassemblyBulk: nonEmpty(bomIds.expandedSubassemblyBulk, 'manifest.itemBomIds.expandedSubassemblyBulk'),
  } : {
    finishedCompleteSerialized: nonEmpty(bomIds.finishedCompleteSerialized, 'manifest.itemBomIds.finishedCompleteSerialized'),
    finishedCompleteBulk: nonEmpty(bomIds.finishedCompleteBulk, 'manifest.itemBomIds.finishedCompleteBulk'),
    finishedStagingSerialized: nonEmpty(bomIds.finishedStagingSerialized, 'manifest.itemBomIds.finishedStagingSerialized'),
    finishedStagingBulk: nonEmpty(bomIds.finishedStagingBulk, 'manifest.itemBomIds.finishedStagingBulk'),
  };
  const operationId = nonEmpty(root.productOperationId, 'manifest.productOperationId');
  const adjustments = object(root.stockAdjustmentIds, 'manifest.stockAdjustmentIds');
  exactKeys(adjustments, ['seed', 'reversal'], 'manifest.stockAdjustmentIds');
  const adjustmentIds = {
    seed: nonEmpty(adjustments.seed, 'manifest.stockAdjustmentIds.seed'),
    reversal: nonEmpty(adjustments.reversal, 'manifest.stockAdjustmentIds.reversal'),
  };
  const adjustmentItemIdsRaw = object(root.stockAdjustmentItemIds, 'manifest.stockAdjustmentItemIds');
  exactKeys(adjustmentItemIdsRaw, ['seedSerialized', 'seedBulk', 'reversalSerialized', 'reversalBulk'], 'manifest.stockAdjustmentItemIds');
  const adjustmentItemIds = {
    seedSerialized: nonEmpty(adjustmentItemIdsRaw.seedSerialized, 'manifest.stockAdjustmentItemIds.seedSerialized'),
    seedBulk: nonEmpty(adjustmentItemIdsRaw.seedBulk, 'manifest.stockAdjustmentItemIds.seedBulk'),
    reversalSerialized: nonEmpty(adjustmentItemIdsRaw.reversalSerialized, 'manifest.stockAdjustmentItemIds.reversalSerialized'),
    reversalBulk: nonEmpty(adjustmentItemIdsRaw.reversalBulk, 'manifest.stockAdjustmentItemIds.reversalBulk'),
  };
  const allDeterministicIds = [
    ...Object.values(parsedProducts).map((entry) => entry.productId),
    ...Object.values(parsedBomIds), operationId, adjustmentIds.seed, adjustmentIds.reversal,
    ...Object.values(adjustmentItemIds),
  ];
  if (allDeterministicIds.some((entry) => !UUID.test(entry))) invalid('MANIFEST', 'all planned object IDs must be deterministic UUIDs');
  unique(allDeterministicIds, 'planned object IDs');

  if (!Array.isArray(root.approvedInertArtifactIds)) invalid('MANIFEST', 'approvedInertArtifactIds must be an array');
  const approved = root.approvedInertArtifactIds.map((entry, index) => nonEmpty(entry, `manifest.approvedInertArtifactIds[${index}]`));
  unique(approved, 'approvedInertArtifactIds');
  const requiredApproved = [...Object.values(parsedProducts).map((entry) => entry.productId), adjustmentIds.seed, adjustmentIds.reversal].sort();
  if (stableStringify([...approved].sort()) !== stableStringify(requiredApproved)) {
    invalid('MANIFEST', `approvedInertArtifactIds must exactly equal the ${expandedTopology ? 'five' : 'four'} product and two stock-adjustment IDs`);
  }

  return {
    schemaVersion: root.schemaVersion,
    scenarioId,
    marker,
    tenantFingerprint: nonEmpty(root.tenantFingerprint, 'manifest.tenantFingerprint'),
    baseHost,
    apiVersion: nonEmpty(root.apiVersion, 'manifest.apiVersion'),
    probeBuild: nonEmpty(root.probeBuild, 'manifest.probeBuild'),
    adapterManifestHash: nonEmpty(root.adapterManifestHash, 'manifest.adapterManifestHash'),
    locationId: nonEmpty(root.locationId, 'manifest.locationId'),
    categoryId: nonEmpty(root.categoryId, 'manifest.categoryId'),
    adjustmentDate: iso(root.adjustmentDate, 'manifest.adjustmentDate'),
    adjustmentReasonIds: {
      add: nonEmpty(reasons.add, 'manifest.adjustmentReasonIds.add'),
      remove: nonEmpty(reasons.remove, 'manifest.adjustmentReasonIds.remove'),
    },
    operationTypeId: nonEmpty(root.operationTypeId, 'manifest.operationTypeId'),
    products: parsedProducts,
    serials,
    quantities: { serialized: '2', bulk: '4' },
    itemBomIds: parsedBomIds,
    productOperationId: operationId,
    stockAdjustmentIds: adjustmentIds,
    stockAdjustmentItemIds: adjustmentItemIds,
    approvedInertArtifactIds: approved,
  };
}

export function fixtureManifestHash(manifest: ManufacturingPickBatchFixtureManifest): string {
  const parsed = parseManufacturingPickBatchFixtureManifest(manifest);
  return canonicalHash(parsed, `${fixtureDomain(parsed)}:manifest`);
}

export function fixtureApprovalPlanHash(manifest: ManufacturingPickBatchFixtureManifest, stage: ManufacturingPickBatchFixtureStage): string {
  const parsed = parseManufacturingPickBatchFixtureManifest(manifest);
  return canonicalHash({ manifestHash: fixtureManifestHash(parsed), stage, intent: stageIntent(parsed, stage) }, `${fixtureDomain(parsed)}:stage-plan`);
}

function fixtureDomain(manifest: ManufacturingPickBatchFixtureManifest): string {
  return manifest.schemaVersion === 'manufacturing-pick-batch-fixture-manifest/v2'
    ? MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN
    : LEGACY_MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN;
}

export function parseManufacturingPickBatchFixtureApproval(
  value: unknown,
  manifest: ManufacturingPickBatchFixtureManifest,
  expectedStage: ManufacturingPickBatchFixtureStage,
  now = new Date(),
): ManufacturingPickBatchFixtureApproval {
  const approval = object(value, 'approval', 'APPROVAL');
  exactKeys(approval, [
    'schemaVersion', 'approved', 'stage', 'approvalNonce', 'manifestHash', 'stagePlanHash',
    'tenantFingerprint', 'baseHost', 'apiVersion', 'probeBuild', 'adapterManifestHash',
    'scenarioId', 'issuedAt', 'expiresAt',
  ], 'approval', 'APPROVAL');
  if (approval.schemaVersion !== 'manufacturing-pick-batch-fixture-approval/v1') invalid('APPROVAL', 'unsupported schemaVersion');
  if (approval.approved !== true) invalid('APPROVAL', 'approved must be true');
  if (approval.stage !== expectedStage) invalid('APPROVAL', `stage must be ${expectedStage}`);
  const bindings: Array<[keyof ManufacturingPickBatchFixtureManifest, unknown]> = [
    ['tenantFingerprint', approval.tenantFingerprint], ['baseHost', approval.baseHost],
    ['apiVersion', approval.apiVersion], ['probeBuild', approval.probeBuild],
    ['adapterManifestHash', approval.adapterManifestHash], ['scenarioId', approval.scenarioId],
  ];
  for (const [key, actual] of bindings) {
    if (actual !== manifest[key]) invalid('APPROVAL', `${String(key)} does not match the manifest`);
  }
  if (approval.manifestHash !== fixtureManifestHash(manifest)) invalid('APPROVAL', 'manifestHash does not match');
  if (approval.stagePlanHash !== fixtureApprovalPlanHash(manifest, expectedStage)) invalid('APPROVAL', 'stagePlanHash does not match');
  const issuedAt = iso(approval.issuedAt, 'approval.issuedAt', 'APPROVAL');
  const expiresAt = iso(approval.expiresAt, 'approval.expiresAt', 'APPROVAL');
  if (new Date(issuedAt).getTime() > now.getTime()) invalid('APPROVAL', 'approval is not yet valid');
  if (new Date(expiresAt).getTime() <= now.getTime()) invalid('APPROVAL', 'approval is expired');
  return {
    schemaVersion: 'manufacturing-pick-batch-fixture-approval/v1',
    approved: true,
    stage: expectedStage,
    approvalNonce: nonEmpty(approval.approvalNonce, 'approval.approvalNonce', 'APPROVAL'),
    manifestHash: approval.manifestHash as string,
    stagePlanHash: approval.stagePlanHash as string,
    tenantFingerprint: approval.tenantFingerprint as string,
    baseHost: approval.baseHost as string,
    apiVersion: approval.apiVersion as string,
    probeBuild: approval.probeBuild as string,
    adapterManifestHash: approval.adapterManifestHash as string,
    scenarioId: approval.scenarioId as string,
    issuedAt,
    expiresAt,
  };
}

function assertRuntimeIdentity(manifest: ManufacturingPickBatchFixtureManifest, identity: ManufacturingPickBatchFixtureRuntimeIdentity): void {
  for (const key of ['tenantFingerprint', 'baseHost', 'apiVersion', 'probeBuild', 'adapterManifestHash'] as const) {
    if (identity[key] !== manifest[key]) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_RUNTIME_IDENTITY_MISMATCH: ${key}`);
  }
}

function productRoleEntries(manifest: ManufacturingPickBatchFixtureManifest) {
  return Object.entries(manifest.products) as Array<[keyof ManufacturingPickBatchFixtureManifest['products'], ManufacturingPickBatchFixtureProductIdentity]>;
}

function configuredProductRoles(manifest: ManufacturingPickBatchFixtureManifest) {
  return manifest.products.expandedSubassembly
    ? (['finishedComplete', 'finishedStaging', 'expandedSubassembly'] as const)
    : (['finishedComplete', 'finishedStaging'] as const);
}

function topologyValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_TOPOLOGY_INVALID: ${label}`);
  return value;
}

function desiredProduct(manifest: ManufacturingPickBatchFixtureManifest, role: keyof ManufacturingPickBatchFixtureManifest['products']): Product {
  const identity = manifest.products[role];
  if (!identity) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_TOPOLOGY_INVALID: product:${String(role)}`);
  const serialized = role === 'finishedComplete' || role === 'finishedStaging' || role === 'serializedInput';
  return {
    productId: identity.productId,
    name: identity.name,
    sku: identity.sku,
    itemType: 'StockedProduct',
    categoryId: manifest.categoryId,
    isActive: true,
    trackSerials: serialized,
    autoAssemble: false,
    includeQuantityBuildable: false,
    itemBoms: [],
    productOperations: [],
    customFields: {
      custom1: manifest.marker,
      custom2: manifest.scenarioId,
    },
  } as Product;
}

function bomRows(manifest: ManufacturingPickBatchFixtureManifest, role: 'finishedComplete' | 'finishedStaging' | 'expandedSubassembly') {
  const parent = manifest.products[role];
  if (!parent) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_TOPOLOGY_INVALID: product:${role}`);
  const parentId = parent.productId;
  if (role === 'expandedSubassembly') {
    const expandedSubassembly = manifest.products.expandedSubassembly;
    if (!expandedSubassembly) {
      throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_TOPOLOGY_INVALID: expandedSubassembly');
    }
    return [
      {
        itemBomId: topologyValue(manifest.itemBomIds.expandedSubassemblySerialized, 'expandedSubassemblySerialized'),
        productId: parentId,
        childProductId: manifest.products.serializedInput.productId,
        quantity: { standardQuantity: '1', uomQuantity: '1' },
      },
      {
        itemBomId: topologyValue(manifest.itemBomIds.expandedSubassemblyBulk, 'expandedSubassemblyBulk'),
        productId: parentId,
        childProductId: manifest.products.bulkInput.productId,
        quantity: { standardQuantity: '2', uomQuantity: '2' },
      },
    ];
  }
  if (!manifest.products.expandedSubassembly) {
    return [
      {
        itemBomId: topologyValue(role === 'finishedComplete'
          ? manifest.itemBomIds.finishedCompleteSerialized
          : manifest.itemBomIds.finishedStagingSerialized, `${role}Serialized`),
        productId: parentId,
        childProductId: manifest.products.serializedInput.productId,
        quantity: { standardQuantity: '1', uomQuantity: '1' },
      },
      {
        itemBomId: topologyValue(role === 'finishedComplete'
          ? manifest.itemBomIds.finishedCompleteBulk
          : manifest.itemBomIds.finishedStagingBulk, `${role}Bulk`),
        productId: parentId,
        childProductId: manifest.products.bulkInput.productId,
        quantity: { standardQuantity: '2', uomQuantity: '2' },
      },
    ];
  }
  const expandedSubassembly = manifest.products.expandedSubassembly;
  if (!expandedSubassembly) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_TOPOLOGY_INVALID: expandedSubassembly');
  return [
    {
      itemBomId: role === 'finishedComplete'
        ? topologyValue(manifest.itemBomIds.finishedCompleteSubassembly, 'finishedCompleteSubassembly')
        : topologyValue(manifest.itemBomIds.finishedStagingSubassembly, 'finishedStagingSubassembly'),
      productId: parentId,
      childProductId: expandedSubassembly.productId,
      quantity: { standardQuantity: '1', uomQuantity: '1' },
    },
  ];
}

function operationRows(manifest: ManufacturingPickBatchFixtureManifest, role: 'finishedComplete' | 'finishedStaging' | 'expandedSubassembly') {
  return role !== 'finishedStaging' ? [] : [{
    productOperationId: manifest.productOperationId,
    productId: manifest.products.finishedStaging.productId,
    operationTypeId: manifest.operationTypeId,
    lineNum: 1,
    trackTime: true,
  }];
}

function stockAdjustmentRequest(manifest: ManufacturingPickBatchFixtureManifest, direction: 'seed' | 'reversal') {
  const seed = direction === 'seed';
  return {
    stockAdjustmentId: seed ? manifest.stockAdjustmentIds.seed : manifest.stockAdjustmentIds.reversal,
    date: manifest.adjustmentDate,
    locationId: manifest.locationId,
    adjustmentReasonId: seed ? manifest.adjustmentReasonIds.add : manifest.adjustmentReasonIds.remove,
    lines: [
      {
        stockAdjustmentLineId: seed ? manifest.stockAdjustmentItemIds.seedSerialized : manifest.stockAdjustmentItemIds.reversalSerialized,
        productId: manifest.products.serializedInput.productId,
        quantity: {
          standardQuantity: seed ? '2' : '-2',
          uomQuantity: seed ? '2' : '-2',
          uom: '',
          serialNumbers: [...manifest.serials],
        },
      },
      {
        stockAdjustmentLineId: seed ? manifest.stockAdjustmentItemIds.seedBulk : manifest.stockAdjustmentItemIds.reversalBulk,
        productId: manifest.products.bulkInput.productId,
        quantity: {
          standardQuantity: seed ? '4' : '-4',
          uomQuantity: seed ? '4' : '-4',
          uom: '',
          serialNumbers: [],
        },
      },
    ],
    remarks: `${manifest.marker} ${direction}`,
    customFields: {
      custom1: manifest.marker,
      custom2: manifest.scenarioId,
      custom3: direction,
    },
  };
}

function stageIntent(manifest: ManufacturingPickBatchFixtureManifest, stage: ManufacturingPickBatchFixtureStage): unknown {
  switch (stage) {
    case 'create-products':
      return productRoleEntries(manifest).map(([role]) => desiredProduct(manifest, role));
    case 'configure-products':
      return configuredProductRoles(manifest).map((role) => ({
        productId: manifest.products[role]!.productId,
        itemBoms: bomRows(manifest, role),
        productOperations: operationRows(manifest, role),
      }));
    case 'seed-stock': return stockAdjustmentRequest(manifest, 'seed');
    case 'reverse-stock': return stockAdjustmentRequest(manifest, 'reversal');
    case 'clear-config':
      return configuredProductRoles(manifest).map((role) => ({ productId: manifest.products[role]!.productId, itemBoms: [], productOperations: [] }));
    case 'deactivate-products':
      return productRoleEntries(manifest).map(([, identity]) => ({ productId: identity.productId, isActive: false }));
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { statusCode?: number }).statusCode === 404);
}

function unwrap<T>(value: T | { data: T }): T {
  return value && typeof value === 'object' && 'data' in value ? (value as { data: T }).data : value as T;
}

async function readProduct(client: ManufacturingPickBatchFixtureClient, productId: string): Promise<Product | undefined> {
  try {
    const result = await client.get<Product | { data: Product }>(`/products/${productId}`, { include: [...PRODUCT_INCLUDE] });
    return unwrap(result);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function requireProductReadback(product: Product | undefined, productId: string): Product {
  if (!product) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_READBACK_MISSING: product:${productId}`);
  const productRecord = product as Product & { itemType?: string };
  const requiredStrings = ['productId', 'name', 'sku', 'categoryId', 'timestamp', 'itemType'] as const;
  for (const field of requiredStrings) if (typeof productRecord[field] !== 'string' || !productRecord[field]) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: product.${String(field)}`);
  for (const field of ['isActive', 'trackSerials', 'autoAssemble', 'includeQuantityBuildable'] as const) {
    if (typeof product[field] !== 'boolean') throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: product.${field}`);
  }
  for (const field of ['itemBoms', 'productOperations', 'inventoryLines'] as const) {
    if (!Array.isArray(product[field])) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: product.${field}`);
  }
  if (!product.customFields || typeof product.customFields !== 'object' || Array.isArray(product.customFields)) {
    throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: product.customFields');
  }
  return product;
}

function projectProductCreation(product: Product) {
  const productRecord = product as Product & { itemType?: string };
  return {
    productId: product.productId,
    name: product.name,
    sku: product.sku,
    itemType: productRecord.itemType!.toLowerCase(),
    categoryId: product.categoryId,
    isActive: product.isActive,
    trackSerials: product.trackSerials,
    autoAssemble: product.autoAssemble,
    includeQuantityBuildable: product.includeQuantityBuildable,
    itemBoms: (product.itemBoms ?? []).map(projectBom).sort(sortByJson),
    productOperations: (product.productOperations ?? []).map(projectOperation).sort(sortByJson),
    customFields: {
      custom1: product.customFields?.custom1,
      custom2: product.customFields?.custom2,
    },
  };
}

function projectBom(row: NonNullable<Product['itemBoms']>[number]) {
  return {
    itemBomId: row.itemBomId,
    productId: row.productId,
    childProductId: row.childProductId,
    quantity: {
      standardQuantity: normalizeDecimal(row.quantity?.standardQuantity ?? '0'),
      uomQuantity: normalizeDecimal(row.quantity?.uomQuantity ?? row.quantity?.standardQuantity ?? '0'),
    },
  };
}

function projectOperation(row: NonNullable<Product['productOperations']>[number]) {
  return {
    productOperationId: row.productOperationId,
    productId: row.productId,
    operationTypeId: row.operationTypeId,
    lineNum: row.lineNum,
    trackTime: row.trackTime,
  };
}

function sortByJson(left: unknown, right: unknown): number {
  return stableStringify(left).localeCompare(stableStringify(right));
}

function exactProductCreation(actual: Product | undefined, desired: Product): boolean {
  if (!actual) return false;
  const complete = requireProductReadback(actual, desired.productId!);
  return stableStringify(projectProductCreation(complete)) === stableStringify(projectProductCreation(desired));
}

function exactConfig(actual: Product | undefined, desiredBoms: ReturnType<typeof bomRows>, desiredOperations: ReturnType<typeof operationRows>, requireManufacturable = false): boolean {
  if (!actual) return false;
  const complete = requireProductReadback(actual, actual?.productId ?? 'unknown');
  if (requireManufacturable && complete.isManufacturable !== true) return false;
  if (complete.autoAssemble !== false || complete.includeQuantityBuildable !== false) return false;
  const actualProjection = {
    itemBoms: complete.itemBoms!.map(projectBom).sort(sortByJson),
    productOperations: complete.productOperations!.map(projectOperation).sort(sortByJson),
  };
  const desiredProjection = {
    itemBoms: desiredBoms.map(projectBom).sort(sortByJson),
    productOperations: desiredOperations.map(projectOperation).sort(sortByJson),
  };
  return stableStringify(actualProjection) === stableStringify(desiredProjection);
}

function exactDeactivated(actual: Product | undefined): boolean {
  if (!actual) return false;
  const complete = requireProductReadback(actual, actual?.productId ?? 'unknown');
  return complete.isActive === false && complete.itemBoms!.length === 0 && complete.productOperations!.length === 0;
}

function projectAdjustment(value: unknown) {
  const row = object(unwrap(value as JsonObject | { data: JsonObject }), 'stock-adjustment');
  for (const field of ['stockAdjustmentId', 'date', 'locationId', 'adjustmentReasonId', 'remarks'] as const) nonEmpty(row[field], `stock-adjustment.${field}`);
  if (!row.customFields || typeof row.customFields !== 'object' || Array.isArray(row.customFields)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: stock-adjustment.customFields');
  const lines = Array.isArray(row.lines) ? row.lines : Array.isArray(row.items) ? row.items : undefined;
  if (!lines) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: stock-adjustment.lines');
  const projectedLines = lines.map((value, index) => {
    const line = object(value, `stock-adjustment.lines[${index}]`);
    const lineIdValue = line.stockAdjustmentLineId ?? line.id;
    if (typeof lineIdValue !== 'string' || !lineIdValue.trim() || lineIdValue.trim() !== lineIdValue) {
      throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: stock-adjustment.lines[${index}].id`);
    }
    const quantityValue = line.quantity;
    const nestedQuantity = quantityValue && typeof quantityValue === 'object' && !Array.isArray(quantityValue)
      ? quantityValue as JsonObject
      : undefined;
    const standardQuantity = nestedQuantity?.standardQuantity ?? quantityValue;
    if (typeof standardQuantity !== 'string' && typeof standardQuantity !== 'number') throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: stock-adjustment line quantity');
    const serialNumbers = nestedQuantity?.serialNumbers ?? line.serialNumbers;
    if (!Array.isArray(serialNumbers) || serialNumbers.some((serial) => typeof serial !== 'string')) {
      throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: stock-adjustment line serialNumbers');
    }
    return {
      providerLineId: lineIdValue,
      semantic: {
        productId: nonEmpty(line.productId, `stock-adjustment.lines[${index}].productId`),
        quantity: normalizeDecimal(standardQuantity),
        serialNumbers: [...serialNumbers].sort(),
      },
    };
  });
  if (new Set(projectedLines.map((line) => line.providerLineId)).size !== projectedLines.length) {
    throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: duplicate stock-adjustment line IDs');
  }
  return {
    stockAdjustmentId: row.stockAdjustmentId,
    date: normalizedInstant(row.date, 'stock-adjustment.date'),
    locationId: row.locationId,
    adjustmentReasonId: row.adjustmentReasonId,
    lines: projectedLines.map((line) => line.semantic).sort(sortByJson),
    remarks: row.remarks,
    customFields: {
      custom1: (row.customFields as JsonObject).custom1,
      custom2: (row.customFields as JsonObject).custom2,
      custom3: (row.customFields as JsonObject).custom3,
    },
  };
}

async function readAdjustment(client: ManufacturingPickBatchFixtureClient, id: string): Promise<unknown | undefined> {
  try {
    return await client.get(`/stock-adjustments/${id}`, { include: ['lines'] });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function exactAdjustment(actual: unknown | undefined, desired: ReturnType<typeof stockAdjustmentRequest>): boolean {
  if (!actual) return false;
  return stableStringify(projectAdjustment(actual)) === stableStringify(projectAdjustment(desired));
}

async function captureStock(client: ManufacturingPickBatchFixtureClient, manifest: ManufacturingPickBatchFixtureManifest): Promise<FixtureStockProjection> {
  const productIds = [manifest.products.serializedInput.productId, manifest.products.bulkInput.productId];
  const response = await client.postRead<Array<ProductSummary | { id?: string; attributes?: Partial<ProductSummary> }> | { data: Array<ProductSummary | { id?: string; attributes?: Partial<ProductSummary> }> }>(
    '/products/summary', productIds.map((productId) => ({ productId })),
  );
  const rows = unwrap(response);
  if (!Array.isArray(rows)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: inventory summary');
  const normalized = rows.map(normalizeProductSummary);
  if (normalized.length !== productIds.length || productIds.some((id) => !normalized.some((row) => row.productId === id))) {
    throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: inventory summary products');
  }
  const products = await Promise.all(productIds.map(async (id) => requireProductReadback(await readProduct(client, id), id)));
  const inventory = canonicalInventorySummaryProjection(normalized);
  for (const row of inventory) {
    const product = products.find((candidate) => candidate.productId === row.productId);
    if (!product) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: inventory lines ${row.productId}`);
    row.locations = inventoryLineLocations(product, row);
  }
  return {
    inventory,
    serials: canonicalSerialInventoryProjection(products, manifest.serials.map((serial) => ({ productId: manifest.products.serializedInput.productId, serial }))),
  };
}

function inventoryLineLocations(
  product: Product,
  summary: CanonicalInventorySummaryRow,
): CanonicalInventorySummaryRow['locations'] {
  const totals = new Map<string, ReturnType<typeof parseDecimal>>();
  for (const line of product.inventoryLines ?? []) {
    const locationId = line.locationId?.trim();
    if (!locationId) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_READBACK: inventory line location ${summary.productId}`);
    const quantity = parseDecimal(line.quantityOnHand ?? '0');
    totals.set(locationId, addDecimal(totals.get(locationId) ?? ZERO_DECIMAL, quantity));
  }
  const locations = [...totals.entries()]
    .map(([locationId, quantity]) => ({
      locationId,
      quantityOnHand: decimalToString(quantity),
      quantityAvailable: decimalToString(quantity),
      sublocations: [],
    }))
    .filter((location) => location.quantityOnHand !== '0')
    .sort((left, right) => left.locationId.localeCompare(right.locationId));
  const total = locations.reduce(
    (sum, location) => addDecimal(sum, parseDecimal(location.quantityOnHand)),
    ZERO_DECIMAL,
  );
  if (decimalToString(total) !== summary.quantityOnHand) {
    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_INVENTORY_LINE_TOTAL_MISMATCH: ${summary.productId}`);
  }
  return locations;
}

function requireZeroBaseline(projection: FixtureStockProjection): void {
  for (const row of projection.inventory) {
    if ([row.quantityOnHand, row.quantityAvailable, row.quantityOnOrder, row.quantityAllocated].some((value) => value !== '0')) {
      throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_NONZERO_BASELINE: ${row.productId}`);
    }
    if (row.locations.some((location) => location.quantityOnHand !== '0' || location.quantityAvailable !== '0' || location.sublocations.some((sub) => sub.quantityOnHand !== '0' || sub.quantityAvailable !== '0'))) {
      throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_NONZERO_BASELINE: ${row.productId}`);
    }
  }
  if (projection.serials.some((row) => row.holdings.length > 0)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_NONZERO_SERIAL_BASELINE');
}

function inputInventoryRow(
  projection: FixtureStockProjection,
  productId: string,
  label: string,
): FixtureStockProjection['inventory'][number] {
  const row = projection.inventory.find((candidate) => candidate.productId === productId);
  if (!row) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
  return row;
}

function assertInputStockOnHand(
  projection: FixtureStockProjection,
  manifest: ManufacturingPickBatchFixtureManifest,
  expected: { serialized: string; bulk: string },
  label: string,
): void {
  const expectations = [
    [manifest.products.serializedInput.productId, expected.serialized],
    [manifest.products.bulkInput.productId, expected.bulk],
  ] as const;
  for (const [productId, quantity] of expectations) {
    const row = inputInventoryRow(projection, productId, label);
    if (row.quantityOnHand !== quantity || row.quantityOnOrder !== '0' || row.quantityAllocated !== '0') {
      throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
    }
    const nonzeroLocations = row.locations.filter((location) => location.quantityOnHand !== '0');
    if (quantity === '0') {
      if (nonzeroLocations.length) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
      continue;
    }
    if (
      nonzeroLocations.length !== 1 ||
      nonzeroLocations[0]!.locationId !== manifest.locationId ||
      nonzeroLocations[0]!.quantityOnHand !== quantity ||
      nonzeroLocations[0]!.sublocations.some((sub) => sub.quantityOnHand !== '0')
    ) {
      throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
    }
  }
}

function assertSeededStock(
  projection: FixtureStockProjection,
  manifest: ManufacturingPickBatchFixtureManifest,
  label: string,
): void {
  assertInputStockOnHand(projection, manifest, { serialized: '2', bulk: '4' }, label);
  const serialProjection = stableStringify(projection.serials);
  const expectedSerials = stableStringify(manifest.serials.map((serial) => ({
    productId: manifest.products.serializedInput.productId,
    serial,
    holdings: [{ locationId: manifest.locationId, sublocation: '', quantityOnHand: '1' }],
  })).sort((left, right) => left.serial.localeCompare(right.serial)));
  if (serialProjection !== expectedSerials) {
    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
  }
}

function assertReversedStock(
  projection: FixtureStockProjection,
  manifest: ManufacturingPickBatchFixtureManifest,
  label: string,
): void {
  assertInputStockOnHand(projection, manifest, { serialized: '0', bulk: '0' }, label);
  if (projection.serials.some((row) => row.holdings.length > 0)) {
    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
  }
}

function assertExactStock(actual: FixtureStockProjection, expected: FixtureStockProjection, label: string): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_MISMATCH: ${label}`);
  }
}

function checkpointPath(stateDir: string): string {
  return join(stateDir, MANUFACTURING_PICK_BATCH_FIXTURE_STATE_FILE);
}

async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_STATE_DIR_MUST_BE_ABSOLUTE');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_STATE_DIR_UNSAFE');
  if ((info.mode & 0o077) !== 0) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_STATE_DIR_NOT_OWNER_ONLY');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_STATE_DIR_NOT_OWNED');
}

async function assertOwnerOnlyFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CHECKPOINT_NOT_OWNER_ONLY');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CHECKPOINT_NOT_OWNED');
}

async function writeCheckpoint(path: string, checkpoint: FixtureCheckpoint): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${stableStringify(checkpoint)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readCheckpoint(path: string): Promise<FixtureCheckpoint | undefined> {
  try {
    await assertOwnerOnlyFile(path);
    const value = JSON.parse(await readFile(path, 'utf8')) as FixtureCheckpoint;
    const root = object(value, 'checkpoint', 'CHECKPOINT');
    const allowed = ['schemaVersion', 'ownerId', 'manifestHash', 'stage', 'completedMutationHashes', 'inFlight', 'stockBaseline', 'seededStock', 'updatedAt'];
    const extra = Object.keys(root).find((key) => !allowed.includes(key));
    if (extra) invalid('CHECKPOINT', `checkpoint.${extra} is not allowed`);
    for (const required of ['schemaVersion', 'ownerId', 'manifestHash', 'stage', 'completedMutationHashes', 'updatedAt']) {
      if (!(required in root)) invalid('CHECKPOINT', `checkpoint.${required} is required`);
    }
    if (value.schemaVersion !== 'manufacturing-pick-batch-fixture-checkpoint/v1' || !Array.isArray(value.completedMutationHashes)) invalid('CHECKPOINT', 'invalid shape');
    const stages: FixtureCheckpointStage[] = ['planned', 'products-created', 'configured', 'stock-seeded', 'handoff-complete', 'stock-reversed', 'config-cleared', 'deactivated', 'complete'];
    if (!stages.includes(value.stage)) invalid('CHECKPOINT', 'checkpoint.stage is invalid');
    nonEmpty(value.ownerId, 'checkpoint.ownerId', 'CHECKPOINT');
    if (!/^[0-9a-f]{64}$/.test(value.manifestHash)) invalid('CHECKPOINT', 'checkpoint.manifestHash is invalid');
    if (value.completedMutationHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) || new Set(value.completedMutationHashes).size !== value.completedMutationHashes.length) invalid('CHECKPOINT', 'completedMutationHashes are invalid');
    iso(value.updatedAt, 'checkpoint.updatedAt', 'APPROVAL');
    if (value.inFlight) {
      const inFlight = object(value.inFlight, 'checkpoint.inFlight', 'CHECKPOINT');
      const expectedKeys = value.inFlight.correlationId === undefined
        ? ['stage', 'mutationIndex', 'requestHash', 'path', 'dispatchState']
        : ['stage', 'mutationIndex', 'requestHash', 'path', 'dispatchState', 'correlationId'];
      exactKeys(inFlight, expectedKeys, 'checkpoint.inFlight', 'CHECKPOINT');
      const mutationStages: ManufacturingPickBatchFixtureStage[] = ['create-products', 'configure-products', 'seed-stock', 'reverse-stock', 'clear-config', 'deactivate-products'];
      if (!mutationStages.includes(value.inFlight.stage) || !Number.isInteger(value.inFlight.mutationIndex) || value.inFlight.mutationIndex < 0 || !/^[0-9a-f]{64}$/.test(value.inFlight.requestHash) || !['/products', '/stock-adjustments'].includes(value.inFlight.path) || !['armed', 'dispatching'].includes(value.inFlight.dispatchState)) invalid('CHECKPOINT', 'checkpoint.inFlight is invalid');
      if (value.inFlight.dispatchState === 'armed' && value.inFlight.correlationId !== undefined) invalid('CHECKPOINT', 'armed mutation cannot have correlationId');
      if (value.inFlight.dispatchState === 'dispatching' && !value.inFlight.correlationId) invalid('CHECKPOINT', 'dispatching mutation requires correlationId');
    }
    return value;
  } catch (error) {
    if (isNotFound(error) || (error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT')) return undefined;
    throw error;
  }
}

export function parseManufacturingPickBatchFixtureCommandArguments(argv: string[]): ManufacturingPickBatchFixtureCliArguments {
  const allowed = new Set(['--command', '--manifest', '--approval', '--state-dir', '--owner-id']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag)) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: unsupported flag ${flag ?? '<missing>'}`);
    if (!value || value.startsWith('--')) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: ${flag} requires a value`);
    if (values.has(flag)) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: duplicate ${flag}`);
    values.set(flag, value);
  }
  const command = values.get('--command') as ManufacturingPickBatchFixtureCommand | undefined;
  const commands: ManufacturingPickBatchFixtureCommand[] = ['plan', 'create-products', 'configure-products', 'seed-stock', 'handoff', 'reverse-stock', 'clear-config', 'deactivate-products', 'verify-cleanup', 'status'];
  if (!command || !commands.includes(command)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: command is required');
  const manifestPath = values.get('--manifest');
  const stateDir = values.get('--state-dir');
  const ownerId = values.get('--owner-id');
  if (!manifestPath || !isAbsolute(manifestPath) || !stateDir || !isAbsolute(stateDir) || !ownerId) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: absolute manifest/state-dir and owner-id are required');
  const approvalPath = values.get('--approval');
  const mutation = !['plan', 'handoff', 'verify-cleanup', 'status'].includes(command);
  if (mutation !== Boolean(approvalPath)) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: ${mutation ? 'approval is required' : 'approval is not allowed'} for ${command}`);
  if (approvalPath && !isAbsolute(approvalPath)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CLI_INVALID: approval path must be absolute');
  return { command, manifestPath, ...(approvalPath ? { approvalPath } : {}), stateDir, ownerId };
}

export async function runManufacturingPickBatchFixtureCommandFromEnvironment(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  client: ManufacturingPickBatchFixtureClient;
  now?: Date;
}): Promise<ManufacturingPickBatchFixtureCommandResult> {
  const args = parseManufacturingPickBatchFixtureCommandArguments(input.argv);
  const requiredEnv = (key: string): string => {
    const value = input.env[key];
    if (!value) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_ENV_INVALID: ${key} is required`);
    return value;
  };
  const manifest = JSON.parse(await readFile(args.manifestPath, 'utf8')) as unknown;
  const approval = args.approvalPath ? JSON.parse(await readFile(args.approvalPath, 'utf8')) as unknown : undefined;
  return runManufacturingPickBatchFixtureCommand({
    command: args.command,
    manifest,
    ...(approval !== undefined ? { approval } : {}),
    client: input.client,
    stateDir: args.stateDir,
    ownerId: args.ownerId,
    runtimeIdentity: {
      tenantFingerprint: requiredEnv('INFLOW_TENANT_FINGERPRINT'),
      baseHost: requiredEnv('INFLOW_BASE_HOST'),
      apiVersion: requiredEnv('INFLOW_API_VERSION'),
      probeBuild: requiredEnv('INFLOW_PROBE_BUILD'),
      adapterManifestHash: requiredEnv('INFLOW_ADAPTER_MANIFEST_HASH'),
    },
    now: input.now,
  });
}

async function withLock<T>(input: ManufacturingPickBatchFixtureCommandInput, run: () => Promise<T>): Promise<T> {
  await ensureOwnerOnlyDirectory(input.stateDir);
  const path = join(input.stateDir, 'manufacturing-pick-batch-fixtures.lock');
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_LOCKED');
    throw error;
  }
  try {
    await handle.writeFile(`${input.ownerId}\n`, 'utf8');
    await handle.sync();
    await chmod(path, 0o600);
    await input.hooks?.lockAcquired?.(path);
    return await run();
  } finally {
    await handle.close();
    await unlink(path).catch(() => undefined);
  }
}

interface PlannedMutation {
  stage: ManufacturingPickBatchFixtureStage;
  index: number;
  path: string;
  body: unknown;
  readExact(): Promise<boolean>;
}

async function dispatchOnce(
  client: ManufacturingPickBatchFixtureClient,
  path: string,
  checkpoint: FixtureCheckpoint,
  persist: () => Promise<void>,
  mutation: PlannedMutation,
  hooks: ManufacturingPickBatchFixtureCommandInput['hooks'],
  requestDomain: string,
): Promise<void> {
  const body = mutation.body && typeof mutation.body === 'object' && !Array.isArray(mutation.body)
    ? Object.fromEntries(Object.entries(mutation.body as JsonObject).filter(([key]) => key !== 'timestamp'))
    : mutation.body;
  const requestHash = canonicalHash({ stage: mutation.stage, mutationIndex: mutation.index, method: 'PUT', path: mutation.path, body }, `${requestDomain}:request`);
  if (checkpoint.completedMutationHashes.includes(requestHash)) {
    if (!(await mutation.readExact())) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_COMPLETED_MUTATION_DRIFT');
    return;
  }
  if (checkpoint.inFlight) {
    const expected = checkpoint.inFlight;
    if (expected.stage !== mutation.stage || expected.mutationIndex !== mutation.index || expected.requestHash !== requestHash || expected.path !== mutation.path) {
      throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_IN_FLIGHT_MISMATCH');
    }
    if (await mutation.readExact()) {
      checkpoint.completedMutationHashes.push(requestHash);
      delete checkpoint.inFlight;
      await persist();
      return;
    }
    throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_AMBIGUOUS_WRITE_NOT_APPLIED_NO_RETRY');
  }
  if (await mutation.readExact()) {
    checkpoint.completedMutationHashes.push(requestHash);
    await persist();
    return;
  }
  checkpoint.inFlight = { stage: mutation.stage, mutationIndex: mutation.index, requestHash, path: mutation.path, dispatchState: 'armed' };
  await persist();
  const prepared = await client.prepareMutation<unknown>('PUT', path, { body: mutation.body });
  checkpoint.inFlight = { ...checkpoint.inFlight, dispatchState: 'dispatching', correlationId: prepared.correlationId };
  await persist();
  await hooks?.beforeDispatch?.(checkpoint.inFlight);
  try {
    await prepared.dispatch();
  } catch (error) {
    if (!(await mutation.readExact())) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_AMBIGUOUS_WRITE: ${(error as Error).message}`);
  }
  if (!(await mutation.readExact())) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PARTIAL_OR_MISSING_READBACK');
  checkpoint.completedMutationHashes.push(requestHash);
  delete checkpoint.inFlight;
  await persist();
}

async function discoverMarkerArtifacts(client: ManufacturingPickBatchFixtureClient, manifest: ManufacturingPickBatchFixtureManifest): Promise<{
  productIds: string[];
  adjustmentIds: string[];
}> {
  let productRows: JsonObject[];
  let adjustmentRows: JsonObject[];
  try {
    // The live API has no proven custom-field equality filter. A full paged
    // candidate scan is therefore required before exact client-side marker
    // equality, otherwise a customFields-only residual could be invisible.
    // Both live collection endpoints already return customFields in their
    // default projection. Passing include=customFields is rejected by inFlow
    // with HTTP 400 on these list routes, so keep the full candidate scan on
    // the provider-supported default projection.
    productRows = await listAllCandidates(client, '/products');
    adjustmentRows = await listAllCandidates(client, '/stock-adjustments');
  } catch (error) {
    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_RESIDUAL_DISCOVERY_UNAVAILABLE: ${(error as Error).message}`);
  }
  if (!Array.isArray(productRows) || !Array.isArray(adjustmentRows)) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_RESIDUAL_DISCOVERY_PARTIAL');
  const productIds = productRows.filter((row) => {
    const custom = row.customFields && typeof row.customFields === 'object' && !Array.isArray(row.customFields) ? row.customFields as JsonObject : {};
    return custom.custom1 === manifest.marker ||
      (typeof row.name === 'string' && row.name.startsWith(`${manifest.marker} `));
  }).map((row) => nonEmpty(row.productId ?? row.id, 'discovered product ID'));
  const adjustmentIds = adjustmentRows.filter((row) => {
    const custom = row.customFields && typeof row.customFields === 'object' && !Array.isArray(row.customFields) ? row.customFields as JsonObject : {};
    return custom.custom1 === manifest.marker ||
      (typeof row.remarks === 'string' && row.remarks.startsWith(`${manifest.marker} `));
  }).map((row) => nonEmpty(row.stockAdjustmentId ?? row.id, 'discovered adjustment ID'));
  const approvedProducts = new Set(productRoleEntries(manifest).map(([, product]) => product.productId));
  const approvedAdjustments = new Set(Object.values(manifest.stockAdjustmentIds));
  const unexpected = [...productIds.filter((id) => !approvedProducts.has(id)), ...adjustmentIds.filter((id) => !approvedAdjustments.has(id))];
  if (unexpected.length) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_UNEXPECTED_MARKER_ARTIFACTS: ${unexpected.sort().join(',')}`);
  return { productIds: [...new Set(productIds)].sort(), adjustmentIds: [...new Set(adjustmentIds)].sort() };
}

async function listAllCandidates(
  client: ManufacturingPickBatchFixtureClient,
  path: '/products' | '/stock-adjustments',
  include?: string[],
  filters?: Record<string, string>,
): Promise<JsonObject[]> {
  const rows: JsonObject[] = [];
  const count = 100;
  for (let skip = 0; skip < 10_000;) {
    const response = await client.getList<JsonObject>(path, {
      pagination: { skip, count },
      ...(include?.length ? { include } : {}),
      ...(filters ? { filters } : {}),
      includeCount: true,
    });
    if (!Array.isArray(response.data)) throw new Error(`partial ${path} candidate page`);
    if (response.data.length === 0) {
      if (response.totalCount !== undefined && rows.length < response.totalCount) throw new Error(`incomplete ${path} candidate scan`);
      return rows;
    }
    rows.push(...response.data);
    if (response.totalCount !== undefined) {
      if (!Number.isSafeInteger(response.totalCount) || response.totalCount < 0 || rows.length > response.totalCount) throw new Error(`invalid ${path} candidate count`);
      if (rows.length === response.totalCount) return rows;
    } else if (response.data.length < count) {
      return rows;
    }
    skip = rows.length;
  }
  throw new Error(`candidate scan exceeded safety cap for ${path}`);
}

function assertStage(checkpoint: FixtureCheckpoint, expected: FixtureCheckpointStage): void {
  if (checkpoint.stage !== expected) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_STAGE_MISMATCH: expected ${expected}, got ${checkpoint.stage}`);
}

function nextApproval(manifest: ManufacturingPickBatchFixtureManifest, stage: ManufacturingPickBatchFixtureStage) {
  return { stage, stagePlanHash: fixtureApprovalPlanHash(manifest, stage) };
}

export async function runManufacturingPickBatchFixtureCommand(input: ManufacturingPickBatchFixtureCommandInput): Promise<ManufacturingPickBatchFixtureCommandResult> {
  const manifest = parseManufacturingPickBatchFixtureManifest(input.manifest);
  assertRuntimeIdentity(manifest, input.runtimeIdentity);
  if (!input.ownerId || input.ownerId.trim() !== input.ownerId) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_OWNER_INVALID');
  const now = input.now ?? new Date();
  return withLock(input, async () => {
    const path = checkpointPath(input.stateDir);
    let checkpoint = await readCheckpoint(path);
    const manifestHash = fixtureManifestHash(manifest);
    if (checkpoint && (checkpoint.ownerId !== input.ownerId || checkpoint.manifestHash !== manifestHash)) {
      throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CHECKPOINT_BINDING_MISMATCH');
    }
    const persist = async () => {
      if (!checkpoint) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_CHECKPOINT_MISSING');
      checkpoint.updatedAt = now.toISOString();
      await writeCheckpoint(path, checkpoint);
      await input.hooks?.checkpointDurable?.(path);
    };

    if (input.command === 'plan') {
      if (checkpoint && checkpoint.stage !== 'planned') throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_ALREADY_STARTED');
      const discovered = await discoverMarkerArtifacts(input.client, manifest);
      const directProducts = await Promise.all(productRoleEntries(manifest).map(([, product]) => readProduct(input.client, product.productId)));
      const directAdjustments = await Promise.all(Object.values(manifest.stockAdjustmentIds).map((id) => readAdjustment(input.client, id)));
      if (discovered.productIds.length || discovered.adjustmentIds.length || directProducts.some(Boolean) || directAdjustments.some(Boolean)) {
        throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PREFLIGHT_ARTIFACT_EXISTS');
      }
      checkpoint ??= {
        schemaVersion: 'manufacturing-pick-batch-fixture-checkpoint/v1', ownerId: input.ownerId,
        manifestHash, stage: 'planned', completedMutationHashes: [], updatedAt: now.toISOString(),
      };
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'create-products') });
    }

    if (!checkpoint) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_PLAN_REQUIRED');
    if (input.command === 'status') return result(input.command, checkpoint, manifest);

    if (input.command === 'create-products') {
      assertStage(checkpoint, 'planned');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      for (const [index, [role, identity]] of productRoleEntries(manifest).entries()) {
        const body = desiredProduct(manifest, role);
        await dispatchOnce(input.client, '/products', checkpoint, persist, {
          stage: input.command, index, path: '/products', body,
          readExact: async () => exactProductCreation(await readProduct(input.client, identity.productId), body),
        }, input.hooks, fixtureDomain(manifest));
      }
      checkpoint.stockBaseline = await captureStock(input.client, manifest);
      requireZeroBaseline(checkpoint.stockBaseline);
      checkpoint.stage = 'products-created';
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'configure-products') });
    }

    if (input.command === 'configure-products') {
      assertStage(checkpoint, 'products-created');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      for (const [index, role] of configuredProductRoles(manifest).entries()) {
        const identity = manifest.products[role]!;
        const current = requireProductReadback(await readProduct(input.client, identity.productId), identity.productId);
        const boms = bomRows(manifest, role);
        const operations = operationRows(manifest, role);
        const body = { productId: current.productId, timestamp: current.timestamp, itemBoms: boms, productOperations: operations };
        await dispatchOnce(input.client, '/products', checkpoint, persist, {
          stage: input.command, index, path: '/products', body,
          readExact: async () => exactConfig(await readProduct(input.client, identity.productId), boms, operations, true),
        }, input.hooks, fixtureDomain(manifest));
      }
      checkpoint.stage = 'configured';
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'seed-stock') });
    }

    if (input.command === 'seed-stock') {
      assertStage(checkpoint, 'configured');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      if (!checkpoint.stockBaseline) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_BASELINE_MISSING');
      const body = stockAdjustmentRequest(manifest, 'seed');
      requireZeroBaseline(checkpoint.stockBaseline);
      const recoveringAppliedSeed = checkpoint.inFlight?.stage === input.command &&
        checkpoint.inFlight.mutationIndex === 0;
      if (!recoveringAppliedSeed) {
        const existingSeed = await readAdjustment(input.client, body.stockAdjustmentId);
        if (existingSeed) {
          if (!exactAdjustment(existingSeed, body)) {
            throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_EXISTING_SEED_MISMATCH');
          }
          assertSeededStock(await captureStock(input.client, manifest), manifest, 'existing seed recovery');
        } else {
          assertReversedStock(await captureStock(input.client, manifest), manifest, 'before seed');
        }
      }
      await dispatchOnce(input.client, '/stock-adjustments', checkpoint, persist, {
        stage: input.command, index: 0, path: '/stock-adjustments', body,
        readExact: async () => {
          if (!exactAdjustment(await readAdjustment(input.client, body.stockAdjustmentId), body)) return false;
          assertSeededStock(await captureStock(input.client, manifest), manifest, 'seed adjustment readback');
          return true;
        },
      }, input.hooks, fixtureDomain(manifest));
      checkpoint.seededStock = await captureStock(input.client, manifest);
      assertSeededStock(checkpoint.seededStock, manifest, 'after seed');
      checkpoint.stage = 'stock-seeded';
      await persist();
      return result(input.command, checkpoint, manifest);
    }

    if (input.command === 'handoff') {
      if (checkpoint.stage !== 'stock-seeded' && checkpoint.stage !== 'handoff-complete') assertStage(checkpoint, 'stock-seeded');
      if (!checkpoint.seededStock) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_SEEDED_PROJECTION_MISSING');
      assertExactStock(await captureStock(input.client, manifest), checkpoint.seededStock, 'main canary handoff');
      checkpoint.stage = 'handoff-complete';
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'reverse-stock') });
    }

    if (input.command === 'reverse-stock') {
      assertStage(checkpoint, 'handoff-complete');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      if (!checkpoint.stockBaseline || !checkpoint.seededStock) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_STOCK_PROJECTION_MISSING');
      const body = stockAdjustmentRequest(manifest, 'reversal');
      const recoveringAppliedReversal = checkpoint.inFlight?.stage === input.command &&
        checkpoint.inFlight.mutationIndex === 0;
      if (!recoveringAppliedReversal) {
        const existingReversal = await readAdjustment(input.client, body.stockAdjustmentId);
        if (existingReversal) {
          if (!exactAdjustment(existingReversal, body)) {
            throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_EXISTING_REVERSAL_MISMATCH');
          }
          assertReversedStock(await captureStock(input.client, manifest), manifest, 'existing reversal recovery');
        } else {
          assertExactStock(await captureStock(input.client, manifest), checkpoint.seededStock, 'before reversal');
        }
      }
      await dispatchOnce(input.client, '/stock-adjustments', checkpoint, persist, {
        stage: input.command, index: 0, path: '/stock-adjustments', body,
        readExact: async () => {
          if (!exactAdjustment(await readAdjustment(input.client, body.stockAdjustmentId), body)) return false;
          assertReversedStock(await captureStock(input.client, manifest), manifest, 'reversal adjustment readback');
          return true;
        },
      }, input.hooks, fixtureDomain(manifest));
      assertReversedStock(await captureStock(input.client, manifest), manifest, 'after reversal');
      checkpoint.stage = 'stock-reversed';
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'clear-config') });
    }

    if (input.command === 'clear-config') {
      assertStage(checkpoint, 'stock-reversed');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      for (const [index, role] of configuredProductRoles(manifest).entries()) {
        const identity = manifest.products[role]!;
        const current = requireProductReadback(await readProduct(input.client, identity.productId), identity.productId);
        const body = { productId: current.productId, timestamp: current.timestamp, itemBoms: [], productOperations: [] };
        await dispatchOnce(input.client, '/products', checkpoint, persist, {
          stage: input.command, index, path: '/products', body,
          readExact: async () => exactConfig(await readProduct(input.client, identity.productId), [], []),
        }, input.hooks, fixtureDomain(manifest));
      }
      if (!checkpoint.stockBaseline) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_BASELINE_MISSING');
      assertExactStock(await captureStock(input.client, manifest), checkpoint.stockBaseline, 'after config clear');
      checkpoint.stage = 'config-cleared';
      await persist();
      return result(input.command, checkpoint, manifest, { nextApproval: nextApproval(manifest, 'deactivate-products') });
    }

    if (input.command === 'deactivate-products') {
      assertStage(checkpoint, 'config-cleared');
      parseManufacturingPickBatchFixtureApproval(input.approval, manifest, input.command, now);
      for (const [index, [, identity]] of productRoleEntries(manifest).entries()) {
        const current = requireProductReadback(await readProduct(input.client, identity.productId), identity.productId);
        const body = { productId: identity.productId, timestamp: current.timestamp, isActive: false };
        await dispatchOnce(input.client, '/products', checkpoint, persist, {
          stage: input.command, index, path: '/products', body,
          readExact: async () => exactDeactivated(await readProduct(input.client, identity.productId)),
        }, input.hooks, fixtureDomain(manifest));
      }
      checkpoint.stage = 'deactivated';
      await persist();
      return result(input.command, checkpoint, manifest);
    }

    if (input.command === 'verify-cleanup') {
      if (checkpoint.stage !== 'deactivated' && checkpoint.stage !== 'complete') assertStage(checkpoint, 'deactivated');
      if (!checkpoint.stockBaseline) throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_BASELINE_MISSING');
      assertExactStock(await captureStock(input.client, manifest), checkpoint.stockBaseline, 'final cleanup');
      for (const [, identity] of productRoleEntries(manifest)) {
        if (!exactDeactivated(await readProduct(input.client, identity.productId))) throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_PRODUCT_NOT_CLEAN: ${identity.productId}`);
      }
      const seed = stockAdjustmentRequest(manifest, 'seed');
      const reversal = stockAdjustmentRequest(manifest, 'reversal');
      if (!exactAdjustment(await readAdjustment(input.client, seed.stockAdjustmentId), seed) || !exactAdjustment(await readAdjustment(input.client, reversal.stockAdjustmentId), reversal)) {
        throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_ADJUSTMENT_RESIDUAL_MISMATCH');
      }
      const discovered = await discoverMarkerArtifacts(input.client, manifest);
      const expectedProducts = productRoleEntries(manifest).map(([, value]) => value.productId).sort();
      const expectedAdjustments = Object.values(manifest.stockAdjustmentIds).sort();
      if (stableStringify(discovered.productIds) !== stableStringify(expectedProducts) || stableStringify(discovered.adjustmentIds) !== stableStringify(expectedAdjustments)) {
        throw new Error('MANUFACTURING_PICK_BATCH_FIXTURE_RESIDUAL_DISCOVERY_INCOMPLETE');
      }
      checkpoint.stage = 'complete';
      await persist();
      return result(input.command, checkpoint, manifest, {
        approvedInertResiduals: [
          ...expectedProducts.map((id) => ({ type: 'product' as const, id, state: 'deactivated' as const })),
          ...expectedAdjustments.map((id) => ({ type: 'stock-adjustment' as const, id, state: 'retained' as const })),
        ],
      });
    }

    throw new Error(`MANUFACTURING_PICK_BATCH_FIXTURE_COMMAND_UNSUPPORTED: ${input.command}`);
  });
}

function result(
  command: ManufacturingPickBatchFixtureCommand,
  checkpoint: FixtureCheckpoint,
  manifest: ManufacturingPickBatchFixtureManifest,
  extra: Partial<ManufacturingPickBatchFixtureCommandResult> = {},
): ManufacturingPickBatchFixtureCommandResult {
  return {
    schemaVersion: 'manufacturing-pick-batch-fixture-command-result/v1',
    command,
    stage: checkpoint.stage,
    manifestHash: checkpoint.manifestHash,
    ...(checkpoint.stockBaseline ? { stockBaselineHash: canonicalHash(checkpoint.stockBaseline, `${MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN}:stock`) } : {}),
    ...(checkpoint.seededStock ? { seededStockHash: canonicalHash(checkpoint.seededStock, `${MANUFACTURING_PICK_BATCH_FIXTURE_DOMAIN}:stock`) } : {}),
    ...extra,
  };
}
