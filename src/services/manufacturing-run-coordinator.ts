import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import type { Server } from 'node:net';
import { InflowApiError, type PreparedMutation } from '../client/inflow.js';
import { canonicalHash, stableStringify } from '../core/canonical-json.js';
import {
  compareDecimal,
  decimalToString,
  normalizeDecimal,
  parseDecimal,
  subtractDecimal,
  ZERO_DECIMAL,
} from '../core/decimal.js';
import type {
  ComponentIntentRecord,
  ManufacturingRunArtifactRecord,
  ManufacturingRunDependencyRecord,
  ManufacturingRunRecord,
  ManufacturingRunState,
} from '../core/manufacturing-run-store.js';
import {
  COORDINATOR_RATE_WINDOW_MS,
  COORDINATOR_REQUESTS_PER_MINUTE,
} from '../core/manufacturing-run-store.js';
import type {
  ManufacturingOrder,
  Product,
  ProductSummary,
} from '../types/inflow.js';
import {
  canonicalManufacturingOrderProjection,
  canonicalManufacturingOrderWriteShape,
  flattenManufacturingLines,
  MO_TRACE_INCLUDE,
} from './manufacturing-order-trace.js';
import { effectiveBuildRunAvailableQuantity } from './inventory-summaries.js';
import {
  captureManufacturingSnapshot,
  consumableManufacturingLines,
  manufacturingOperationCompletionStateHash,
  planManufacturingBatch,
  planManufacturingOperationCompletion,
  planManufacturingRunBegin,
  validateManufacturingSnapshot,
  type BeginManufacturingRunInput,
  type ManufacturingBatchPlan,
  type ManufacturingComponentIntent,
  type ManufacturingOperationCompletionPlan,
  type ManufacturingRunBeginPlan,
  type ManufacturingSnapshot,
} from './manufacturing-run-planner.js';

const BEGIN_PLAN_ARTIFACT = 'begin_plan';
const BEGIN_SNAPSHOT_ARTIFACT = 'begin_snapshot';
const SOURCE_SERIAL_BINDING_ARTIFACT = 'source_serial_binding/v1';
const BLOCKER_EVIDENCE_ARTIFACT = 'blocker_evidence/v1';
const NOTIFICATION_CONTEXT_ARTIFACT_PREFIX = 'notification_context/v1:';
const CREATE_DISPATCH_BARRIER_ARTIFACT = 'create_dispatch_barrier';
const DISPATCH_PLAN_ARTIFACT = 'dispatch_plan';
const DISPATCH_NO_WRITE_REJECTION_ARTIFACT_PREFIX =
  'dispatch_no_write_rejection/v1:revision:';
const DISPATCH_NO_WRITE_PROOF_ARTIFACT_PREFIX =
  'dispatch_no_write_proof/v1:revision:';
const OPERATION_COMPLETION_INTENT_ARTIFACT =
  'operation_completion_intent/v1';
const OPERATION_COMPLETION_PLAN_ARTIFACT =
  'operation_completion_plan/v1';
const OPERATION_COMPLETION_DISPATCH_BARRIER_ARTIFACT =
  'operation_completion_dispatch_barrier/v1';
const COMPONENT_INVENTORY_EXPECTATION_ARTIFACT =
  'component_inventory_expectation/v1';
const PARENT_VERIFIED_PUT_ARTIFACT = 'parent_verified_put';

const TERMINAL_OR_MANUAL_STATES = new Set<ManufacturingRunState>([
  'applied_verified',
  'staged_awaiting_operations',
  'resolved_manual',
  'failed_no_write',
  'conflict',
  'blocked',
  'restore_quarantine',
  'abandoned',
]);

export interface ManufacturingCoordinatorClock {
  now(): Date;
  sleep(delayMs: number): Promise<void>;
}

export interface ManufacturingCoordinatorClient {
  get<T>(
    path: string,
    options?: { include?: string[] }
  ): Promise<T>;
  prepareMutation<T>(
    method: 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    }
  ): Promise<PreparedMutation<T>>;
}

export interface ManufacturingCoordinatorStore {
  createRun(input: {
    operationId: string;
    idempotencyKeyHash: string;
    canonicalIdentity: unknown;
    runHash: string;
    immutableIntentHash: string;
    manufacturingOrderId: string;
    rootLineId: string;
    coordinatorMarker: string;
    parentOperationId?: string | null;
    parentRawLineId?: string | null;
    createdAt?: string | Date | number;
  }): { created: boolean; run: ManufacturingRunRecord };
  beginQueuedRun(input: {
    run: {
      operationId: string;
      idempotencyKeyHash: string;
      canonicalIdentity: unknown;
      runHash: string;
      immutableIntentHash: string;
      manufacturingOrderId: string;
      rootLineId: string;
      coordinatorMarker: string;
      parentOperationId?: string | null;
      parentRawLineId?: string | null;
      createdAt?: string | Date | number;
    };
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
  }): { created: boolean; run: ManufacturingRunRecord };
  beginDependentQueuedRun(input: {
    parentOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    expectedParentStateRevision: number;
    expectedParentProductId: string;
    run: {
      operationId: string;
      idempotencyKeyHash: string;
      canonicalIdentity: unknown;
      runHash: string;
      immutableIntentHash: string;
      manufacturingOrderId: string;
      rootLineId: string;
      coordinatorMarker: string;
      parentOperationId: string;
      parentRawLineId: string;
      createdAt?: string | Date | number;
    };
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
  }): {
    created: boolean;
    run: ManufacturingRunRecord;
    dependency: ManufacturingRunDependencyRecord;
  };
  getRun(operationId: string): ManufacturingRunRecord | undefined;
  getRunByHash(runHash: string): ManufacturingRunRecord | undefined;
  listDependencyRunsForReconciliation(limit?: number): ManufacturingRunRecord[];
  listComponentCollectionRunsForReconciliation(): ManufacturingRunRecord[];
  bindRunArtifact(input: {
    operationId: string;
    artifactType: string;
    artifactHash: string;
    artifact: unknown;
    at?: string | Date | number;
  }): { created: boolean; artifact: ManufacturingRunArtifactRecord };
  getRunArtifact(
    operationId: string,
    artifactType: string
  ): ManufacturingRunArtifactRecord | undefined;
  getLatestRunArtifactByPrefix(
    operationId: string,
    artifactTypePrefix: string
  ): ManufacturingRunArtifactRecord | undefined;
  registerComponentIntent(input: {
    operationId: string;
    rawLineId: string;
    intentHash: string;
    productId: string;
    quantity: string;
    locationId: string;
    sublocation?: string | null;
    serialized: boolean;
    serialNumbers: string[];
    createdAt?: string | Date | number;
  }): { created: boolean; intent: ComponentIntentRecord };
  listComponentIntents(operationId: string): ComponentIntentRecord[];
  addDependency(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    createdAt?: string | Date | number;
  }): { created: boolean };
  listDependencies(parentOperationId: string): ManufacturingRunDependencyRecord[];
  satisfyDependency(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    satisfiedAt?: string | Date | number;
  }): { changed: boolean; allSatisfied: boolean };
  completeDependencyWithArtifact(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
    satisfiedAt?: string | Date | number;
  }): { changed: boolean; allSatisfied: boolean };
  transitionAppliedVerifiedChildWithArtifact(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    parentOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
    at?: string | Date | number;
  }): {
    run: ManufacturingRunRecord;
    changed: boolean;
    allSatisfied: boolean;
  };
  resolveRunManualWithArtifact(input: {
    operationId: string;
    expectedRevision: number;
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  transitionRun(input: {
    operationId: string;
    expectedRevision: number;
    toState: ManufacturingRunState | string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  markDispatchUncertain(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  rearmDispatchAfterProvenNoWrite(input: {
    operationId: string;
    expectedRevision: number;
    proofArtifactType: string;
    evidenceHash: string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  markOperationCompletionPrepared(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  fenceOperationCompletionDispatch(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: unknown;
      at?: string | Date | number;
    };
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  markFailedNoWriteAttested(input: {
    operationId: string;
    expectedRevision: number;
    attestationDomain:
      | 'manufacturing-pick-batch-v1'
      | 'manufacturing-operation-completion-v1';
    evidenceHash: string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord;
  bindPlanHashes(input: {
    operationId: string;
    immutableIntentHash: string;
    completePreWriteHash: string;
    expectedPostStateHash: string;
    preparedRequestHash: string;
  }): ManufacturingRunRecord;
  enqueueRun(input: {
    operationId: string;
    enqueuedAt?: string | Date | number;
    availableAt?: string | Date | number;
  }): { operationId: string; queueId: number };
  acquireWorkerLease(input: {
    workerId: string;
    leaseMs: number;
    now?: string | Date | number;
  }): { workerId: string; epoch: number; leaseExpiresAt: string };
  claimNextRun(input: {
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
  }): Record<string, unknown> | undefined;
  renewWorkerOwnership(input: {
    operationId?: string;
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
  }): { workerId: string; epoch: number; leaseExpiresAt: string };
  releaseQueueClaim(input: {
    operationId: string;
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
    availableAt?: string | Date | number;
  }): void;
  completeQueueItem(input: {
    operationId: string;
    workerId: string;
    epoch: number;
  }): void;
  consumeRateBudget(input: {
    now?: string | Date | number;
    count?: number;
  }): { allowed: boolean; remaining: number; retryAfterMs: number };
}

export interface ManufacturingCoordinatorBeginInput extends BeginManufacturingRunInput {
  idempotencyKeyHash: string;
}

export interface ManufacturingCoordinatorChildBeginInput {
  parentOperationId: string;
  parentRawLineId: string;
  parentChildIndex?: number;
  idempotencyKeyHash: string;
  identity: {
    schemaVersion: 'manufacturing-run-identity/v2';
    companyId: string;
    finishedProductId: string;
    sourceSerial: string;
    finishedSerial: string;
  };
  locationId: string;
  remarks?: string;
}

export interface ManufacturingRunStatus {
  operationId: string;
  manufacturingOrderId: string;
  state: ManufacturingRunState;
  stateRevision: number;
  retryMode: 'worker_fifo' | 'readback_only' | 'manual' | 'none';
}

export interface ManufacturingManualApprovalEvidence {
  version: 'manufacturing-run-hmac/v1';
  kid: string;
  audience: string;
  companyId: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}

export interface ManufacturingRunEnvelopeSnapshot
  extends ManufacturingRunStatus {
  runHash: string;
  rootLineId: string;
  expectedComponents: Array<{
    rawLineId: string;
    productId: string;
    quantity: string;
    disposition:
      | 'missing'
      | 'registered'
      | 'dependency_pending'
      | 'dependency_satisfied';
  }>;
}

export interface WorkerTickResult {
  operationId?: string;
  outcome:
    | ManufacturingRunState
    | 'idle'
    | 'rate_limited'
    | 'retryable_read'
    | 'lease_lost'
    | 'create_recovery_pending'
    | 'not_queueable';
  retryAfterMs?: number;
}

interface StoredBeginPlan {
  begin: ManufacturingRunBeginPlan;
  locationId: string;
  remarks: string;
}

const NOTIFICATION_CONTEXT_REMARKS_PATTERN =
  /^\[manufacturing-run-context:v1:[A-Za-z0-9_-]+\](?:\n([\s\S]*))?$/;

function splitManufacturingRunRemarks(value: string): {
  businessRemarks: string;
  notificationRemarks: string | null;
} {
  const match = NOTIFICATION_CONTEXT_REMARKS_PATTERN.exec(value);
  if (!match) {
    return { businessRemarks: value, notificationRemarks: null };
  }
  return {
    businessRemarks: match[1] ?? '',
    notificationRemarks: value,
  };
}

function beginIntentHash(input: {
  begin: ManufacturingRunBeginPlan;
  locationId: string;
  remarks: string;
}): string {
  return canonicalHash(
    {
      identity: input.begin.normalizedIdentity,
      locationId: input.locationId,
      remarks: splitManufacturingRunRemarks(input.remarks).businessRemarks,
    },
    'manufacturing-run/begin-intent/v1'
  );
}

function replayCompatibleBeginHash(
  store: ManufacturingCoordinatorStore,
  beginArtifact: StoredBeginPlan
): string {
  const semanticHash = beginIntentHash(beginArtifact);
  const existingRun = store.getRunByHash(beginArtifact.begin.runHash);
  if (!existingRun) return semanticHash;
  const stored = store.getRunArtifact(
    existingRun.operationId,
    BEGIN_PLAN_ARTIFACT
  )?.artifact as StoredBeginPlan | undefined;
  if (!stored || beginIntentHash(stored) !== semanticHash) return semanticHash;
  const legacyHash = canonicalHash(
    {
      identity: stored.begin.normalizedIdentity,
      locationId: stored.locationId,
      remarks: stored.remarks,
    },
    'manufacturing-run/begin-intent/v1'
  );
  return existingRun.immutableIntentHash === legacyHash
    ? legacyHash
    : semanticHash;
}

interface StoredBeginSnapshot {
  snapshot: ManufacturingSnapshot;
  orderTimestamp: string;
}

export interface StoredSourceSerialBinding {
  schemaVersion: 'source_serial_binding/v1';
  rawLineId: string;
  productId: string;
  sourceSerial: string;
  locationId: string;
  sublocation: string | null;
  manufacturingOrderTimestamp: string;
  inventoryLineTimestamp: string | null;
  inventoryReadbackHash: string;
}

export interface ManufacturingRunBlockerEvidence {
  schemaVersion: 'manufacturing-run-blocker/v1';
  code: string;
  sku: string;
  productId: string;
  rawLineId: string;
  requiredQuantity: string;
  availableQuantity: string;
  locationId: string;
  sourceSerial: string | null;
  detail: string;
  slackMessage: string;
}

interface StoredDispatchPlan {
  mode: ManufacturingBatchPlan['mode'];
  beginTimestamp: string;
  immutableIntentHash: string;
  completePreWriteHash: string;
  expectedPostStateHash: string;
  requestHash: string;
  requestBody: ManufacturingOrder;
  componentInventoryExpectation: StoredComponentInventoryExpectation;
}

interface StoredDispatchNoWriteProof {
  schemaVersion: 'manufacturing-dispatch-no-write-proof/v1';
  domain: 'manufacturing-pick-batch-v1';
  dispatchUncertainRevision: number;
  requestHash: string;
  completePreWriteHash: string;
  preWriteTimestamp: string;
  componentInventoryExpectationHash: string;
  sourceSerialBindingHash: string;
  rejectionArtifactHash: string;
  observedAt: string;
}

interface StoredDispatchNoWriteRejection {
  schemaVersion: 'manufacturing-dispatch-no-write-rejection/v1';
  domain: 'manufacturing-pick-batch-v1';
  dispatchUncertainRevision: number;
  requestHash: string;
  rejection: {
    name: 'InflowApiError';
    statusCode: 400;
    providerCode: 'WorkOrderPartNegativeInventory';
  };
}

interface StoredComponentInventoryExpectation {
  schemaVersion: 'manufacturing-component-inventory-expectation/v1';
  serialized: Array<{
    productId: string;
    serials: string[];
  }>;
  bulkBuckets: Array<{
    productId: string;
    locationId: string;
    sublocation: string;
    expectedQuantityOnHand: string;
  }>;
}

interface StoredOperationCompletionIntent {
  schemaVersion: 'manufacturing-operation-completion-intent/v1';
  completedAt: string;
  outputLocationId: string;
  outputSublocation: string | null;
}

interface StoredOperationCompletionPlan {
  schemaVersion: 'manufacturing-operation-completion-plan/v1';
  stageTimestamp: string;
  completedAt: string;
  operationIds: string[];
  immutableIntentHash: string;
  preStateHash: string;
  expectedPostStateHash: string;
  requestHash: string;
  requestBody: ManufacturingOrder;
}

interface StoredOperationCompletionDispatchBarrier {
  schemaVersion: 'manufacturing-operation-completion-dispatch-barrier/v1';
  correlationId: string;
  requestHash: string;
}

interface StoredParentVerifiedPut {
  parentOperationId: string;
  parentRawLineId: string;
  parentChildIndex: number;
  childOperationId: string;
  productId: string;
  quantity: '1';
  locationId: string;
  sublocation: string | null;
  serialNumbers: [string];
}

export interface ManufacturingRunCoordinatorOptions {
  store: ManufacturingCoordinatorStore;
  client: ManufacturingCoordinatorClient;
  clock?: ManufacturingCoordinatorClock;
  workerId?: string;
  leaseMs?: number;
  readback?: {
    attempts?: number;
    delayMs?: number;
  };
  testHooks?: {
    afterCreateFenced?: () => void;
    afterPrepared?: () => void;
    afterDispatchFenced?: () => void;
    afterDependencySatisfied?: () => void;
  };
  verifyDefinitiveNoWrite?: (
    error: unknown,
    domain:
      | 'manufacturing-pick-batch-v1'
      | 'manufacturing-operation-completion-v1'
  ) => boolean | Promise<boolean>;
  operationCompletionGate?: () => boolean | Promise<boolean>;
}

class CoordinatorRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('COORDINATOR_RATE_LIMITED');
  }
}

class SourceSerialBindingError extends Error {
  constructor(readonly evidence: ManufacturingRunBlockerEvidence) {
    super(`${evidence.code}: ${evidence.detail}`);
    this.name = 'SourceSerialBindingError';
  }
}

interface WorkerClaimContext {
  operationId: string;
  epoch: number;
}

function nowClock(): ManufacturingCoordinatorClock {
  return {
    now: () => new Date(),
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  };
}

function isNotFound(error: unknown): boolean {
  return Number((error as { statusCode?: unknown })?.statusCode) === 404;
}

function isRetryablePreDispatchError(error: unknown): boolean {
  const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return true;
  if (error instanceof SyntaxError || error instanceof TypeError) return true;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    ['AbortError', 'TimeoutError'].includes(name) ||
    /\b(?:request )?timed? ?out\b|\btimeout\b|network (?:error|failure)|socket (?:closed|hang up)|connection (?:reset|closed)|fetch failed|\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)\b|malformed json|unexpected token/i
      .test(message)
  );
}

function isWorkerOwnershipError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /WORKER_LEASE_(?:NOT_HELD|HELD)|STALE_WORKER_EPOCH|QUEUE_OWNERSHIP_CONFLICT/
    .test(message);
}

function isExactProviderSerialExclusion(
  error: unknown
): error is InflowApiError {
  return (
    error instanceof InflowApiError &&
    error.statusCode === 400 &&
    error.apiError?.code === 'NegativeSerialNumberInventory'
  );
}

function isExactWorkOrderPartNoWriteRejection(
  error: unknown
): error is InflowApiError {
  return (
    error instanceof InflowApiError &&
    error.statusCode === 400 &&
    error.apiError?.code === 'WorkOrderPartNegativeInventory'
  );
}

function dispatchNoWriteProofArtifactType(revision: number): string {
  return `${DISPATCH_NO_WRITE_PROOF_ARTIFACT_PREFIX}${revision}`;
}

function dispatchNoWriteRejectionArtifactType(revision: number): string {
  return `${DISPATCH_NO_WRITE_REJECTION_ARTIFACT_PREFIX}${revision}`;
}

function requireRun(
  store: ManufacturingCoordinatorStore,
  operationId: string
): ManufacturingRunRecord {
  const run = store.getRun(operationId);
  if (!run) throw new Error(`MANUFACTURING_RUN_NOT_FOUND: ${operationId}`);
  return run;
}

function artifactValue<T>(
  store: ManufacturingCoordinatorStore,
  operationId: string,
  artifactType: string
): T {
  const artifact = store.getRunArtifact(operationId, artifactType);
  if (!artifact) {
    throw new Error(`RUN_ARTIFACT_MISSING: ${artifactType}`);
  }
  return artifact.artifact as T;
}

function optionalArtifactValue<T>(
  store: ManufacturingCoordinatorStore,
  operationId: string,
  artifactType: string
): T | undefined {
  return store.getRunArtifact(operationId, artifactType)?.artifact as T | undefined;
}

function expectedPostHash(order: ManufacturingOrder): string {
  return canonicalHash(
    canonicalManufacturingOrderProjection(order),
    'manufacturing-run/expected-post/v1'
  );
}

function manufacturingLineDepths(
  snapshot: ManufacturingSnapshot
): ReadonlyMap<string, number> {
  const linesById = new Map(
    snapshot.lines.map((line) => [line.rawLineId, line] as const)
  );
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (rawLineId: string): number => {
    const known = depths.get(rawLineId);
    if (known !== undefined) return known;
    if (visiting.has(rawLineId)) {
      throw new Error(`MANUFACTURING_HIERARCHY_CYCLE: ${rawLineId}`);
    }
    const line = linesById.get(rawLineId);
    if (!line) {
      throw new Error(`MANUFACTURING_HIERARCHY_LINE_MISSING: ${rawLineId}`);
    }
    visiting.add(rawLineId);
    const depth = line.parentRawLineId === null
      ? 0
      : depthOf(line.parentRawLineId) + 1;
    visiting.delete(rawLineId);
    depths.set(rawLineId, depth);
    return depth;
  };
  for (const line of snapshot.lines) depthOf(line.rawLineId);
  return depths;
}

function compareExpectedComponentExecutionOrder(
  leftRawLineId: string,
  rightRawLineId: string,
  depths: ReadonlyMap<string, number>,
  sourceRawLineId: string | undefined
): number {
  const leftIsSource = leftRawLineId === sourceRawLineId;
  const rightIsSource = rightRawLineId === sourceRawLineId;
  if (leftIsSource !== rightIsSource) return leftIsSource ? -1 : 1;
  const depthDifference =
    (depths.get(leftRawLineId) ?? Number.MAX_SAFE_INTEGER) -
    (depths.get(rightRawLineId) ?? Number.MAX_SAFE_INTEGER);
  return depthDifference || leftRawLineId.localeCompare(rightRawLineId);
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function timestampAdvanced(previous: string, current: string | undefined): boolean {
  if (!current || current === previous) return false;
  if (/^[0-9a-f]+$/i.test(previous) && /^[0-9a-f]+$/i.test(current)) {
    return BigInt(`0x${current}`) > BigInt(`0x${previous}`);
  }
  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
    return currentTime > previousTime;
  }
  return current.localeCompare(previous) > 0;
}

function statusOf(run: ManufacturingRunRecord): ManufacturingRunStatus {
  const retryMode = run.state === 'dispatch_uncertain'
    ? 'readback_only'
    : run.state === 'creating' || run.state === 'ready' || run.state === 'prepared'
      ? 'worker_fifo'
      : run.state === 'staged_awaiting_operations' ||
          run.state === 'blocked' ||
          run.state === 'restore_quarantine'
        ? 'manual'
        : 'none';
  return {
    operationId: run.operationId,
    manufacturingOrderId: run.manufacturingOrderId,
    state: run.state,
    stateRevision: run.stateRevision,
    retryMode,
  };
}

function isLegacyStoredRun(run: ManufacturingRunRecord): boolean {
  const identity = run.canonicalIdentity as {
    schemaVersion?: unknown;
    sourceSerial?: unknown;
    finishedSerial?: unknown;
  };
  return identity.schemaVersion !== 'manufacturing-run-identity/v2' ||
    typeof identity.sourceSerial !== 'string' ||
    typeof identity.finishedSerial !== 'string';
}

export class ManufacturingRunCoordinator {
  private readonly store: ManufacturingCoordinatorStore;
  private readonly client: ManufacturingCoordinatorClient;
  private readonly clock: ManufacturingCoordinatorClock;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly readbackAttempts: number;
  private readonly readbackDelayMs: number;
  private readonly testHooks: ManufacturingRunCoordinatorOptions['testHooks'];
  private readonly verifyDefinitiveNoWrite: (
    error: unknown,
    domain:
      | 'manufacturing-pick-batch-v1'
      | 'manufacturing-operation-completion-v1'
  ) => boolean | Promise<boolean>;
  private readonly operationCompletionGate: () => boolean | Promise<boolean>;
  private workerBusy = false;

  constructor(options: ManufacturingRunCoordinatorOptions) {
    this.store = options.store;
    this.client = options.client;
    this.clock = options.clock ?? nowClock();
    this.workerId =
      options.workerId ??
      `manufacturing-run-worker:${process.pid}:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.readbackAttempts = options.readback?.attempts ?? 3;
    this.readbackDelayMs = options.readback?.delayMs ?? 1_000;
    this.testHooks = options.testHooks;
    this.verifyDefinitiveNoWrite =
      options.verifyDefinitiveNoWrite ?? (() => false);
    this.operationCompletionGate =
      options.operationCompletionGate ?? (() => false);
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('INVALID_COORDINATOR_LEASE');
    }
    if (!Number.isSafeInteger(this.readbackAttempts) || this.readbackAttempts <= 0) {
      throw new Error('INVALID_READBACK_ATTEMPTS');
    }
    if (!Number.isSafeInteger(this.readbackDelayMs) || this.readbackDelayMs < 0) {
      throw new Error('INVALID_READBACK_DELAY');
    }
  }

  begin(input: ManufacturingCoordinatorBeginInput): ManufacturingRunStatus {
    const begin = planManufacturingRunBegin(input);
    if (
      begin.normalizedIdentity.parentRunHash !== null ||
      begin.normalizedIdentity.parentRawLineId !== null
    ) {
      throw new Error('ROOT_BEGIN_PARENT_FIELDS_FORBIDDEN');
    }
    const beginArtifact: StoredBeginPlan = {
      begin,
      locationId: input.locationId,
      remarks: input.remarks?.trim() ?? '',
    };
    const immutableBeginHash = replayCompatibleBeginHash(
      this.store,
      beginArtifact
    );
    const now = this.clock.now();
    const { run } = this.store.beginQueuedRun({
      run: {
        operationId: begin.operationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        canonicalIdentity: begin.normalizedIdentity,
        runHash: begin.runHash,
        immutableIntentHash: immutableBeginHash,
        manufacturingOrderId: begin.manufacturingOrderId,
        rootLineId: begin.rootLineId,
        coordinatorMarker: begin.coordinatorMarker,
        parentOperationId: null,
        parentRawLineId: null,
        createdAt: now,
      },
      artifact: {
        artifactType: BEGIN_PLAN_ARTIFACT,
        artifactHash: canonicalHash(beginArtifact, 'manufacturing-run/begin-plan/v1'),
        artifact: beginArtifact,
        at: now,
      },
    });
    this.recordNotificationContext(run.operationId, beginArtifact.remarks, now);
    const current = requireRun(this.store, run.operationId);
    if (current.state === 'blocked') {
      const blockerArtifact = this.store.getLatestRunArtifactByPrefix(
        current.operationId,
        BLOCKER_EVIDENCE_ARTIFACT
      );
      const blocker = blockerArtifact?.artifact as
        ManufacturingRunBlockerEvidence | undefined;
      const blockerRevision = Number(
        /:revision:(\d+)$/.exec(blockerArtifact?.artifactType ?? '')?.[1]
      );
      const blockerMatchesCurrentEpoch =
        blockerRevision === current.stateRevision - 1 ||
        (
          blockerArtifact?.artifactType === BLOCKER_EVIDENCE_ARTIFACT &&
          current.stateRevision === 2
        );
      const sourceBindingPresent = this.store.getRunArtifact(
        current.operationId,
        SOURCE_SERIAL_BINDING_ARTIFACT
      ) !== undefined;
      if (
        blockerMatchesCurrentEpoch &&
        (
          blocker?.code === 'COMPONENT_INVENTORY_SHORTAGE' ||
          (
            blocker?.code === 'SOURCE_SERIAL_UNAVAILABLE' &&
            sourceBindingPresent
          )
        )
      ) {
        return statusOf(this.store.transitionRun({
          operationId: current.operationId,
          expectedRevision: current.stateRevision,
          toState: 'collecting',
          reason: `fresh begin retry after ${blocker.code.toLowerCase()}`,
          at: now,
        }));
      }
    }
    return statusOf(current);
  }

  beginChildWithDependency(
    input: ManufacturingCoordinatorChildBeginInput
  ): ManufacturingRunStatus {
    const parent = requireRun(this.store, input.parentOperationId);
    if (isLegacyStoredRun(parent)) {
      throw new Error('LEGACY_MANUFACTURING_RUN_RECONCILE_ONLY');
    }
    if (!['collecting', 'waiting_dependencies'].includes(parent.state)) {
      throw new Error(`RUN_NOT_COLLECTING_DEPENDENCIES: ${parent.state}`);
    }
    const expectedLine = consumableRawLine(
      artifactValue<StoredBeginSnapshot>(
        this.store,
        parent.operationId,
        BEGIN_SNAPSHOT_ARTIFACT
      ).snapshot,
      input.parentRawLineId
    );
    if (expectedLine.productId !== input.identity.finishedProductId) {
      throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
    }
    const parentComponent = this.snapshot(parent.operationId).expectedComponents.find(
      (component) => component.rawLineId === input.parentRawLineId
    );
    if (
      !parentComponent ||
      !['missing', 'dependency_pending'].includes(parentComponent.disposition)
    ) {
      throw new Error('PARENT_COMPONENT_DISPOSITION_CONFLICT');
    }
    const childInput: ManufacturingCoordinatorBeginInput = {
      idempotencyKeyHash: input.idempotencyKeyHash,
      identity: {
        ...input.identity,
        parentRunHash: parent.runHash,
        parentRawLineId: input.parentRawLineId,
      },
      locationId: input.locationId,
      remarks: input.remarks,
    };
    const begin = planManufacturingRunBegin(childInput);
    const beginArtifact: StoredBeginPlan = {
      begin,
      locationId: input.locationId,
      remarks: input.remarks?.trim() ?? '',
    };
    const immutableBeginHash = replayCompatibleBeginHash(
      this.store,
      beginArtifact
    );
    const now = this.clock.now();
    const { run } = this.store.beginDependentQueuedRun({
      parentOperationId: parent.operationId,
      parentRawLineId: input.parentRawLineId,
      parentChildIndex: input.parentChildIndex ?? 0,
      expectedParentStateRevision: parent.stateRevision,
      expectedParentProductId: expectedLine.productId,
      run: {
        operationId: begin.operationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        canonicalIdentity: begin.normalizedIdentity,
        runHash: begin.runHash,
        immutableIntentHash: immutableBeginHash,
        manufacturingOrderId: begin.manufacturingOrderId,
        rootLineId: begin.rootLineId,
        coordinatorMarker: begin.coordinatorMarker,
        parentOperationId: parent.operationId,
        parentRawLineId: input.parentRawLineId,
        createdAt: now,
      },
      artifact: {
        artifactType: BEGIN_PLAN_ARTIFACT,
        artifactHash: canonicalHash(
          beginArtifact,
          'manufacturing-run/begin-plan/v1'
        ),
        artifact: beginArtifact,
        at: now,
      },
    });
    this.recordNotificationContext(run.operationId, beginArtifact.remarks, now);
    return statusOf(requireRun(this.store, run.operationId));
  }

  registerComponent(
    input: { operationId: string } & ManufacturingComponentIntent
  ): ManufacturingRunStatus {
    const run = requireRun(this.store, input.operationId);
    if (isLegacyStoredRun(run)) {
      throw new Error('LEGACY_MANUFACTURING_RUN_RECONCILE_ONLY');
    }
    if (!['collecting', 'waiting_dependencies'].includes(run.state)) {
      throw new Error(`RUN_NOT_COLLECTING_COMPONENTS: ${run.state}`);
    }
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      input.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const expected = consumableRawLine(snapshot, input.rawLineId);
    if (expected.productId !== input.productId) {
      throw new Error('COMPONENT_PRODUCT_MISMATCH');
    }
    if (normalizeDecimal(expected.quantity) !== normalizeDecimal(input.quantity)) {
      throw new Error('COMPONENT_QUANTITY_MISMATCH');
    }
    const locationId = input.locationId.trim();
    if (!locationId) throw new Error('INVALID_COMPONENT_LOCATION');
    const serialNumbers = [...input.serialNumbers]
      .map((serial) => serial.trim())
      .filter(Boolean)
      .sort();
    if (new Set(serialNumbers).size !== serialNumbers.length) {
      throw new Error('DUPLICATE_COMPONENT_SERIAL');
    }
    const numericQuantity = Number(normalizeDecimal(input.quantity));
    if (
      !Number.isSafeInteger(numericQuantity) ||
      numericQuantity <= 0 ||
      numericQuantity > 100
    ) {
      throw new Error('UNSUPPORTED_COMPONENT_QUANTITY');
    }
    if (input.serialized && serialNumbers.length !== numericQuantity) {
      throw new Error('SERIAL_COUNT_MISMATCH');
    }
    if (!input.serialized && serialNumbers.length > 0) {
      throw new Error('UNSUPPORTED_NON_SERIALIZED_SERIALS');
    }
    const sourceBinding = optionalArtifactValue<StoredSourceSerialBinding>(
      this.store,
      input.operationId,
      SOURCE_SERIAL_BINDING_ARTIFACT
    );
    if (
      sourceBinding?.rawLineId === input.rawLineId &&
      (
        !input.serialized ||
        serialNumbers.length !== 1 ||
        normalizeSerial(serialNumbers[0]!) !== sourceBinding.sourceSerial ||
        locationId !== sourceBinding.locationId ||
        (input.sublocation?.trim() || null) !== sourceBinding.sublocation
      )
    ) {
      throw new Error('SOURCE_SERIAL_BINDING_INTENT_MISMATCH');
    }
    const normalized = {
      rawLineId: input.rawLineId,
      productId: input.productId,
      quantity: normalizeDecimal(input.quantity),
      locationId,
      sublocation: input.sublocation?.trim() || null,
      serialized: input.serialized,
      serialNumbers,
    };
    const intentHash = canonicalHash(
      normalized,
      'manufacturing-run/component-intent/v1'
    );
    this.store.registerComponentIntent({
      operationId: input.operationId,
      ...normalized,
      intentHash,
      createdAt: this.clock.now(),
    });
    this.advanceParentIfReady(input.operationId);
    return statusOf(requireRun(this.store, input.operationId));
  }

  registerDependency(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
  }): ManufacturingRunStatus {
    const parent = requireRun(this.store, input.parentOperationId);
    const child = requireRun(this.store, input.childOperationId);
    if (isLegacyStoredRun(parent) || isLegacyStoredRun(child)) {
      throw new Error('LEGACY_MANUFACTURING_RUN_RECONCILE_ONLY');
    }
    this.assertNoParentCycle(parent, child.operationId);
    if (!['collecting', 'waiting_dependencies'].includes(parent.state)) {
      throw new Error(`RUN_NOT_COLLECTING_DEPENDENCIES: ${parent.state}`);
    }
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      parent.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const expectedLine = consumableRawLine(snapshot, input.parentRawLineId);
    if (
      child.parentOperationId !== parent.operationId ||
      child.parentRawLineId !== input.parentRawLineId ||
      String((child.canonicalIdentity as { finishedProductId?: unknown }).finishedProductId) !==
        expectedLine.productId
    ) {
      throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
    }
    this.store.addDependency({
      ...input,
      createdAt: this.clock.now(),
    });
    const current = requireRun(this.store, parent.operationId);
    if (current.state === 'collecting') {
      this.store.transitionRun({
        operationId: current.operationId,
        expectedRevision: current.stateRevision,
        toState: 'waiting_dependencies',
        reason: 'recursive child dependency registered',
        at: this.clock.now(),
      });
    }
    return statusOf(requireRun(this.store, parent.operationId));
  }

  blockComponent(input: {
    operationId: string;
    rawLineId: string;
    reason: string;
    evidenceHash: string;
    blockerEvidence?: ManufacturingRunBlockerEvidence;
  }): ManufacturingRunStatus {
    const run = requireRun(this.store, input.operationId);
    if (!['collecting', 'waiting_dependencies'].includes(run.state)) {
      throw new Error(`RUN_NOT_COLLECTING_COMPONENTS: ${run.state}`);
    }
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      run.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    consumableRawLine(snapshot, input.rawLineId);
    const reason = input.reason.trim();
    const evidenceHash = input.evidenceHash.trim();
    if (!reason || !evidenceHash) {
      throw new Error('COMPONENT_BLOCK_EVIDENCE_REQUIRED');
    }
    const artifact = {
      rawLineId: input.rawLineId,
      reason,
      evidenceHash,
    };
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType:
        `component_block:${input.rawLineId}:revision:${run.stateRevision}`,
      artifactHash: canonicalHash(
        artifact,
        'manufacturing-run/component-block/v1'
      ),
      artifact,
      at: this.clock.now(),
    });
    if (input.blockerEvidence) {
      this.recordBlockerEvidence(run.operationId, input.blockerEvidence);
    }
    const blocked = this.store.transitionRun({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      toState: 'blocked',
      reason: `component ${input.rawLineId} blocked: ${reason}`,
      at: this.clock.now(),
    });
    this.propagateDependencyOutcome(run.operationId);
    return statusOf(blocked);
  }

  private assertNoParentCycle(
    parent: ManufacturingRunRecord,
    prospectiveChildOperationId: string
  ): void {
    const visited = new Set<string>();
    let current: ManufacturingRunRecord | undefined = parent;
    while (current) {
      if (current.operationId === prospectiveChildOperationId) {
        throw new Error('MANUFACTURING_DEPENDENCY_CYCLE');
      }
      if (visited.has(current.operationId)) {
        throw new Error('MANUFACTURING_DEPENDENCY_CYCLE');
      }
      visited.add(current.operationId);
      current = current.parentOperationId
        ? this.store.getRun(current.parentOperationId)
        : undefined;
    }
  }

  propagateDependencyOutcome(childOperationId: string): void {
    this.propagateDependencyFailure(childOperationId);
  }

  private propagateDependencyFailure(
    childOperationId: string,
    evidenceHash?: string
  ): void {
    const origin = requireRun(this.store, childOperationId);
    if (
      ![
        'resolved_manual',
        'failed_no_write',
        'conflict',
        'blocked',
        'restore_quarantine',
        'abandoned',
      ].includes(origin.state)
    ) {
      return;
    }
    const durableEvidenceHash = evidenceHash ?? canonicalHash(
      {
        operationId: origin.operationId,
        state: origin.state,
        stateRevision: origin.stateRevision,
      },
      'manufacturing-run/dependency-outcome/v1'
    );
    let child = origin;
    while (child.parentOperationId) {
      const parent = requireRun(this.store, child.parentOperationId);
      const artifact = {
        originChildOperationId: origin.operationId,
        immediateChildOperationId: child.operationId,
        childState: origin.state,
        evidenceHash: durableEvidenceHash,
      };
      this.store.bindRunArtifact({
        operationId: parent.operationId,
        artifactType:
          `dependency_block:${origin.operationId}:${origin.stateRevision}`,
        artifactHash: canonicalHash(
          artifact,
          'manufacturing-run/dependency-block/v1'
        ),
        artifact,
        at: this.clock.now(),
      });
      if (!TERMINAL_OR_MANUAL_STATES.has(parent.state)) {
        this.store.transitionRun({
          operationId: parent.operationId,
          expectedRevision: parent.stateRevision,
          toState: 'blocked',
          reason:
            `descendant ${origin.operationId} ended ${origin.state}; ` +
            `evidence ${durableEvidenceHash}`,
          at: this.clock.now(),
        });
      }
      child = parent;
    }
  }

  async runOne(): Promise<WorkerTickResult> {
    if (this.workerBusy) return { outcome: 'idle' };
    this.workerBusy = true;
    try {
      return await this.runOneExclusive();
    } finally {
      this.workerBusy = false;
    }
  }

  private async runOneExclusive(): Promise<WorkerTickResult> {
    this.reconcileDurableDependencyOutcomes();
    const now = this.clock.now();
    const lease = this.store.acquireWorkerLease({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      now,
    });
    const claim = this.store.claimNextRun({
      workerId: this.workerId,
      epoch: lease.epoch,
      leaseMs: this.leaseMs,
      now,
    });
    if (!claim) return { outcome: 'idle' };
    const operationId = String(claim.operationId);
    const context: WorkerClaimContext = {
      operationId,
      epoch: lease.epoch,
    };
    const run = requireRun(this.store, operationId);
    try {
      if (isLegacyStoredRun(run)) {
        const blocked = this.quarantineLegacyStoredRun(run);
        return { operationId, outcome: blocked.state };
      }
      if (run.state === 'creating') {
        return await this.processCreating(run, context);
      }
      if (run.state === 'ready') {
        return await this.processReady(run, context);
      }
      if (run.state === 'prepared') {
        return await this.processPrepared(run, context);
      }
      this.store.completeQueueItem({
        operationId,
        workerId: this.workerId,
        epoch: lease.epoch,
      });
      return { operationId, outcome: 'not_queueable' };
    } catch (error) {
      if (error instanceof CoordinatorRateLimitedError) {
        const retryAfterMs = Math.max(
          error.retryAfterMs,
          COORDINATOR_RATE_WINDOW_MS
        );
        // Dispatch uncertainty is deliberately readback-only and never requeued.
        if (requireRun(this.store, operationId).state === 'dispatch_uncertain') {
          return {
            operationId,
            outcome: 'dispatch_uncertain',
          };
        }
        if (!this.releaseClaimForRetry(context, retryAfterMs)) {
          return { operationId, outcome: 'lease_lost' };
        }
        return {
          operationId,
          outcome: 'rate_limited',
          retryAfterMs,
        };
      }
      if (isRetryablePreDispatchError(error)) {
        if (!this.releaseClaimForRetry(context)) {
          return { operationId, outcome: 'lease_lost' };
        }
        return { operationId, outcome: 'retryable_read' };
      }
      if (isWorkerOwnershipError(error)) {
        return { operationId, outcome: 'lease_lost' };
      }
      throw error;
    }
  }

  snapshot(operationId: string): ManufacturingRunEnvelopeSnapshot {
    const run = requireRun(this.store, operationId);
    const storedSnapshot = this.store.getRunArtifact(
      operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    )?.artifact as StoredBeginSnapshot | undefined;
    const intents = new Set(
      this.store.listComponentIntents(operationId).map(
        (intent) => intent.rawLineId
      )
    );
    const dependencies = new Map<string, ManufacturingRunDependencyRecord[]>();
    for (const dependency of this.store.listDependencies(operationId)) {
      const rows = dependencies.get(dependency.parentRawLineId) ?? [];
      rows.push(dependency);
      dependencies.set(dependency.parentRawLineId, rows);
    }
    const sourceSerialBinding = optionalArtifactValue<StoredSourceSerialBinding>(
      this.store,
      operationId,
      SOURCE_SERIAL_BINDING_ARTIFACT
    );
    const lineDepths = storedSnapshot
      ? manufacturingLineDepths(storedSnapshot.snapshot)
      : new Map<string, number>();
    const expectedComponents = storedSnapshot
      ? consumableManufacturingLines(storedSnapshot.snapshot)
      .map((line) => {
        const lineDependencies = dependencies.get(line.rawLineId) ?? [];
        const disposition = intents.has(line.rawLineId)
          ? 'registered' as const
          : lineDependencies.length > 0 &&
              lineDependencies.every((dependency) => dependency.satisfiedAt)
            ? 'dependency_satisfied' as const
            : lineDependencies.length > 0
              ? 'dependency_pending' as const
              : 'missing' as const;
        return {
          rawLineId: line.rawLineId,
          productId: line.productId,
          quantity: line.quantity,
          disposition,
        };
      })
      .sort((left, right) => compareExpectedComponentExecutionOrder(
        left.rawLineId,
        right.rawLineId,
        lineDepths,
        sourceSerialBinding?.rawLineId
      ))
      : [];
    return {
      ...statusOf(run),
      runHash: run.runHash,
      rootLineId: run.rootLineId,
      expectedComponents,
    };
  }

  async status(operationId: string): Promise<ManufacturingRunStatus> {
    let run = requireRun(this.store, operationId);
    if (run.state === 'dispatch_uncertain') {
      try {
        await this.reconcileReadback(run);
      } catch (error) {
        if (!(error instanceof CoordinatorRateLimitedError)) throw error;
      }
      run = requireRun(this.store, operationId);
    } else if (isLegacyStoredRun(run) && !TERMINAL_OR_MANUAL_STATES.has(run.state)) {
      run = this.quarantineLegacyStoredRun(run);
    }
    this.reconcileDependencyOutcome(operationId);
    this.advanceParentIfReady(operationId);
    return statusOf(requireRun(this.store, operationId));
  }

  async rearmProvenNoWrite(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<ManufacturingRunStatus> {
    const run = requireRun(this.store, input.operationId);
    if (run.stateRevision !== input.expectedRevision) {
      throw new Error(
        `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedRevision}, got ${run.stateRevision}`
      );
    }
    if (run.state !== 'dispatch_uncertain') {
      throw new Error(
        `PROVEN_NO_WRITE_REARM_REQUIRES_DISPATCH_UNCERTAIN: ${run.state}`
      );
    }
    if (this.store.getRunArtifact(
      run.operationId,
      OPERATION_COMPLETION_DISPATCH_BARRIER_ARTIFACT
    )) {
      throw new Error('PROVEN_NO_WRITE_REARM_UNSUPPORTED_DOMAIN');
    }

    const proofArtifactType = dispatchNoWriteProofArtifactType(
      input.expectedRevision
    );
    const plan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    const rejectionRecord = this.requireDispatchNoWriteRejection(run, plan);
    let proofRecord = this.store.getRunArtifact(
      run.operationId,
      proofArtifactType
    );
    if (!proofRecord) {
      const captured = await this.captureDispatchNoWriteProof(run, plan);
      if (!captured) {
        throw new Error('PROVEN_NO_WRITE_EVIDENCE_INCOMPLETE');
      }
      proofRecord = this.store.getRunArtifact(
        run.operationId,
        proofArtifactType
      );
    }
    const inventoryArtifact = this.store.getRunArtifact(
      run.operationId,
      COMPONENT_INVENTORY_EXPECTATION_ARTIFACT
    );
    const sourceBindingArtifact = this.store.getRunArtifact(
      run.operationId,
      SOURCE_SERIAL_BINDING_ARTIFACT
    );
    if (
      !proofRecord ||
      !inventoryArtifact ||
      !sourceBindingArtifact ||
      !proofRecord.artifact ||
      typeof proofRecord.artifact !== 'object' ||
      Array.isArray(proofRecord.artifact)
    ) {
      throw new Error('PROVEN_NO_WRITE_EVIDENCE_INCOMPLETE');
    }
    const proof = proofRecord.artifact as Partial<StoredDispatchNoWriteProof>;
    if (
      proof.schemaVersion !== 'manufacturing-dispatch-no-write-proof/v1' ||
      proof.domain !== 'manufacturing-pick-batch-v1' ||
      proof.dispatchUncertainRevision !== input.expectedRevision ||
      proof.requestHash !== plan.requestHash ||
      proof.requestHash !== run.preparedRequestHash ||
      proof.completePreWriteHash !== plan.completePreWriteHash ||
      proof.completePreWriteHash !== run.completePreWriteHash ||
      proof.preWriteTimestamp !== plan.beginTimestamp ||
      proof.componentInventoryExpectationHash !== inventoryArtifact.artifactHash ||
      proof.sourceSerialBindingHash !== sourceBindingArtifact.artifactHash ||
      proof.rejectionArtifactHash !== rejectionRecord.artifactHash ||
      !proof.observedAt ||
      !Number.isFinite(Date.parse(proof.observedAt))
    ) {
      throw new Error('PROVEN_NO_WRITE_EVIDENCE_INVALID');
    }

    const begin = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    ).begin;
    const beginSnapshot = artifactValue<StoredBeginSnapshot>(
      this.store,
      run.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const current = await this.assertPreparedPlanCurrent({
      run,
      begin,
      beginSnapshot,
      storedPlan: plan,
    });
    const currentPreWriteHash = canonicalHash(
      canonicalManufacturingOrderWriteShape(current),
      'manufacturing-run/complete-pre-write/v1'
    );
    if (
      currentPreWriteHash !== proof.completePreWriteHash ||
      current.timestamp !== proof.preWriteTimestamp
    ) {
      throw new Error('PROVEN_NO_WRITE_REARM_READBACK_DRIFT');
    }

    const rearmed = this.store.rearmDispatchAfterProvenNoWrite({
      operationId: run.operationId,
      expectedRevision: input.expectedRevision,
      proofArtifactType,
      evidenceHash: proofRecord.artifactHash,
      reason: 'revision-bound exact no-write proof re-armed immutable dispatch',
      at: this.clock.now(),
    });
    return statusOf(rearmed);
  }

  reconcileDurableDependencyOutcomes(limit = 100): number {
    const runs = this.store.listDependencyRunsForReconciliation(limit);
    for (const run of runs) {
      this.reconcileDependencyOutcome(run.operationId);
    }
    const collecting =
      this.store.listComponentCollectionRunsForReconciliation();
    for (const run of collecting) {
      this.advanceParentIfReady(run.operationId);
    }
    return runs.length + collecting.length;
  }

  private reconcileDependencyOutcome(operationId: string): void {
    const child = requireRun(this.store, operationId);
    if (!child.parentOperationId || !child.parentRawLineId) return;
    if (child.state !== 'applied_verified') {
      this.propagateDependencyOutcome(operationId);
      return;
    }
    const parent = requireRun(this.store, child.parentOperationId);
    if (isLegacyStoredRun(parent)) {
      this.quarantineLegacyStoredRun(parent);
      return;
    }
    if (TERMINAL_OR_MANUAL_STATES.has(parent.state)) {
      this.propagateDependencyOutcome(parent.operationId);
      return;
    }
    const dependency = this.store.listDependencies(parent.operationId).find(
      (candidate) =>
        candidate.childOperationId === child.operationId &&
        candidate.parentRawLineId === child.parentRawLineId
    );
    if (!dependency) {
      this.blockParent(
        parent.operationId,
        'terminal child has no durable parent dependency identity'
      );
      return;
    }
    const evidence = this.store.getRunArtifact(
      child.operationId,
      PARENT_VERIFIED_PUT_ARTIFACT
    );
    if (!evidence) {
      this.blockParent(
        parent.operationId,
        'terminal child lacks exact parent-compatible verified put evidence'
      );
      return;
    }
    this.store.completeDependencyWithArtifact({
      parentOperationId: parent.operationId,
      childOperationId: child.operationId,
      parentRawLineId: child.parentRawLineId,
      parentChildIndex: dependency.parentChildIndex,
      artifact: {
        artifactType: evidence.artifactType,
        artifactHash: evidence.artifactHash,
        artifact: evidence.artifact,
        at: evidence.at,
      },
      satisfiedAt: evidence.at,
    });
    this.finalizeSatisfiedDependencyLine({
      operationId: parent.operationId,
      rawLineId: child.parentRawLineId,
    });
  }

  resolveManual(input: {
    operationId: string;
    expectedRevision: number;
    operatorId: string;
    action: 'resolve';
    approvedAt: number;
    approvalEvidence: ManufacturingManualApprovalEvidence;
  }): ManufacturingRunStatus {
    const operatorId = input.operatorId.trim();
    const evidence = input.approvalEvidence;
    if (
      !operatorId ||
      input.action !== 'resolve' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isSafeInteger(input.approvedAt) ||
      input.approvedAt <= 0 ||
      evidence.version !== 'manufacturing-run-hmac/v1' ||
      evidence.timestamp !== input.approvedAt ||
      !evidence.kid.trim() ||
      !evidence.audience.trim() ||
      !evidence.companyId.trim() ||
      !evidence.nonce.trim() ||
      !/^[0-9a-f]{64}$/i.test(evidence.bodyHash)
    ) {
      throw new Error('SIGNED_MANUAL_RESOLUTION_REQUIRED');
    }
    const run = requireRun(this.store, input.operationId);
    const approval = {
      operationId: run.operationId,
      expectedRevision: input.expectedRevision,
      operatorId,
      action: input.action,
      approvedAt: input.approvedAt,
      hmac: evidence,
    };
    const approvalHash = canonicalHash(
      approval,
      'manufacturing-run/manual-resolution-approval/v1'
    );
    const resolved = this.store.resolveRunManualWithArtifact({
      operationId: run.operationId,
      expectedRevision: input.expectedRevision,
      artifact: {
        artifactType: `manual_resolution_approval:${input.expectedRevision}`,
        artifactHash: approvalHash,
        artifact: approval,
        at: this.clock.now(),
      },
      reason: `signed manual resolution by ${operatorId}; evidence ${approvalHash}`,
      at: this.clock.now(),
    });
    this.propagateDependencyFailure(run.operationId, approvalHash);
    return statusOf(resolved);
  }

  private async processCreating(
    run: ManufacturingRunRecord,
    context: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    const stored = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    let current = await this.readManufacturingOrderIfPresent(run.manufacturingOrderId);
    this.renewOwnership(context);
    if (!current) {
      if (
        this.store.getRunArtifact(run.operationId, CREATE_DISPATCH_BARRIER_ARTIFACT)
      ) {
        return {
          operationId: run.operationId,
          outcome: 'create_recovery_pending',
        };
      }
      this.renewOwnership(context);
      this.consumeRateBudget();
      const prepared = await this.client.prepareMutation<ManufacturingOrder>(
        stored.begin.createRequest.method,
        stored.begin.createRequest.path,
        {
          params: stored.begin.createRequest.query,
          body: stored.begin.createRequest.body,
        }
      );
      this.renewOwnership(context);
      this.store.bindRunArtifact({
        operationId: run.operationId,
        artifactType: CREATE_DISPATCH_BARRIER_ARTIFACT,
        artifactHash: requestHash(stored.begin.createRequest),
        artifact: {
          correlationId: prepared.correlationId,
          requestHash: requestHash(stored.begin.createRequest),
        },
        at: this.clock.now(),
      });
      this.testHooks?.afterCreateFenced?.();
      this.renewOwnership(context);
      try {
        await prepared.dispatch();
      } catch {
        // A prepared mutation that opened its request is always treated as
        // possibly applied. Deterministic readback is the only recovery path.
      }
      this.renewOwnership(context);
      current = await this.readManufacturingOrderIfPresent(run.manufacturingOrderId);
      this.renewOwnership(context);
      if (!current) {
        return {
          operationId: run.operationId,
          outcome: 'create_recovery_pending',
        };
      }
    }
    if (
      current.isCancelled ||
      current.isCompleted ||
      ['cancelled', 'completed', 'closed'].includes(
        current.status?.toLowerCase() ?? ''
      )
    ) {
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: 'deterministic manufacturing order is not writable',
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: 'conflict' };
    }
    let snapshot: ManufacturingSnapshot;
    try {
      snapshot = captureManufacturingSnapshot(current, stored.begin);
    } catch (error) {
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: `deterministic create identity conflict: ${safeError(error)}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: 'conflict' };
    }
    if (!current.timestamp) {
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: 'expanded manufacturing order has no current timestamp',
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: 'conflict' };
    }
    const beginSnapshot: StoredBeginSnapshot = {
      snapshot,
      orderTimestamp: current.timestamp,
    };
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: BEGIN_SNAPSHOT_ARTIFACT,
      artifactHash: canonicalHash(
        beginSnapshot,
        'manufacturing-run/begin-snapshot/v1'
      ),
      artifact: beginSnapshot,
      at: this.clock.now(),
    });
    let sourceSerialBinding: StoredSourceSerialBinding;
    try {
      sourceSerialBinding = await locateSourceSerialBinding({
        client: this.client,
        consumeRateBudget: () => this.consumeRateBudget(),
        afterRead: () => this.renewOwnership(context),
        snapshot,
        begin: stored.begin,
        selectedLocationId: storedLocation(stored, current),
        manufacturingOrderTimestamp: current.timestamp,
      });
    } catch (error) {
      if (
        error instanceof CoordinatorRateLimitedError ||
        isRetryablePreDispatchError(error) ||
        isWorkerOwnershipError(error)
      ) {
        throw error;
      }
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      const evidence = error instanceof SourceSerialBindingError
        ? error.evidence
        : createManufacturingRunBlockerEvidence({
          code: 'SOURCE_SERIAL_BINDING_FAILED',
          rawLineId: 'unresolved',
          productId: stored.begin.normalizedIdentity.finishedProductId,
          sku: 'unknown',
          requiredQuantity: '1',
          availableQuantity: 'unknown',
          locationId: storedLocation(stored, current),
          sourceSerial: stored.begin.normalizedIdentity.sourceSerial,
          detail: safeError(error),
        });
      this.recordBlockerEvidence(run.operationId, evidence);
      const blocked = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'blocked',
        reason: `source serial binding blocked: ${evidence.code}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: blocked.state };
    }
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: SOURCE_SERIAL_BINDING_ARTIFACT,
      artifactHash: canonicalHash(
        sourceSerialBinding,
        'manufacturing-run/source-serial-binding/v1'
      ),
      artifact: sourceSerialBinding,
      at: this.clock.now(),
    });
    this.renewOwnership(context);
    const latest = requireRun(this.store, run.operationId);
    const collecting = this.store.transitionRun({
      operationId: run.operationId,
      expectedRevision: latest.stateRevision,
      toState: 'collecting',
      reason: 'deterministic MO identity and expanded begin snapshot verified',
      at: this.clock.now(),
    });
    return { operationId: run.operationId, outcome: collecting.state };
  }

  private async processReady(
    run: ManufacturingRunRecord,
    context: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    const { begin } = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    const beginSnapshot = artifactValue<StoredBeginSnapshot>(
      this.store,
      run.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    let current: ManufacturingOrder;
    try {
      current = await this.readManufacturingOrder(run.manufacturingOrderId);
      this.renewOwnership(context);
      validateManufacturingSnapshot(current, beginSnapshot.snapshot, begin);
      if (current.timestamp !== beginSnapshot.orderTimestamp) {
        throw new Error(
          `MANUFACTURING_TIMESTAMP_DRIFT: expected ${beginSnapshot.orderTimestamp}, got ${
            current.timestamp ?? 'missing'
          }`
        );
      }
      const sourceBinding = await this.revalidateSourceSerialBinding({
        operationId: run.operationId,
        current,
        snapshot: beginSnapshot.snapshot,
        begin,
        selectedLocationId: storedLocation(
          artifactValue<StoredBeginPlan>(
            this.store,
            run.operationId,
            BEGIN_PLAN_ARTIFACT
          ),
          current
        ),
        context,
      });
      const componentInventoryExpectation =
        await this.verifyAuthoritativeInventory(
        run.operationId,
        this.store.listComponentIntents(run.operationId),
        sourceBinding,
        current,
        context
      );
      this.store.bindRunArtifact({
        operationId: run.operationId,
        artifactType: COMPONENT_INVENTORY_EXPECTATION_ARTIFACT,
        artifactHash: canonicalHash(
          componentInventoryExpectation,
          'manufacturing-run/component-inventory-expectation/v1'
        ),
        artifact: componentInventoryExpectation,
        at: this.clock.now(),
      });
    } catch (error) {
      if (
        error instanceof CoordinatorRateLimitedError ||
        isRetryablePreDispatchError(error) ||
        isWorkerOwnershipError(error)
      ) {
        throw error;
      }
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: `pre-dispatch readback drift: ${safeError(error)}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: 'conflict' };
    }
    let plan: ManufacturingBatchPlan;
    try {
      plan = planManufacturingBatch({
        current,
        begin,
        intents: this.store.listComponentIntents(run.operationId).map((intent) => ({
          rawLineId: intent.rawLineId,
          productId: intent.productId,
          quantity: intent.quantity,
          locationId: intent.locationId,
          ...(intent.sublocation === null
            ? {}
            : { sublocation: intent.sublocation }),
          serialized: intent.serialized,
          serialNumbers: intent.serialNumbers,
        })),
        output: {
          serialNumber: begin.normalizedIdentity.finishedSerial,
          locationId: storedLocation(
            artifactValue<StoredBeginPlan>(
              this.store,
              run.operationId,
              BEGIN_PLAN_ARTIFACT
            ),
            current
          ),
        },
      });
    } catch (error) {
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      const conflicted = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: `unsupported pre-write shape: ${safeError(error)}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: conflicted.state };
    }
    this.renewOwnership(context);
    const preparedRequestHash = requestHash(plan.request);
    const dispatchPlan: StoredDispatchPlan = {
      mode: plan.mode,
      beginTimestamp: beginSnapshot.orderTimestamp,
      immutableIntentHash: plan.hashes.immutableIntent,
      completePreWriteHash: plan.hashes.completePreWriteShape,
      expectedPostStateHash: plan.hashes.expectedPostState,
      requestHash: preparedRequestHash,
      requestBody: plan.request.body,
      componentInventoryExpectation: artifactValue<
        StoredComponentInventoryExpectation
      >(
        this.store,
        run.operationId,
        COMPONENT_INVENTORY_EXPECTATION_ARTIFACT
      ),
    };
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: DISPATCH_PLAN_ARTIFACT,
      artifactHash: canonicalHash(
        {
          mode: dispatchPlan.mode,
          beginTimestamp: dispatchPlan.beginTimestamp,
          immutableIntentHash: dispatchPlan.immutableIntentHash,
          completePreWriteHash: dispatchPlan.completePreWriteHash,
          expectedPostStateHash: dispatchPlan.expectedPostStateHash,
          requestHash: dispatchPlan.requestHash,
          componentInventoryExpectation:
            dispatchPlan.componentInventoryExpectation,
        },
        'manufacturing-run/dispatch-plan/v1'
      ),
      artifact: dispatchPlan,
      at: this.clock.now(),
    });
    this.store.bindPlanHashes({
      operationId: run.operationId,
      immutableIntentHash: run.immutableIntentHash,
      completePreWriteHash: plan.hashes.completePreWriteShape,
      expectedPostStateHash: plan.hashes.expectedPostState,
      preparedRequestHash,
    });
    this.renewOwnership(context);
    const latest = requireRun(this.store, run.operationId);
    const preparedRun = this.store.transitionRun({
      operationId: run.operationId,
      expectedRevision: latest.stateRevision,
      toState: 'prepared',
      reason: 'full immutable MO mutation prepared',
      at: this.clock.now(),
    });
    this.testHooks?.afterPrepared?.();
    return this.processPrepared(preparedRun, context);
  }

  private async processPrepared(
    run: ManufacturingRunRecord,
    context: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    if (
      this.store.getRunArtifact(
        run.operationId,
        OPERATION_COMPLETION_PLAN_ARTIFACT
      )
    ) {
      return this.processOperationCompletionPrepared(run, context);
    }
    const storedPlan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    const { begin } = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    const beginSnapshot = artifactValue<StoredBeginSnapshot>(
      this.store,
      run.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    this.renewOwnership(context);
    this.consumeRateBudget();
    const preparedMutation = await this.client.prepareMutation<ManufacturingOrder>(
      'PUT',
      '/manufacturing-orders',
      { body: storedPlan.requestBody }
    );
    this.renewOwnership(context);
    try {
      await this.assertPreparedPlanCurrent({
        run,
        begin,
        beginSnapshot,
        storedPlan,
        context,
      });
    } catch (error) {
      if (
        error instanceof CoordinatorRateLimitedError ||
        isRetryablePreDispatchError(error) ||
        isWorkerOwnershipError(error)
      ) {
        throw error;
      }
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: `final dispatch-fence revalidation failed: ${safeError(error)}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: 'conflict' };
    }
    this.renewOwnership(context);
    const uncertain = this.store.markDispatchUncertain({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      reason: `prepared ${preparedMutation.correlationId}; socket may open next`,
      at: this.clock.now(),
    });
    this.testHooks?.afterDispatchFenced?.();
    this.renewOwnership(context, false);
    try {
      await preparedMutation.dispatch();
    } catch (error) {
      this.renewOwnership(context, false);
      if (
        isExactProviderSerialExclusion(error) &&
        await this.verifyDefinitiveNoWrite(
          error,
          'manufacturing-pick-batch-v1'
        )
      ) {
        const noWrite = this.store.markFailedNoWriteAttested({
          operationId: run.operationId,
          expectedRevision: uncertain.stateRevision,
          attestationDomain: 'manufacturing-pick-batch-v1',
          evidenceHash: requestHash({
            domain: 'manufacturing-pick-batch-v1',
            name: error.name,
            message: error.message,
            statusCode: error.statusCode,
            providerCode: error.apiError?.code ?? null,
          }),
          reason: `canary-attested definitive no-write: ${safeError(error)}`,
          at: this.clock.now(),
        });
        this.propagateDependencyOutcome(run.operationId);
        return { operationId: run.operationId, outcome: noWrite.state };
      }
      if (
        isExactWorkOrderPartNoWriteRejection(error) &&
        await this.verifyDefinitiveNoWrite(
          error,
          'manufacturing-pick-batch-v1'
        )
      ) {
        this.bindDispatchNoWriteRejection(uncertain, storedPlan);
        if (await this.captureDispatchNoWriteProof(
          uncertain,
          storedPlan,
          context
        )) {
          return { operationId: run.operationId, outcome: 'dispatch_uncertain' };
        }
      }
    }
    return this.reconcileReadback(
      requireRun(this.store, run.operationId),
      context
    );
  }

  private async captureDispatchNoWriteProof(
    run: ManufacturingRunRecord,
    storedPlan: StoredDispatchPlan,
    context?: WorkerClaimContext
  ): Promise<boolean> {
    try {
      const rejectionRecord = this.requireDispatchNoWriteRejection(
        run,
        storedPlan
      );
      const begin = artifactValue<StoredBeginPlan>(
        this.store,
        run.operationId,
        BEGIN_PLAN_ARTIFACT
      ).begin;
      const beginSnapshot = artifactValue<StoredBeginSnapshot>(
        this.store,
        run.operationId,
        BEGIN_SNAPSHOT_ARTIFACT
      );
      const current = await this.assertPreparedPlanCurrent({
        run,
        begin,
        beginSnapshot,
        storedPlan,
        context,
        requireQueueClaim: false,
      });
      const currentPreWriteHash = canonicalHash(
        canonicalManufacturingOrderWriteShape(current),
        'manufacturing-run/complete-pre-write/v1'
      );
      if (
        currentPreWriteHash !== storedPlan.completePreWriteHash ||
        current.timestamp !== storedPlan.beginTimestamp
      ) {
        return false;
      }
      const latest = requireRun(this.store, run.operationId);
      if (
        latest.state !== 'dispatch_uncertain' ||
        latest.stateRevision !== run.stateRevision
      ) {
        return false;
      }
      const inventoryArtifact = this.store.getRunArtifact(
        run.operationId,
        COMPONENT_INVENTORY_EXPECTATION_ARTIFACT
      );
      const sourceBindingArtifact = this.store.getRunArtifact(
        run.operationId,
        SOURCE_SERIAL_BINDING_ARTIFACT
      );
      if (!inventoryArtifact || !sourceBindingArtifact) return false;
      const proof: StoredDispatchNoWriteProof = {
        schemaVersion: 'manufacturing-dispatch-no-write-proof/v1',
        domain: 'manufacturing-pick-batch-v1',
        dispatchUncertainRevision: run.stateRevision,
        requestHash: storedPlan.requestHash,
        completePreWriteHash: storedPlan.completePreWriteHash,
        preWriteTimestamp: storedPlan.beginTimestamp,
        componentInventoryExpectationHash: inventoryArtifact.artifactHash,
        sourceSerialBindingHash: sourceBindingArtifact.artifactHash,
        rejectionArtifactHash: rejectionRecord.artifactHash,
        observedAt: this.clock.now().toISOString(),
      };
      this.store.bindRunArtifact({
        operationId: run.operationId,
        artifactType: dispatchNoWriteProofArtifactType(run.stateRevision),
        artifactHash: canonicalHash(
          proof,
          'manufacturing-run/dispatch-no-write-proof/v1'
        ),
        artifact: proof,
        at: this.clock.now(),
      });
      return true;
    } catch (proofError) {
      if (
        proofError instanceof CoordinatorRateLimitedError ||
        isWorkerOwnershipError(proofError)
      ) {
        throw proofError;
      }
      return false;
    }
  }

  private bindDispatchNoWriteRejection(
    run: ManufacturingRunRecord,
    storedPlan: StoredDispatchPlan
  ): ManufacturingRunArtifactRecord {
    const rejection: StoredDispatchNoWriteRejection = {
      schemaVersion: 'manufacturing-dispatch-no-write-rejection/v1',
      domain: 'manufacturing-pick-batch-v1',
      dispatchUncertainRevision: run.stateRevision,
      requestHash: storedPlan.requestHash,
      rejection: {
        name: 'InflowApiError',
        statusCode: 400,
        providerCode: 'WorkOrderPartNegativeInventory',
      },
    };
    return this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: dispatchNoWriteRejectionArtifactType(run.stateRevision),
      artifactHash: canonicalHash(
        rejection,
        'manufacturing-run/dispatch-no-write-rejection/v1'
      ),
      artifact: rejection,
      at: this.clock.now(),
    }).artifact;
  }

  private requireDispatchNoWriteRejection(
    run: ManufacturingRunRecord,
    storedPlan: StoredDispatchPlan
  ): ManufacturingRunArtifactRecord {
    const record = this.store.getRunArtifact(
      run.operationId,
      dispatchNoWriteRejectionArtifactType(run.stateRevision)
    );
    if (
      !record ||
      !record.artifact ||
      typeof record.artifact !== 'object' ||
      Array.isArray(record.artifact)
    ) {
      throw new Error('PROVEN_NO_WRITE_REJECTION_INCOMPLETE');
    }
    const artifact = record.artifact as Partial<StoredDispatchNoWriteRejection>;
    const rejection = artifact.rejection;
    if (
      artifact.schemaVersion !==
        'manufacturing-dispatch-no-write-rejection/v1' ||
      artifact.domain !== 'manufacturing-pick-batch-v1' ||
      artifact.dispatchUncertainRevision !== run.stateRevision ||
      artifact.requestHash !== storedPlan.requestHash ||
      artifact.requestHash !== run.preparedRequestHash ||
      !rejection ||
      rejection.name !== 'InflowApiError' ||
      rejection.statusCode !== 400 ||
      rejection.providerCode !== 'WorkOrderPartNegativeInventory'
    ) {
      throw new Error('PROVEN_NO_WRITE_REJECTION_INVALID');
    }
    return record;
  }

  private async prepareOperationCompletionFromStage(
    run: ManufacturingRunRecord,
    current: ManufacturingOrder,
    context?: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    if (!(await this.operationCompletionGate())) {
      const staged = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: run.stateRevision,
        toState: 'staged_awaiting_operations',
        reason: 'exact operation stage verified; automatic completion gate closed',
        at: this.clock.now(),
      });
      return { operationId: run.operationId, outcome: staged.state };
    }
    if (!current.timestamp) {
      throw new Error('MANUFACTURING_TIMESTAMP_MISSING');
    }
    const { begin } = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    const storedBegin = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    const existingIntent =
      optionalArtifactValue<StoredOperationCompletionIntent>(
        this.store,
        run.operationId,
        OPERATION_COMPLETION_INTENT_ARTIFACT
      );
    const dispatchPlan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    await this.verifyStagedComponentInventory(
      dispatchPlan.componentInventoryExpectation,
      context
    );
    const intent: StoredOperationCompletionIntent = existingIntent ?? {
      schemaVersion: 'manufacturing-operation-completion-intent/v1',
      completedAt: this.clock.now().toISOString(),
      outputLocationId: storedLocation(storedBegin, current),
      outputSublocation: null,
    };
    let plan: ManufacturingOperationCompletionPlan;
    try {
      plan = planManufacturingOperationCompletion({
        current,
        begin,
        completedAt: intent.completedAt,
        output: {
          serialNumber: begin.normalizedIdentity.finishedSerial,
          locationId: intent.outputLocationId,
          ...(intent.outputSublocation === null
            ? {}
            : { sublocation: intent.outputSublocation }),
        },
      });
    } catch (error) {
      const staged = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: run.stateRevision,
        toState: 'staged_awaiting_operations',
        reason:
          `exact operation stage verified; automatic completion ineligible: ${safeError(error)}`,
        at: this.clock.now(),
      });
      return { operationId: run.operationId, outcome: staged.state };
    }
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: OPERATION_COMPLETION_INTENT_ARTIFACT,
      artifactHash: canonicalHash(
        intent,
        'manufacturing-run/operation-completion-intent-artifact/v1'
      ),
      artifact: intent,
      at: this.clock.now(),
    });
    const storedPlan: StoredOperationCompletionPlan = {
      schemaVersion: 'manufacturing-operation-completion-plan/v1',
      stageTimestamp: current.timestamp,
      completedAt: plan.completedAt,
      operationIds: plan.operationIds,
      immutableIntentHash: plan.hashes.immutableIntent,
      preStateHash: plan.hashes.preState,
      expectedPostStateHash: plan.hashes.expectedPostState,
      requestHash: requestHash(plan.request),
      requestBody: plan.request.body,
    };
    this.store.bindRunArtifact({
      operationId: run.operationId,
      artifactType: OPERATION_COMPLETION_PLAN_ARTIFACT,
      artifactHash: canonicalHash(
        {
          schemaVersion: storedPlan.schemaVersion,
          stageTimestamp: storedPlan.stageTimestamp,
          completedAt: storedPlan.completedAt,
          operationIds: storedPlan.operationIds,
          immutableIntentHash: storedPlan.immutableIntentHash,
          preStateHash: storedPlan.preStateHash,
          expectedPostStateHash: storedPlan.expectedPostStateHash,
          requestHash: storedPlan.requestHash,
        },
        'manufacturing-run/operation-completion-plan-artifact/v1'
      ),
      artifact: storedPlan,
      at: this.clock.now(),
    });
    const prepared = this.store.markOperationCompletionPrepared({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      reason: 'exact Assembly operation completion mutation prepared',
      at: this.clock.now(),
    });
    return { operationId: run.operationId, outcome: prepared.state };
  }

  private async processOperationCompletionPrepared(
    run: ManufacturingRunRecord,
    context: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    if (!(await this.operationCompletionGate())) {
      const staged = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: run.stateRevision,
        toState: 'staged_awaiting_operations',
        reason: 'automatic operation completion gate closed before dispatch',
        at: this.clock.now(),
      });
      return { operationId: run.operationId, outcome: staged.state };
    }
    const storedPlan = artifactValue<StoredOperationCompletionPlan>(
      this.store,
      run.operationId,
      OPERATION_COMPLETION_PLAN_ARTIFACT
    );
    const dispatchPlan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    const intent = artifactValue<StoredOperationCompletionIntent>(
      this.store,
      run.operationId,
      OPERATION_COMPLETION_INTENT_ARTIFACT
    );
    const { begin } = artifactValue<StoredBeginPlan>(
      this.store,
      run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    try {
      const current = await this.readManufacturingOrder(run.manufacturingOrderId);
      this.renewOwnership(context);
      if (
        current.timestamp !== storedPlan.stageTimestamp ||
        manufacturingOperationCompletionStateHash(current) !==
          storedPlan.preStateHash
      ) {
        throw new Error('OPERATION_COMPLETION_PRE_WRITE_DRIFT');
      }
      const sourceBinding = artifactValue<StoredSourceSerialBinding>(
        this.store,
        run.operationId,
        SOURCE_SERIAL_BINDING_ARTIFACT
      );
      if (!exactSourceSerialApplied(current, sourceBinding)) {
        throw new Error('SOURCE_SERIAL_STAGE_DRIFT');
      }
      await this.verifyStagedComponentInventory(
        dispatchPlan.componentInventoryExpectation,
        context
      );
      await this.verifyOutputSerialAvailable(begin, intent, context);
      const replanned = planManufacturingOperationCompletion({
        current,
        begin,
        completedAt: intent.completedAt,
        output: {
          serialNumber: begin.normalizedIdentity.finishedSerial,
          locationId: intent.outputLocationId,
          ...(intent.outputSublocation === null
            ? {}
            : { sublocation: intent.outputSublocation }),
        },
      });
      if (
        replanned.hashes.immutableIntent !== storedPlan.immutableIntentHash ||
        replanned.hashes.preState !== storedPlan.preStateHash ||
        replanned.hashes.expectedPostState !==
          storedPlan.expectedPostStateHash ||
        requestHash(replanned.request) !== storedPlan.requestHash ||
        stableStringify(replanned.request.body) !==
          stableStringify(storedPlan.requestBody)
      ) {
        throw new Error('OPERATION_COMPLETION_PLAN_DRIFT');
      }
      if (!(await this.operationCompletionGate())) {
        const staged = this.store.transitionRun({
          operationId: run.operationId,
          expectedRevision: run.stateRevision,
          toState: 'staged_awaiting_operations',
          reason: 'automatic operation completion gate closed at dispatch fence',
          at: this.clock.now(),
        });
        return { operationId: run.operationId, outcome: staged.state };
      }
    } catch (error) {
      if (
        error instanceof CoordinatorRateLimitedError ||
        isRetryablePreDispatchError(error) ||
        isWorkerOwnershipError(error)
      ) {
        throw error;
      }
      this.renewOwnership(context);
      const latest = requireRun(this.store, run.operationId);
      const conflicted = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: latest.stateRevision,
        toState: 'conflict',
        reason: `operation completion dispatch fence failed: ${safeError(error)}`,
        at: this.clock.now(),
      });
      this.propagateDependencyOutcome(run.operationId);
      return { operationId: run.operationId, outcome: conflicted.state };
    }
    this.consumeRateBudget();
    const preparedMutation = await this.client.prepareMutation<ManufacturingOrder>(
      'PUT',
      '/manufacturing-orders',
      { body: storedPlan.requestBody }
    );
    this.renewOwnership(context);
    if (!(await this.operationCompletionGate())) {
      const staged = this.store.transitionRun({
        operationId: run.operationId,
        expectedRevision: run.stateRevision,
        toState: 'staged_awaiting_operations',
        reason: 'automatic operation completion gate closed at socket fence',
        at: this.clock.now(),
      });
      return { operationId: run.operationId, outcome: staged.state };
    }
    const barrier: StoredOperationCompletionDispatchBarrier = {
      schemaVersion:
        'manufacturing-operation-completion-dispatch-barrier/v1',
      correlationId: preparedMutation.correlationId,
      requestHash: storedPlan.requestHash,
    };
    const uncertain = this.store.fenceOperationCompletionDispatch({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      reason:
        `operation completion prepared ${preparedMutation.correlationId}; socket may open next`,
      artifact: {
        artifactType: OPERATION_COMPLETION_DISPATCH_BARRIER_ARTIFACT,
        artifactHash: canonicalHash(
          barrier,
          'manufacturing-run/operation-completion-dispatch-barrier/v1'
        ),
        artifact: barrier,
        at: this.clock.now(),
      },
      at: this.clock.now(),
    });
    this.testHooks?.afterDispatchFenced?.();
    this.renewOwnership(context, false);
    try {
      await preparedMutation.dispatch();
    } catch (error) {
      this.renewOwnership(context, false);
      if (
        isExactProviderSerialExclusion(error) &&
        await this.verifyDefinitiveNoWrite(
          error,
          'manufacturing-operation-completion-v1'
        )
      ) {
        const noWrite = this.store.markFailedNoWriteAttested({
          operationId: run.operationId,
          expectedRevision: uncertain.stateRevision,
          attestationDomain: 'manufacturing-operation-completion-v1',
          evidenceHash: requestHash({
            domain: 'manufacturing-operation-completion-v1',
            name: error.name,
            message: error.message,
            statusCode: error.statusCode,
            providerCode: error.apiError?.code ?? null,
          }),
          reason: `canary-attested definitive no-write: ${safeError(error)}`,
          at: this.clock.now(),
        });
        this.propagateDependencyOutcome(run.operationId);
        return { operationId: run.operationId, outcome: noWrite.state };
      }
    }
    return this.reconcileReadback(
      requireRun(this.store, run.operationId),
      context
    );
  }

  private async reconcileReadback(
    run: ManufacturingRunRecord,
    context?: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    if (run.state !== 'dispatch_uncertain') {
      return { operationId: run.operationId, outcome: run.state };
    }
    const completionPlan =
      optionalArtifactValue<StoredOperationCompletionPlan>(
        this.store,
        run.operationId,
        OPERATION_COMPLETION_PLAN_ARTIFACT
      );
    const completionBarrier =
      optionalArtifactValue<StoredOperationCompletionDispatchBarrier>(
        this.store,
        run.operationId,
        OPERATION_COMPLETION_DISPATCH_BARRIER_ARTIFACT
      );
    if (completionBarrier) {
      if (
        !completionPlan ||
        completionBarrier.requestHash !== completionPlan.requestHash
      ) {
        const conflicted = this.store.transitionRun({
          operationId: run.operationId,
          expectedRevision: run.stateRevision,
          toState: 'conflict',
          reason: 'operation completion dispatch barrier is incomplete or corrupt',
          at: this.clock.now(),
        });
        this.propagateDependencyOutcome(run.operationId);
        return { operationId: run.operationId, outcome: conflicted.state };
      }
      return this.reconcileOperationCompletionReadback(
        run,
        completionPlan,
        context
      );
    }
    const plan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    for (let attempt = 0; attempt < this.readbackAttempts; attempt += 1) {
      try {
        if (context) this.renewOwnership(context, false);
        const current = await this.readManufacturingOrder(run.manufacturingOrderId);
        if (context) this.renewOwnership(context, false);
        const sourceBinding = optionalArtifactValue<StoredSourceSerialBinding>(
          this.store,
          run.operationId,
          SOURCE_SERIAL_BINDING_ARTIFACT
        );
        if (
          expectedPostHash(current) === plan.expectedPostStateHash &&
          timestampAdvanced(plan.beginTimestamp, current.timestamp) &&
          (!sourceBinding || exactSourceSerialApplied(current, sourceBinding))
        ) {
          if (context) this.renewOwnership(context, false);
          const latest = requireRun(this.store, run.operationId);
          const reason = 'exact expected-post readback with advanced timestamp';
          if (plan.mode === 'operation-staging') {
            return await this.prepareOperationCompletionFromStage(
              latest,
              current,
              context
              );
          }
          return this.completeVerifiedRun(latest, current, reason);
        }
      } catch (error) {
        if (
          error instanceof CoordinatorRateLimitedError ||
          isWorkerOwnershipError(error)
        ) {
          throw error;
        }
        // All provider/read transport errors remain uncertain.
      }
      if (attempt + 1 < this.readbackAttempts) {
        await this.clock.sleep(this.readbackDelayMs);
      }
    }
    return { operationId: run.operationId, outcome: 'dispatch_uncertain' };
  }

  private async reconcileOperationCompletionReadback(
    run: ManufacturingRunRecord,
    plan: StoredOperationCompletionPlan,
    context?: WorkerClaimContext
  ): Promise<WorkerTickResult> {
    for (let attempt = 0; attempt < this.readbackAttempts; attempt += 1) {
      try {
        if (context) this.renewOwnership(context, false);
        const current = await this.readManufacturingOrder(
          run.manufacturingOrderId
        );
        if (context) this.renewOwnership(context, false);
        const currentStateHash =
          manufacturingOperationCompletionStateHash(current);
        if (currentStateHash === plan.expectedPostStateHash) {
          if (!timestampAdvanced(plan.stageTimestamp, current.timestamp)) {
            if (attempt + 1 < this.readbackAttempts) {
              await this.clock.sleep(this.readbackDelayMs);
            }
            continue;
          }
          const sourceBinding = artifactValue<StoredSourceSerialBinding>(
            this.store,
            run.operationId,
            SOURCE_SERIAL_BINDING_ARTIFACT
          );
          if (!exactSourceSerialApplied(current, sourceBinding)) {
            throw new Error('SOURCE_SERIAL_COMPLETION_READBACK_DRIFT');
          }
          await this.verifyCompletionInventory(
            run,
            current,
            sourceBinding,
            context
          );
          if (context) this.renewOwnership(context, false);
          return this.completeVerifiedRun(
            requireRun(this.store, run.operationId),
            current,
            'exact operation-completion readback with advanced timestamp'
          );
        } else if (
          currentStateHash !== plan.preStateHash ||
          current.timestamp !== plan.stageTimestamp
        ) {
          const latest = requireRun(this.store, run.operationId);
          const conflicted = this.store.transitionRun({
            operationId: run.operationId,
            expectedRevision: latest.stateRevision,
            toState: 'conflict',
            reason:
              'operation completion readback is neither exact pre-state nor exact expected post-state',
            at: this.clock.now(),
          });
          this.propagateDependencyOutcome(run.operationId);
          return { operationId: run.operationId, outcome: conflicted.state };
        }
      } catch (error) {
        if (
          error instanceof CoordinatorRateLimitedError ||
          isWorkerOwnershipError(error)
        ) {
          throw error;
        }
        // Provider/read transport and eventually consistent inventory remain
        // uncertain. The durable dispatch barrier forbids replay.
      }
      if (attempt + 1 < this.readbackAttempts) {
        await this.clock.sleep(this.readbackDelayMs);
      }
    }
    return { operationId: run.operationId, outcome: 'dispatch_uncertain' };
  }

  private completeVerifiedRun(
    run: ManufacturingRunRecord,
    current: ManufacturingOrder,
    reason: string
  ): WorkerTickResult {
    const at = this.clock.now();
    if (run.parentOperationId && run.parentRawLineId) {
      const completion = this.prepareParentVerifiedPutLine(run, current);
      if (!completion) {
        const verified = this.store.transitionRun({
          operationId: run.operationId,
          expectedRevision: run.stateRevision,
          toState: 'applied_verified',
          reason,
          at,
        });
        this.blockParent(
          run.parentOperationId,
          'child verified without one exact per-unit parent-compatible put-line'
        );
        return { operationId: run.operationId, outcome: verified.state };
      }
      const completed =
        this.store.transitionAppliedVerifiedChildWithArtifact({
          operationId: run.operationId,
          expectedRevision: run.stateRevision,
          reason,
          parentOperationId: completion.parentOperationId,
          parentRawLineId: completion.parentRawLineId,
          parentChildIndex: completion.parentChildIndex,
          artifact: completion.artifact,
          at,
        });
      this.testHooks?.afterDependencySatisfied?.();
      this.finalizeSatisfiedDependencyLine({
        operationId: completion.parentOperationId,
        rawLineId: completion.parentRawLineId,
      });
      return {
        operationId: run.operationId,
        outcome: completed.run.state,
      };
    }
    const verified = this.store.transitionRun({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      toState: 'applied_verified',
      reason,
      at,
    });
    return { operationId: run.operationId, outcome: verified.state };
  }

  private prepareParentVerifiedPutLine(
    child: ManufacturingRunRecord,
    readback: ManufacturingOrder
  ): {
    parentOperationId: string;
    parentRawLineId: string;
    parentChildIndex: number;
    artifact: {
      artifactType: string;
      artifactHash: string;
      artifact: StoredParentVerifiedPut;
      at: Date;
    };
  } | undefined {
    if (!child.parentOperationId || !child.parentRawLineId) return undefined;
    const parent = requireRun(this.store, child.parentOperationId);
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      parent.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const expectedLine = parentRawLine(snapshot, child.parentRawLineId);
    const dependencies = this.store.listDependencies(parent.operationId);
    const dependency = dependencies.find(
      (candidate) =>
        candidate.childOperationId === child.operationId &&
        candidate.parentRawLineId === child.parentRawLineId
    );
    if (!dependency) {
      throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
    }
    const finishedSerial = String(
      (child.canonicalIdentity as { finishedSerial?: unknown }).finishedSerial ?? ''
    ).trim();
    const exact = (readback.putLines ?? []).filter(
      (put) =>
        put.manufacturingOrderLineId === child.rootLineId &&
        put.productId === expectedLine.productId &&
        normalizeDecimal(put.quantity?.standardQuantity ?? '') ===
          '1' &&
        put.quantity?.serialNumbers?.length === 1 &&
        put.quantity.serialNumbers[0]?.trim() === finishedSerial &&
        Boolean(put.locationId?.trim())
    );
    if (exact.length !== 1) {
      return undefined;
    }
    const put = exact[0]!;
    const evidence: StoredParentVerifiedPut = {
      parentOperationId: parent.operationId,
      parentRawLineId: child.parentRawLineId,
      parentChildIndex: dependency.parentChildIndex,
      childOperationId: child.operationId,
      productId: expectedLine.productId,
      quantity: '1',
      locationId: put.locationId!.trim(),
      sublocation: put.sublocation?.trim() || null,
      serialNumbers: [finishedSerial],
    };
    return {
      parentOperationId: parent.operationId,
      parentRawLineId: child.parentRawLineId,
      parentChildIndex: dependency.parentChildIndex,
      artifact: {
        artifactType: PARENT_VERIFIED_PUT_ARTIFACT,
        artifactHash: canonicalHash(
          evidence,
          'manufacturing-run/parent-verified-put/v1'
        ),
        artifact: evidence,
        at: this.clock.now(),
      },
    };
  }

  finalizeSatisfiedDependencyLine(input: {
    operationId: string;
    rawLineId: string;
  }): ManufacturingRunStatus {
    const parent = requireRun(this.store, input.operationId);
    if (!['collecting', 'waiting_dependencies'].includes(parent.state)) {
      return statusOf(parent);
    }
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      parent.operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const expectedLine = parentRawLine(snapshot, input.rawLineId);
    const lineDependencies = this.store.listDependencies(parent.operationId)
      .filter((candidate) => candidate.parentRawLineId === input.rawLineId);
    if (
      lineDependencies.length === 0 ||
      lineDependencies.some((candidate) => candidate.satisfiedAt === null)
    ) {
      return statusOf(parent);
    }

    const numericQuantity = Number(normalizeDecimal(expectedLine.quantity));
    if (
      !Number.isSafeInteger(numericQuantity) ||
      numericQuantity <= 0 ||
      numericQuantity > 100 ||
      lineDependencies.length !== numericQuantity ||
      lineDependencies.some(
        (candidate, index) => candidate.parentChildIndex !== index
      )
    ) {
      this.blockParent(
        parent.operationId,
        'verified recursive children do not match exact parent quantity'
      );
      return statusOf(requireRun(this.store, parent.operationId));
    }
    const childEvidence = lineDependencies.map((candidate) =>
      artifactValue<StoredParentVerifiedPut>(
        this.store,
        candidate.childOperationId,
        PARENT_VERIFIED_PUT_ARTIFACT
      )
    );
    const reference = childEvidence[0]!;
    const serialNumbers = childEvidence
      .map((item) => item.serialNumbers[0])
      .sort();
    if (
      childEvidence.some(
        (item) =>
          item.parentOperationId !== parent.operationId ||
          item.parentRawLineId !== input.rawLineId ||
          item.productId !== expectedLine.productId ||
          item.quantity !== '1' ||
          item.locationId !== reference.locationId ||
          item.sublocation !== reference.sublocation ||
          item.serialNumbers.length !== 1
      ) ||
      new Set(serialNumbers).size !== serialNumbers.length
    ) {
      this.blockParent(
        parent.operationId,
        'verified recursive children disagree on exact location or serial identity'
      );
      return statusOf(requireRun(this.store, parent.operationId));
    }
    this.registerComponent({
      operationId: parent.operationId,
      rawLineId: input.rawLineId,
      productId: expectedLine.productId,
      quantity: expectedLine.quantity,
      locationId: reference.locationId,
      sublocation: reference.sublocation ?? undefined,
      serialized: true,
      serialNumbers,
    });
    this.advanceParentIfReady(parent.operationId);
    return statusOf(requireRun(this.store, parent.operationId));
  }

  private blockParent(operationId: string, reason: string): void {
    const current = requireRun(this.store, operationId);
    if (!TERMINAL_OR_MANUAL_STATES.has(current.state)) {
      this.store.transitionRun({
        operationId: current.operationId,
        expectedRevision: current.stateRevision,
        toState: 'blocked',
        reason,
        at: this.clock.now(),
      });
    }
    this.propagateDependencyOutcome(operationId);
  }

  private recordBlockerEvidence(
    operationId: string,
    evidence: ManufacturingRunBlockerEvidence
  ): void {
    const run = requireRun(this.store, operationId);
    this.store.bindRunArtifact({
      operationId,
      artifactType:
        `${BLOCKER_EVIDENCE_ARTIFACT}:revision:${run.stateRevision}`,
      artifactHash: canonicalHash(
        evidence,
        'manufacturing-run/blocker-evidence/v1'
      ),
      artifact: evidence,
      at: this.clock.now(),
    });
  }

  private recordNotificationContext(
    operationId: string,
    remarks: string,
    at: Date
  ): void {
    const notificationRemarks = splitManufacturingRunRemarks(
      remarks
    ).notificationRemarks;
    if (notificationRemarks === null) return;
    const artifactHash = canonicalHash(
      { remarks: notificationRemarks },
      'manufacturing-run/notification-context/v1'
    );
    this.store.bindRunArtifact({
      operationId,
      artifactType: `${NOTIFICATION_CONTEXT_ARTIFACT_PREFIX}${artifactHash}`,
      artifactHash,
      artifact: { remarks: notificationRemarks },
      at,
    });
  }

  private advanceParentIfReady(operationId: string): void {
    const run = requireRun(this.store, operationId);
    if (!['collecting', 'waiting_dependencies'].includes(run.state)) return;
    if (isLegacyStoredRun(run)) {
      this.quarantineLegacyStoredRun(run);
      return;
    }
    const { snapshot } = artifactValue<StoredBeginSnapshot>(
      this.store,
      operationId,
      BEGIN_SNAPSHOT_ARTIFACT
    );
    const expectedLineIds = consumableManufacturingLines(snapshot)
      .map((line) => line.rawLineId)
      .sort();
    const registered = new Set(
      this.store.listComponentIntents(operationId).map((intent) => intent.rawLineId)
    );
    const dependencies = this.store.listDependencies(operationId);
    const unsatisfied = dependencies.filter((dependency) => dependency.satisfiedAt === null);
    if (
      unsatisfied.length > 0 ||
      expectedLineIds.some((rawLineId) => !registered.has(rawLineId))
    ) {
      return;
    }
    const latest = requireRun(this.store, operationId);
    const ready = this.store.transitionRun({
      operationId,
      expectedRevision: latest.stateRevision,
      toState: 'ready',
      reason: 'all exact component intents and dependencies satisfied',
      at: this.clock.now(),
    });
    if (ready.state !== 'ready') throw new Error('RUN_READY_TRANSITION_FAILED');
  }

  private quarantineLegacyStoredRun(
    run: ManufacturingRunRecord
  ): ManufacturingRunRecord {
    if (
      run.state === 'dispatch_uncertain' ||
      TERMINAL_OR_MANUAL_STATES.has(run.state)
    ) {
      return run;
    }
    const blocked = this.store.transitionRun({
      operationId: run.operationId,
      expectedRevision: run.stateRevision,
      toState: 'blocked',
      reason:
        'legacy manufacturing-run-identity/v1 is read/reconcile-only after v2 cutover',
      at: this.clock.now(),
    });
    this.propagateDependencyOutcome(run.operationId);
    return blocked;
  }

  private async revalidateSourceSerialBinding(input: {
    operationId: string;
    current: ManufacturingOrder;
    snapshot: ManufacturingSnapshot;
    begin: ManufacturingRunBeginPlan;
    selectedLocationId: string;
    context?: WorkerClaimContext;
    requireQueueClaim?: boolean;
  }): Promise<StoredSourceSerialBinding> {
    if (
      input.begin.normalizedIdentity.schemaVersion !==
      'manufacturing-run-identity/v2'
    ) {
      throw new Error('LEGACY_MANUFACTURING_RUN_RECONCILE_ONLY');
    }
    if (!input.current.timestamp) {
      throw new Error('MANUFACTURING_TIMESTAMP_MISSING');
    }
    const stored = artifactValue<StoredSourceSerialBinding>(
      this.store,
      input.operationId,
      SOURCE_SERIAL_BINDING_ARTIFACT
    );
    const actual = await locateSourceSerialBinding({
      client: this.client,
      consumeRateBudget: () => this.consumeRateBudget(),
      afterRead: () => {
        if (input.context) {
          this.renewOwnership(
            input.context,
            input.requireQueueClaim ?? true
          );
        }
      },
      snapshot: input.snapshot,
      begin: input.begin,
      selectedLocationId: input.selectedLocationId,
      manufacturingOrderTimestamp: input.current.timestamp,
    });
    if (stableStringify(actual) !== stableStringify(stored)) {
      throw new Error(
        `SOURCE_SERIAL_BINDING_DRIFT: expected ${canonicalHash(stored, 'manufacturing-run/source-serial-binding/v1')}, got ${canonicalHash(actual, 'manufacturing-run/source-serial-binding/v1')}`
      );
    }
    return stored;
  }

  private async assertPreparedPlanCurrent(input: {
    run: ManufacturingRunRecord;
    begin: ManufacturingRunBeginPlan;
    beginSnapshot: StoredBeginSnapshot;
    storedPlan: StoredDispatchPlan;
    context?: WorkerClaimContext;
    requireQueueClaim?: boolean;
  }): Promise<ManufacturingOrder> {
    const current = await this.readManufacturingOrder(
      input.run.manufacturingOrderId
    );
    if (input.context) {
      this.renewOwnership(
        input.context,
        input.requireQueueClaim ?? true
      );
    }
    validateManufacturingSnapshot(
      current,
      input.beginSnapshot.snapshot,
      input.begin
    );
    if (current.timestamp !== input.beginSnapshot.orderTimestamp) {
      throw new Error(
        `MANUFACTURING_TIMESTAMP_DRIFT: expected ${input.beginSnapshot.orderTimestamp}, got ${current.timestamp ?? 'missing'}`
      );
    }
    const storedBegin = artifactValue<StoredBeginPlan>(
      this.store,
      input.run.operationId,
      BEGIN_PLAN_ARTIFACT
    );
    const sourceBinding = await this.revalidateSourceSerialBinding({
      operationId: input.run.operationId,
      current,
      snapshot: input.beginSnapshot.snapshot,
      begin: input.begin,
      selectedLocationId: storedLocation(storedBegin, current),
      context: input.context,
      requireQueueClaim: input.requireQueueClaim,
    });
    const intents = this.store.listComponentIntents(input.run.operationId);
    const componentInventoryExpectation =
      await this.verifyAuthoritativeInventory(
      input.run.operationId,
      intents,
      sourceBinding,
      current,
      input.context,
      input.requireQueueClaim
    );
    if (
      stableStringify(componentInventoryExpectation) !==
      stableStringify(input.storedPlan.componentInventoryExpectation)
    ) {
      throw new Error('COMPONENT_INVENTORY_EXPECTATION_DRIFT');
    }
    const replanned = planManufacturingBatch({
      current,
      begin: input.begin,
      intents: intents.map((intent) => ({
        rawLineId: intent.rawLineId,
        productId: intent.productId,
        quantity: intent.quantity,
        locationId: intent.locationId,
        ...(intent.sublocation === null
          ? {}
          : { sublocation: intent.sublocation }),
        serialized: intent.serialized,
        serialNumbers: intent.serialNumbers,
      })),
      output: {
        serialNumber: input.begin.normalizedIdentity.finishedSerial,
        locationId: storedLocation(storedBegin, current),
      },
    });
    if (
      replanned.mode !== input.storedPlan.mode ||
      replanned.hashes.immutableIntent !==
        input.storedPlan.immutableIntentHash ||
      replanned.hashes.completePreWriteShape !==
        input.storedPlan.completePreWriteHash ||
      replanned.hashes.expectedPostState !==
        input.storedPlan.expectedPostStateHash ||
      requestHash(replanned.request) !== input.storedPlan.requestHash ||
      stableStringify(replanned.request.body) !==
        stableStringify(input.storedPlan.requestBody)
    ) {
      throw new Error('PREPARED_PLAN_DRIFT');
    }
    return current;
  }

  private async verifyOutputSerialAvailable(
    begin: ManufacturingRunBeginPlan,
    intent: StoredOperationCompletionIntent,
    context: WorkerClaimContext
  ): Promise<void> {
    this.consumeRateBudget();
    const product = await this.client.get<Product>(
      `/products/${begin.normalizedIdentity.finishedProductId}`,
      { include: ['inventoryLines'] }
    );
    this.renewOwnership(context);
    if (product.trackSerials !== true && product.isSerialized !== true) {
      throw new Error('FINISHED_PRODUCT_SERIALIZATION_DRIFT');
    }
    const outputSerial = normalizeSerial(
      begin.normalizedIdentity.finishedSerial
    );
    const positiveHoldings = (product.inventoryLines ?? []).filter(
      (line) =>
        normalizeSerial(line.serial ?? '') === outputSerial &&
        decimalPositive(line.quantityOnHand)
    );
    if (positiveHoldings.length > 0) {
      throw new Error(
        `OUTPUT_SERIAL_CONTENTION: ${intent.outputLocationId}/${outputSerial}`
      );
    }
  }

  private async verifyCompletionInventory(
    run: ManufacturingRunRecord,
    current: ManufacturingOrder,
    sourceBinding: StoredSourceSerialBinding,
    context?: WorkerClaimContext
  ): Promise<void> {
    const identity = run.canonicalIdentity as {
      finishedProductId?: unknown;
      finishedSerial?: unknown;
    };
    const finishedProductId = String(identity.finishedProductId ?? '');
    const finishedSerial = normalizeSerial(
      String(identity.finishedSerial ?? '')
    );
    const putLines = current.putLines ?? [];
    const expectedPut = putLines[0];
    if (
      putLines.length !== 1 ||
      !expectedPut ||
      (
        expectedPut.manufacturingOrderLineId != null &&
        expectedPut.manufacturingOrderLineId !== run.rootLineId
      ) ||
      expectedPut.productId !== finishedProductId ||
      expectedPut.quantity?.serialNumbers?.length !== 1 ||
      normalizeSerial(expectedPut.quantity.serialNumbers[0] ?? '') !==
        finishedSerial ||
      normalizeDecimal(expectedPut.quantity.standardQuantity ?? '') !== '1' ||
      !expectedPut.locationId?.trim()
    ) {
      throw new Error('OUTPUT_PUT_LINE_READBACK_DRIFT');
    }
    this.consumeRateBudget();
    const finishedProduct = await this.client.get<Product>(
      `/products/${finishedProductId}`,
      { include: ['inventoryLines'] }
    );
    if (context) this.renewOwnership(context, false);
    if (
      finishedProduct.trackSerials !== true &&
      finishedProduct.isSerialized !== true
    ) {
      throw new Error('FINISHED_PRODUCT_SERIALIZATION_DRIFT');
    }
    const outputHoldings = (finishedProduct.inventoryLines ?? []).filter(
      (line) =>
        normalizeSerial(line.serial ?? '') === finishedSerial &&
        decimalPositive(line.quantityOnHand)
    );
    if (
      outputHoldings.length !== 1 ||
      outputHoldings[0]!.locationId !== expectedPut.locationId ||
      (outputHoldings[0]!.sublocation ?? '') !==
        (expectedPut.sublocation ?? '') ||
      normalizeDecimal(outputHoldings[0]!.quantityOnHand ?? '') !== '1'
    ) {
      throw new Error('OUTPUT_SERIAL_INVENTORY_READBACK_DRIFT');
    }
    this.consumeRateBudget();
    const sourceProduct = await this.client.get<Product>(
      `/products/${sourceBinding.productId}`,
      { include: ['inventoryLines'] }
    );
    if (context) this.renewOwnership(context, false);
    if (
      sourceProduct.trackSerials !== true &&
      sourceProduct.isSerialized !== true
    ) {
      throw new Error('SOURCE_PRODUCT_SERIALIZATION_DRIFT');
    }
    const sourceStillHeld = (sourceProduct.inventoryLines ?? []).some(
      (line) =>
        normalizeSerial(line.serial ?? '') === sourceBinding.sourceSerial &&
        decimalPositive(line.quantityOnHand)
    );
    if (sourceStillHeld) {
      throw new Error('SOURCE_SERIAL_INVENTORY_NOT_CONSUMED');
    }
    const dispatchPlan = artifactValue<StoredDispatchPlan>(
      this.store,
      run.operationId,
      DISPATCH_PLAN_ARTIFACT
    );
    await this.verifyStagedComponentInventory(
      dispatchPlan.componentInventoryExpectation,
      context
    );
  }

  private async verifyAuthoritativeInventory(
    operationId: string,
    intents: ComponentIntentRecord[],
    sourceBinding: StoredSourceSerialBinding,
    current: ManufacturingOrder,
    context?: WorkerClaimContext,
    requireQueueClaim = true
  ): Promise<StoredComponentInventoryExpectation> {
    const expectation: StoredComponentInventoryExpectation = {
      schemaVersion: 'manufacturing-component-inventory-expectation/v1',
      serialized: [],
      bulkBuckets: [],
    };
    const currentLines = flattenManufacturingLines(current.lines ?? []);
    const currentIntentOwnership = (
      intent: ComponentIntentRecord
    ): { owned: boolean; nested: boolean } => {
      const matches = currentLines.filter(
        (line) => line.manufacturingOrderLineId === intent.rawLineId
      );
      if (matches.length !== 1 || matches[0]!.productId !== intent.productId) {
        return { owned: false, nested: false };
      }
      const quantity = matches[0]!.quantity?.standardQuantity ??
        matches[0]!.quantity?.uomQuantity;
      try {
        const owned = quantity !== undefined &&
          normalizeDecimal(quantity) === normalizeDecimal(intent.quantity);
        const parentId = matches[0]!.parentManufacturingOrderLineId;
        const parents = parentId === null || parentId === undefined
          ? []
          : currentLines.filter(
              (line) => line.manufacturingOrderLineId === parentId
            );
        return {
          owned,
          nested:
            owned &&
            parents.length === 1 &&
            parents[0]!.parentManufacturingOrderLineId !== null &&
            parents[0]!.parentManufacturingOrderLineId !== undefined,
        };
      } catch {
        return { owned: false, nested: false };
      }
    };
    const byProduct = new Map<string, ComponentIntentRecord[]>();
    for (const intent of intents) {
      const rows = byProduct.get(intent.productId) ?? [];
      rows.push(intent);
      byProduct.set(intent.productId, rows);
    }
    for (const [productId, productIntents] of [...byProduct.entries()].sort()) {
      this.consumeRateBudget();
      const product = await this.client.get<Product>(
        `/products/${productId}`,
        { include: ['inventoryLines'] }
      );
      if (context) this.renewOwnership(context, requireQueueClaim);
      this.consumeRateBudget();
      const summary = await this.client.get<ProductSummary>(
        `/products/${productId}/summary`,
        { include: ['locationSummaries', 'sublocationSummaries'] }
      );
      if (context) this.renewOwnership(context, requireQueueClaim);
      const authoritativeSerialized =
        product.trackSerials === true || product.isSerialized === true;
      const positiveInventoryByBucket = new Map<string, number>();
      for (const line of product.inventoryLines ?? []) {
        const locationId = line.locationId?.trim() ?? '';
        if (!locationId) continue;
        const quantityText = line.quantityOnHand;
        const quantity = quantityText === undefined
          ? 0
          : Number(normalizeDecimal(quantityText));
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        const bucketKey = `${locationId}\0${line.sublocation?.trim() ?? ''}`;
        positiveInventoryByBucket.set(
          bucketKey,
          (positiveInventoryByBucket.get(bucketKey) ?? 0) + quantity
        );
      }
      const aggregateAvailable = summary.quantityAvailable === undefined
        ? Number.NaN
        : Number(normalizeDecimal(summary.quantityAvailable));
      const serialOwners = new Map<string, string>();
      const requiredByBucket = new Map<string, number>();
      const unboundSerializedBuckets = new Set<string>();
      for (const intent of productIntents) {
        if (intent.serialized !== authoritativeSerialized) {
          throw new Error(
            `COMPONENT_SERIALIZATION_DRIFT: ${intent.rawLineId}`
          );
        }
        const quantity = Number(normalizeDecimal(intent.quantity));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
          throw new Error(`COMPONENT_QUANTITY_DRIFT: ${intent.rawLineId}`);
        }
        const bucketKey =
          `${intent.locationId}\0${intent.sublocation ?? ''}`;
        requiredByBucket.set(
          bucketKey,
          (requiredByBucket.get(bucketKey) ?? 0) + quantity
        );
        if (!authoritativeSerialized) continue;
        const bound = intent.rawLineId === sourceBinding.rawLineId;
        if (bound) {
          if (
            intent.productId !== sourceBinding.productId ||
            quantity !== 1 ||
            intent.locationId !== sourceBinding.locationId ||
            intent.sublocation !== sourceBinding.sublocation ||
            intent.serialNumbers.length !== 1 ||
            normalizeSerial(intent.serialNumbers[0]!) !== sourceBinding.sourceSerial
          ) {
            throw new Error('SOURCE_SERIAL_BINDING_INTENT_DRIFT');
          }
        } else {
          unboundSerializedBuckets.add(bucketKey);
        }
        for (const serial of intent.serialNumbers) {
          const serialKey = normalizeSerial(serial);
          const existingOwner = serialOwners.get(serialKey);
          if (existingOwner) {
            throw new Error(
              `SERIALIZED_INVENTORY_COLLISION: ${serial}/${existingOwner}/${intent.rawLineId}`
            );
          }
          serialOwners.set(serialKey, intent.rawLineId);
          const exact = (product.inventoryLines ?? []).filter((line) =>
            normalizeSerial(line.serial ?? '') === normalizeSerial(serial) &&
            line.locationId === intent.locationId &&
            (line.sublocation ?? '') === (intent.sublocation ?? '') &&
            decimalPositive(line.quantityOnHand)
          );
          if (exact.length !== 1) {
            throw new Error(
              `SERIALIZED_INVENTORY_DRIFT: ${intent.rawLineId}/${serial}`
            );
          }
        }
      }
      if (authoritativeSerialized) {
        expectation.serialized.push({
          productId,
          serials: [...serialOwners.keys()].sort(),
        });
      }
      for (const [bucketKey, required] of requiredByBucket) {
        const [locationId, sublocation = ''] = bucketKey.split('\0');
        const currentStatus = current.status?.trim().toLowerCase() ?? '';
        const bucketIntents = productIntents.filter(
          (intent) =>
            intent.locationId === locationId &&
            (intent.sublocation ?? '') === sublocation
        );
        const bucketOwnership = bucketIntents.map((intent) => ({
          intent,
          ownership: currentIntentOwnership(intent),
        }));
        const allowBuildReserved =
          current.isCancelled !== true &&
          current.isCompleted !== true &&
          !['cancelled', 'canceled', 'completed', 'closed'].includes(
            currentStatus
          ) &&
          current.locationId === locationId &&
          bucketIntents.length > 0 &&
          bucketOwnership.every((entry) => entry.ownership.owned);
        const ownedBuildReservedQuantity = allowBuildReserved
          ? bucketOwnership.reduce(
              (sum, entry) =>
                entry.ownership.nested
                  ? sum + Number(normalizeDecimal(entry.intent.quantity))
                  : sum,
              0
            )
          : 0;
        const locations = (summary.locationSummaries ?? []).filter(
          (candidate) => candidate.locationId === locationId
        );
        const aggregateEffectiveAvailable = authoritativeSerialized
          ? aggregateAvailable
          : effectiveBuildRunAvailableQuantity(summary, {
              allowBuildReserved,
              ...(allowBuildReserved
                ? {
                    ...(ownedBuildReservedQuantity > 0
                      ? { ownedBuildReservedQuantity }
                      : {}),
                    ownedManufacturingReservedQuantity: required,
                  }
                : {}),
              requiredQuantity: required,
            });
        const aggregateFallbackEligible =
          (summary.locationSummaries ?? []).length === 0 &&
          Number.isFinite(aggregateEffectiveAvailable) &&
          aggregateEffectiveAvailable >= required &&
          positiveInventoryByBucket.size === 1 &&
          (positiveInventoryByBucket.get(bucketKey) ?? 0) >= required &&
          (
            !authoritativeSerialized ||
            !unboundSerializedBuckets.has(bucketKey)
          );
        if (locations.length !== 1) {
          if (aggregateFallbackEligible) {
            if (!authoritativeSerialized) {
              if (summary.quantityOnHand === undefined) {
                throw new Error(
                  `INVENTORY_ON_HAND_MISSING: ${productId}/${locationId}/${sublocation}`
                );
              }
              const expected = subtractDecimal(
                parseDecimal(summary.quantityOnHand),
                parseDecimal(String(required))
              );
              if (compareDecimal(expected, ZERO_DECIMAL) < 0) {
                throw new Error(
                  `INVENTORY_ON_HAND_DRIFT: ${productId}/${locationId}/${sublocation}`
                );
              }
              expectation.bulkBuckets.push({
                productId,
                locationId,
                sublocation,
                expectedQuantityOnHand: decimalToString(expected),
              });
            }
            continue;
          }
          throw new Error(`INVENTORY_LOCATION_DRIFT: ${productId}/${locationId}`);
        }
        const location = locations[0]!;
        const sublocations = (location.sublocationSummaries ?? []).filter(
          (candidate) => (candidate.sublocation ?? '') === sublocation
        );
        const exactSummary = sublocations.length === 1
          ? sublocations[0]!
          : sublocation === '' && (location.sublocationSummaries ?? []).length === 0
            ? location
            : undefined;
        const availableText = exactSummary?.quantityAvailable;
        const available = availableText === undefined
          ? Number.NaN
          : Number(normalizeDecimal(availableText));
        const effectiveAvailable = authoritativeSerialized
          ? available
          : effectiveBuildRunAvailableQuantity(exactSummary, {
              allowBuildReserved,
              ...(allowBuildReserved
                ? {
                    ...(ownedBuildReservedQuantity > 0
                      ? { ownedBuildReservedQuantity }
                      : {}),
                    ownedManufacturingReservedQuantity: required,
                  }
                : {}),
              requiredQuantity: required,
            });
        const onHand = exactSummary?.quantityOnHand === undefined
          ? Number.NaN
          : Number(normalizeDecimal(exactSummary.quantityOnHand));
        if (
          authoritativeSerialized &&
          unboundSerializedBuckets.has(bucketKey) &&
          (!Number.isFinite(onHand) || available < onHand)
        ) {
          throw new Error(
            `SERIALIZED_AVAILABILITY_AMBIGUOUS: ${productId}/${locationId}/${sublocation}`
          );
        }
        if (!Number.isFinite(effectiveAvailable) || effectiveAvailable < required) {
          throw new Error(
            `INVENTORY_AVAILABLE_DRIFT: ${productId}/${locationId}/${sublocation}`
          );
        }
        if (!authoritativeSerialized) {
          const baselineOnHand = exactSummary?.quantityOnHand ??
            (aggregateFallbackEligible ? summary.quantityOnHand : undefined);
          if (baselineOnHand === undefined) {
            throw new Error(
              `INVENTORY_ON_HAND_MISSING: ${productId}/${locationId}/${sublocation}`
            );
          }
          const expected = subtractDecimal(
            parseDecimal(baselineOnHand),
            parseDecimal(String(required))
          );
          if (compareDecimal(expected, ZERO_DECIMAL) < 0) {
            throw new Error(
              `INVENTORY_ON_HAND_DRIFT: ${productId}/${locationId}/${sublocation}`
            );
          }
          expectation.bulkBuckets.push({
            productId,
            locationId,
            sublocation,
            expectedQuantityOnHand: decimalToString(expected),
          });
        }
      }
    }
    const boundIntent = intents.filter(
      (intent) => intent.rawLineId === sourceBinding.rawLineId
    );
    if (boundIntent.length !== 1) {
      throw new Error(
        `SOURCE_SERIAL_BINDING_INTENT_COUNT: ${operationId}/${boundIntent.length}`
      );
    }
    expectation.serialized.sort((left, right) =>
      left.productId.localeCompare(right.productId)
    );
    expectation.bulkBuckets.sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right))
    );
    return expectation;
  }

  private async verifyStagedComponentInventory(
    expectation: StoredComponentInventoryExpectation,
    context?: WorkerClaimContext
  ): Promise<void> {
    if (
      expectation.schemaVersion !==
      'manufacturing-component-inventory-expectation/v1'
    ) {
      throw new Error('COMPONENT_INVENTORY_EXPECTATION_INVALID');
    }
    for (const expected of expectation.serialized) {
      this.consumeRateBudget();
      const product = await this.client.get<Product>(
        `/products/${expected.productId}`,
        { include: ['inventoryLines'] }
      );
      if (context) this.renewOwnership(context, false);
      if (
        product.trackSerials !== true &&
        product.isSerialized !== true
      ) {
        throw new Error(
          `COMPONENT_SERIALIZATION_DRIFT: ${expected.productId}`
        );
      }
      for (const serial of expected.serials) {
        if (
          (product.inventoryLines ?? []).some(
            (line) =>
              normalizeSerial(line.serial ?? '') === serial &&
              decimalPositive(line.quantityOnHand)
          )
        ) {
          throw new Error(
            `COMPONENT_SERIAL_INVENTORY_NOT_CONSUMED: ${expected.productId}/${serial}`
          );
        }
      }
    }
    const byProduct = new Map<
      string,
      StoredComponentInventoryExpectation['bulkBuckets']
    >();
    for (const bucket of expectation.bulkBuckets) {
      const rows = byProduct.get(bucket.productId) ?? [];
      rows.push(bucket);
      byProduct.set(bucket.productId, rows);
    }
    for (const [productId, buckets] of [...byProduct.entries()].sort()) {
      this.consumeRateBudget();
      const summary = await this.client.get<ProductSummary>(
        `/products/${productId}/summary`,
        { include: ['locationSummaries', 'sublocationSummaries'] }
      );
      if (context) this.renewOwnership(context, false);
      for (const bucket of buckets) {
        const locations = (summary.locationSummaries ?? []).filter(
          (candidate) => candidate.locationId === bucket.locationId
        );
        const sublocations = locations.length === 1
          ? (locations[0]!.sublocationSummaries ?? []).filter(
              (candidate) =>
                (candidate.sublocation ?? '') === bucket.sublocation
            )
          : [];
        const actual =
          sublocations.length === 1
            ? sublocations[0]!.quantityOnHand
            : bucket.sublocation === '' &&
                locations.length === 1 &&
                (locations[0]!.sublocationSummaries ?? []).length === 0
              ? locations[0]!.quantityOnHand
              : (summary.locationSummaries ?? []).length === 0
                ? summary.quantityOnHand
                : undefined;
        if (
          actual === undefined ||
          normalizeDecimal(actual) !== bucket.expectedQuantityOnHand
        ) {
          throw new Error(
            `COMPONENT_BULK_INVENTORY_NOT_CONSUMED: ${productId}/${bucket.locationId}/${bucket.sublocation}`
          );
        }
      }
    }
  }

  private async readManufacturingOrderIfPresent(
    manufacturingOrderId: string
  ): Promise<ManufacturingOrder | undefined> {
    try {
      return await this.readManufacturingOrder(manufacturingOrderId);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async readManufacturingOrder(
    manufacturingOrderId: string
  ): Promise<ManufacturingOrder> {
    this.consumeRateBudget();
    return this.client.get<ManufacturingOrder>(
      `/manufacturing-orders/${manufacturingOrderId}`,
      { include: MO_TRACE_INCLUDE }
    );
  }

  private consumeRateBudget(): void {
    const result = this.store.consumeRateBudget({ now: this.clock.now() });
    if (!result.allowed) throw new CoordinatorRateLimitedError(result.retryAfterMs);
  }

  private renewOwnership(
    context: WorkerClaimContext,
    requireQueueClaim = true
  ): void {
    this.store.renewWorkerOwnership({
      ...(requireQueueClaim ? { operationId: context.operationId } : {}),
      workerId: this.workerId,
      epoch: context.epoch,
      leaseMs: this.leaseMs,
      now: this.clock.now(),
    });
  }

  private releaseClaimForRetry(
    context: WorkerClaimContext,
    retryAfterMs?: number
  ): boolean {
    try {
      const now = this.clock.now();
      this.store.releaseQueueClaim({
        operationId: context.operationId,
        workerId: this.workerId,
        epoch: context.epoch,
        leaseMs: this.leaseMs,
        now,
        ...(retryAfterMs === undefined
          ? {}
          : { availableAt: new Date(now.getTime() + retryAfterMs) }),
      });
      return true;
    } catch (error) {
      if (isWorkerOwnershipError(error)) return false;
      throw error;
    }
  }
}

function parentRawLine(
  snapshot: ManufacturingSnapshot,
  rawLineId: string | null
): ManufacturingSnapshot['lines'][number] {
  if (!rawLineId) throw new Error('PARENT_RAW_LINE_ID_REQUIRED');
  const matches = snapshot.lines.filter((line) => line.rawLineId === rawLineId);
  if (matches.length !== 1 || matches[0]!.parentRawLineId === null) {
    throw new Error(`UNKNOWN_COMPONENT_RAW_LINE: ${rawLineId}`);
  }
  return matches[0]!;
}

function consumableRawLine(
  snapshot: ManufacturingSnapshot,
  rawLineId: string | null
): ManufacturingSnapshot['lines'][number] {
  const line = parentRawLine(snapshot, rawLineId);
  if (line.structural === true) {
    throw new Error(`STRUCTURAL_COMPONENT_RAW_LINE: ${rawLineId ?? 'missing'}`);
  }
  return line;
}

function decimalPositive(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const normalized = normalizeDecimal(value);
    return !normalized.startsWith('-') && normalized !== '0';
  } catch {
    return false;
  }
}

async function locateSourceSerialBinding(input: {
  client: ManufacturingCoordinatorClient;
  consumeRateBudget: () => void;
  afterRead: () => void;
  snapshot: ManufacturingSnapshot;
  begin: ManufacturingRunBeginPlan;
  selectedLocationId: string;
  manufacturingOrderTimestamp: string;
}): Promise<StoredSourceSerialBinding> {
  const sourceSerial = input.begin.normalizedIdentity.sourceSerial;
  const candidates = input.snapshot.lines
    .filter((line) => line.rawLineId !== input.snapshot.rootLineId)
    .sort((left, right) => left.rawLineId.localeCompare(right.rawLineId));
  const productIds = [...new Set(candidates.map((line) => line.productId))].sort();
  const productById = new Map<string, Product>();
  for (const productId of productIds) {
    input.consumeRateBudget();
    const product = await input.client.get<Product>(
      `/products/${productId}`,
      { include: ['inventoryLines'] }
    );
    input.afterRead();
    productById.set(productId, product);
  }
  const ownerRows: Array<{
    rawLineId: string;
    productId: string;
    sku: string;
    quantity: string;
    structural: boolean;
    locationId: string;
    sublocation: string | null;
    inventoryLineTimestamp: string | null;
    inventoryLine: NonNullable<Product['inventoryLines']>[number];
    productTimestamp: string | null;
  }> = [];
  for (const candidate of candidates) {
    const product = productById.get(candidate.productId);
    const matchingLines = (product?.inventoryLines ?? []).filter((line) =>
      normalizeSerial(line.serial ?? '') === sourceSerial &&
      decimalPositive(line.quantityOnHand)
    );
    for (const line of matchingLines) {
      ownerRows.push({
        rawLineId: candidate.rawLineId,
        productId: candidate.productId,
        sku: product?.sku?.trim() || 'unknown',
        quantity: candidate.quantity,
        structural: candidate.structural === true,
        locationId: line.locationId?.trim() || '',
        sublocation: line.sublocation?.trim() || null,
        inventoryLineTimestamp: line.timestamp?.trim() || null,
        inventoryLine: line,
        productTimestamp: product?.timestamp?.trim() || null,
      });
    }
  }
  const evidenceFor = (
    code: string,
    detail: string,
    owner = ownerRows[0]
  ): SourceSerialBindingError => new SourceSerialBindingError(createManufacturingRunBlockerEvidence({
    code,
    sku: owner?.sku ?? 'unknown',
    productId: owner?.productId ?? 'unresolved',
    rawLineId: owner?.rawLineId ?? 'unresolved',
    requiredQuantity: owner?.quantity ?? '1',
    availableQuantity: owner ? owner.inventoryLine.quantityOnHand ?? 'unknown' : '0',
    locationId: owner?.locationId || input.selectedLocationId,
    sourceSerial,
    detail,
  }));
  if (ownerRows.length === 0) {
    throw evidenceFor(
      'SOURCE_SERIAL_OWNER_MISSING',
      `source serial ${sourceSerial} has no positive inventory owner in the expanded manufacturing hierarchy`
    );
  }
  if (ownerRows.length > 1) {
    throw evidenceFor(
      'SOURCE_SERIAL_MULTIPLE_OWNERS',
      `source serial ${sourceSerial} resolved to ${ownerRows.length} raw-line inventory owners`
    );
  }
  const owner = ownerRows[0]!;
  if (owner.structural) {
    throw evidenceFor(
      'SOURCE_SERIAL_STRUCTURAL_OWNER',
      `source serial ${sourceSerial} belongs to expanded structural line ${owner.rawLineId}`,
      owner
    );
  }
  if (owner.quantity !== '1') {
    throw evidenceFor(
      'SOURCE_SERIAL_UNSUPPORTED_QUANTITY',
      `source serial owner ${owner.rawLineId} requires quantity ${owner.quantity}, not one`,
      owner
    );
  }
  if (owner.locationId !== input.selectedLocationId) {
    throw evidenceFor(
      'SOURCE_SERIAL_CROSS_LOCATION',
      `source serial ${sourceSerial} is at ${owner.locationId || 'unknown'}, not selected location ${input.selectedLocationId}`,
      owner
    );
  }
  const artifactBase = {
    schemaVersion: 'source_serial_binding/v1' as const,
    rawLineId: owner.rawLineId,
    productId: owner.productId,
    sourceSerial,
    locationId: owner.locationId,
    sublocation: owner.sublocation,
    manufacturingOrderTimestamp: input.manufacturingOrderTimestamp,
    inventoryLineTimestamp: owner.inventoryLineTimestamp,
  };
  return {
    ...artifactBase,
    inventoryReadbackHash: canonicalHash(
      {
        ...artifactBase,
        productTimestamp: owner.productTimestamp,
        inventoryLine: owner.inventoryLine,
      },
      'manufacturing-run/source-serial-binding-readback/v1'
    ),
  };
}

function normalizeSerial(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase();
}

function slackEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 500);
}

export function createManufacturingRunBlockerEvidence(
  input: Omit<ManufacturingRunBlockerEvidence, 'schemaVersion' | 'slackMessage'>
): ManufacturingRunBlockerEvidence {
  const slackMessage = [
    `Manufacturing blocked (${input.code}).`,
    `SKU: ${input.sku}.`,
    `Product: ${input.productId}.`,
    `Raw line: ${input.rawLineId}.`,
    `Required: ${input.requiredQuantity}.`,
    `Available: ${input.availableQuantity}.`,
    `Location: ${input.locationId}.`,
    input.sourceSerial ? `Source serial: ${input.sourceSerial}.` : '',
    input.detail,
  ].filter(Boolean).map(slackEscape).join(' ');
  return {
    schemaVersion: 'manufacturing-run-blocker/v1',
    ...input,
    slackMessage,
  };
}

function exactSourceSerialApplied(
  order: ManufacturingOrder,
  binding: StoredSourceSerialBinding
): boolean {
  const picks = (order.pickLines ?? []).filter(
    (pick) =>
      pick.productId === binding.productId &&
      pick.locationId === binding.locationId &&
      (pick.sublocation?.trim() || null) === binding.sublocation &&
      normalizeDecimal(pick.quantity?.standardQuantity ?? '') === '1' &&
      pick.quantity?.serialNumbers?.length === 1 &&
      normalizeSerial(pick.quantity.serialNumbers[0] ?? '') ===
        binding.sourceSerial
  );
  if (picks.length !== 1 || !picks[0]!.manufacturingOrderPickLineId) {
    return false;
  }
  const pickId = picks[0]!.manufacturingOrderPickLineId;
  const matchings = (order.pickMatchings ?? []).filter(
    (matching) =>
      matching.manufacturingOrderLineId === binding.rawLineId &&
      matching.manufacturingOrderPickLineId === pickId &&
      normalizeDecimal(matching.matchedQuantity ?? '') === '1' &&
      normalizeSerial(matching.serial ?? '') === binding.sourceSerial
  );
  return matchings.length === 1;
}

function storedLocation(
  stored: StoredBeginPlan,
  current: ManufacturingOrder
): string {
  const locationId = stored.locationId.trim() || current.locationId?.trim();
  if (!locationId) throw new Error('INVALID_OUTPUT_LOCATION');
  return locationId;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

export interface CoordinatorSingletonConfig {
  listenerHost: string;
  listenerExclusive: boolean;
  processLockPath: string;
  workerLeaseMs: number;
  launchdServiceLabels: string[];
  requestsPerMinute: number;
}

export function validateCoordinatorSingletonConfig(
  input: CoordinatorSingletonConfig
): Readonly<CoordinatorSingletonConfig> {
  const loopback =
    input.listenerHost === 'localhost' ||
    input.listenerHost === '127.0.0.1' ||
    input.listenerHost === '::1' ||
    (isIP(input.listenerHost) === 4 && input.listenerHost.startsWith('127.'));
  const valid =
    loopback &&
    input.listenerExclusive === true &&
    input.processLockPath.startsWith('/') &&
    input.workerLeaseMs > 0 &&
    Number.isSafeInteger(input.workerLeaseMs) &&
    input.launchdServiceLabels.length === 1 &&
    Boolean(input.launchdServiceLabels[0]?.trim()) &&
    input.requestsPerMinute === COORDINATOR_REQUESTS_PER_MINUTE;
  if (!valid) throw new Error('COORDINATOR_SINGLETON_CONFIG_INVALID');
  return Object.freeze({
    ...input,
    launchdServiceLabels: Object.freeze([...input.launchdServiceLabels]) as string[],
  });
}

export async function listenExclusiveLoopback(
  server: Server,
  input: { host: string; port: number }
): Promise<void> {
  validateCoordinatorSingletonConfig({
    listenerHost: input.host,
    listenerExclusive: true,
    processLockPath: '/coordinator-listener-validation-only',
    workerLeaseMs: 1,
    launchdServiceLabels: ['listener-validation-only'],
    requestsPerMinute: COORDINATOR_REQUESTS_PER_MINUTE,
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      host: input.host,
      port: input.port,
      exclusive: true,
    });
  });
}

export interface CoordinatorProcessLock {
  path: string;
  pid: number;
  release(): void;
}

export function acquireNonStaleProcessLock(
  path: string,
  pid = process.pid,
  hooks: {
    beforeStaleRename?: () => void;
    beforeReleaseRename?: () => void;
  } = {}
): CoordinatorProcessLock {
  if (!path.startsWith('/') || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('INVALID_COORDINATOR_PROCESS_LOCK');
  }
  const acquire = (): number => {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = lstatSync(path);
      if (!observed.isFile() || observed.isSymbolicLink()) {
        throw new Error('COORDINATOR_PROCESS_LOCK_INVALID');
      }
      const observedContents = readFileSync(path, 'utf8');
      let existingPid = Number.NaN;
      try {
        const current = JSON.parse(
          observedContents
        ) as { pid?: unknown };
        existingPid = Number(current.pid);
      } catch {
        throw new Error('COORDINATOR_PROCESS_LOCK_INVALID');
      }
      if (Number.isSafeInteger(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          throw new Error(`COORDINATOR_PROCESS_LOCK_HELD: ${existingPid}`);
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        }
      }
      hooks.beforeStaleRename?.();
      const quarantined = `${path}.stale-${randomUUID()}`;
      renameSync(path, quarantined);
      const moved = lstatSync(quarantined);
      if (
        moved.dev !== observed.dev ||
        moved.ino !== observed.ino ||
        readFileSync(quarantined, 'utf8') !== observedContents
      ) {
        if (!existsSync(path)) renameSync(quarantined, path);
        throw new Error('COORDINATOR_PROCESS_LOCK_IDENTITY_CHANGED');
      }
      try {
        const descriptor = openSync(path, 'wx', 0o600);
        rmSync(quarantined);
        return descriptor;
      } catch (replacementError) {
        if (!existsSync(path)) renameSync(quarantined, path);
        throw replacementError;
      }
    }
  };
  const descriptor = acquire();
  let released = false;
  try {
    writeFileSync(
      descriptor,
      stableStringify({
        pid,
        acquiredAt: new Date().toISOString(),
      })
    );
  } finally {
    closeSync(descriptor);
  }
  const acquiredIdentity = lstatSync(path);
  const acquiredContents = readFileSync(path, 'utf8');
  return {
    path,
    pid,
    release: () => {
      if (released) return;
      const observed = lstatSync(path);
      const observedContents = readFileSync(path, 'utf8');
      const current = JSON.parse(observedContents) as { pid?: unknown };
      if (current.pid !== pid) {
        throw new Error('COORDINATOR_PROCESS_LOCK_OWNERSHIP_LOST');
      }
      if (
        observed.dev !== acquiredIdentity.dev ||
        observed.ino !== acquiredIdentity.ino ||
        observedContents !== acquiredContents
      ) {
        throw new Error('COORDINATOR_PROCESS_LOCK_OWNERSHIP_LOST');
      }
      hooks.beforeReleaseRename?.();
      const quarantined = `${path}.released-${randomUUID()}`;
      renameSync(path, quarantined);
      const moved = lstatSync(quarantined);
      if (
        moved.dev !== acquiredIdentity.dev ||
        moved.ino !== acquiredIdentity.ino ||
        readFileSync(quarantined, 'utf8') !== acquiredContents
      ) {
        if (!existsSync(path)) renameSync(quarantined, path);
        throw new Error('COORDINATOR_PROCESS_LOCK_IDENTITY_CHANGED');
      }
      rmSync(quarantined);
      released = true;
    },
  };
}
