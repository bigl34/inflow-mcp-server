#!/usr/bin/env node

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  InflowApiError,
  InflowClient,
  type ClientTelemetry,
  type PreparedMutation,
} from '../client/inflow.js';
import { loadConfig, type InflowConfig } from '../config.js';
import { canonicalHash, stableStringify } from '../core/canonical-json.js';
import { normalizeDecimal } from '../core/decimal.js';
import {
  signCanaryAttestation,
  writeCanaryAttestation,
  type CanaryAttestation,
} from '../core/attestation.js';
import { MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION } from '../core/mutation.js';
import { tenantFingerprint } from '../core/preview-token.js';
import {
  planManufacturingBatch,
  planManufacturingRunBegin,
  captureManufacturingSnapshot,
  consumableManufacturingLines,
  type BeginManufacturingRunInput,
  type ManufacturingComponentIntent,
  type ManufacturingBatchPlan,
  type ManufacturingRunBeginPlan,
  type PlanManufacturingBatchInput,
} from '../services/manufacturing-run-planner.js';
import {
  canonicalManufacturingOrderProjection,
  flattenManufacturingLines,
  MO_TRACE_INCLUDE,
} from '../services/manufacturing-order-trace.js';
import {
  canonicalInventorySummaryProjection,
  canonicalSerialInventoryProjection,
  type WatchedSerialIdentity,
} from '../services/inventory-summaries.js';
import type {
  ManufacturingOrder,
  Product,
  ProductSummary,
} from '../types/inflow.js';

export const MANUFACTURING_PICK_BATCH_DOMAIN =
  'manufacturing-pick-batch-v1' as const;
export const MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT = 20;
export const MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS = [
  'deterministicCreateRecovery',
  'serverExpandedBom',
  'expandedSubassemblyLeafOnly',
  'operationsPreserved',
  'serializedMatchingShape',
  'nonSerializedMatchingShape',
  'existingIdentityPreserved',
  'unknownFieldsPreserved',
  'combinedAtomicWrite',
  'operationStagingAtomicWrite',
  'staleRowversionNoWrite',
  'stableReplay',
  'serialExclusion',
  'serialContentionNoWrite',
  'inventoryMovement',
  'exactReadback',
  'manualCompletion',
  'cleanup',
] as const;

export type ManufacturingPickBatchObservation =
  (typeof MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS)[number];

export interface ManufacturingPickBatchCanaryApproval {
  schemaVersion: 'manufacturing-pick-batch-canary-approval/v1';
  approved: boolean;
  approvalNonce: string;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  serializerVersion: string;
  contractVersion: string;
  scenarioManifestHash: string;
  issuedAt: string;
  expiresAt: string;
  approvedInertArtifactIds: string[];
}

export type ManufacturingPickBatchCanaryReadRole =
  | 'mo-readback'
  | 'no-write-readback'
  | 'inventory-before'
  | 'inventory-after'
  | 'inventory-after-cleanup';

export interface ManufacturingPickBatchCanaryScenarioRead {
  role: ManufacturingPickBatchCanaryReadRole;
  timing: 'before' | 'after';
  method: 'GET' | 'POST_READ';
  path: string;
  body?: Array<{ productId: string }>;
  expected: unknown;
}

export interface ManufacturingPickBatchCanaryScenarioPhase {
  phase: ManufacturingPickBatchCanaryAttemptPhase;
  requestSource:
    | 'begin-plan'
    | 'complete-plan'
    | 'staging-plan'
    | 'manifest'
    | 'none';
  request?: ManufacturingPickBatchMutationRequest;
  expectedOutcome: ManufacturingPickBatchCanaryAttemptOutcome;
  expectedRejection?: { statusCode: 409; code: string };
  reads: ManufacturingPickBatchCanaryScenarioRead[];
}

export interface ManufacturingPickBatchCanaryScenario {
  schemaVersion: 'manufacturing-pick-batch-canary-scenario/v1';
  scenarioId: string;
  beginInput: BeginManufacturingRunInput;
  batches: {
    complete: PlanManufacturingBatchInput;
    staging: PlanManufacturingBatchInput;
  };
  phases: ManufacturingPickBatchCanaryScenarioPhase[];
  approvedInertArtifactIds: string[];
}

const EXACT_SCENARIO_PHASES = [
  'deterministic-create-recovery',
  'combined-atomic-write',
  'operation-staging-atomic-write',
  'stale-rowversion',
  'stable-replay',
  'serial-exclusion',
  'manual-completion',
  'cleanup',
] as const satisfies readonly ManufacturingPickBatchCanaryAttemptPhase[];

const SCENARIO_PHASE_REQUIREMENTS: Record<
  ManufacturingPickBatchCanaryAttemptPhase,
  {
    requestSource: ManufacturingPickBatchCanaryScenarioPhase['requestSource'];
    outcome: ManufacturingPickBatchCanaryAttemptOutcome;
    roles: ManufacturingPickBatchCanaryReadRole[];
  }
> = {
  'deterministic-create-recovery': {
    requestSource: 'begin-plan',
    outcome: 'response-loss-readback',
    roles: ['mo-readback'],
  },
  'combined-atomic-write': {
    requestSource: 'complete-plan',
    outcome: 'applied-verified',
    roles: ['inventory-before', 'mo-readback', 'inventory-after'],
  },
  'operation-staging-atomic-write': {
    requestSource: 'staging-plan',
    outcome: 'applied-verified',
    roles: ['mo-readback'],
  },
  'stale-rowversion': {
    requestSource: 'manifest',
    outcome: 'definitive-rejection',
    roles: ['no-write-readback'],
  },
  'stable-replay': {
    requestSource: 'none',
    outcome: 'readback-only',
    roles: ['mo-readback'],
  },
  'serial-exclusion': {
    requestSource: 'manifest',
    outcome: 'definitive-rejection',
    roles: ['no-write-readback'],
  },
  'manual-completion': {
    requestSource: 'manifest',
    outcome: 'applied-verified',
    roles: ['mo-readback'],
  },
  cleanup: {
    requestSource: 'manifest',
    outcome: 'cleanup-verified',
    roles: ['mo-readback', 'inventory-after-cleanup'],
  },
};

function scenarioInvalid(detail: string): never {
  throw new Error(`MANUFACTURING_PICK_BATCH_SCENARIO_INVALID: ${detail}`);
}

function requireJsonObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    scenarioInvalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) scenarioInvalid(`${label}.${extra} is not allowed`);
  const missing = required.find((key) => !(key in value));
  if (missing) scenarioInvalid(`${label}.${missing} is required`);
}

function validateScenarioRead(
  value: unknown,
  phase: ManufacturingPickBatchCanaryAttemptPhase,
  expectedRole: ManufacturingPickBatchCanaryReadRole
): asserts value is ManufacturingPickBatchCanaryScenarioRead {
  const read = requireJsonObject(value, `${phase}.${expectedRole}`);
  requireExactKeys(
    read,
    ['role', 'timing', 'method', 'path', 'body', 'expected'],
    ['role', 'timing', 'method', 'path', 'expected'],
    `${phase}.${expectedRole}`
  );
  if (read.role !== expectedRole) {
    scenarioInvalid(`${phase} has unexpected read role`);
  }
  const expectedTiming = expectedRole === 'inventory-before' ? 'before' : 'after';
  if (read.timing !== expectedTiming) {
    scenarioInvalid(`${phase}.${expectedRole} has invalid timing`);
  }
  if (read.method === 'GET') {
    if (
      typeof read.path !== 'string' ||
      !/^\/manufacturing-orders\/[^/]+$/.test(read.path) ||
      'body' in read
    ) {
      scenarioInvalid(`${phase}.${expectedRole} GET is not allowlisted`);
    }
    return;
  }
  if (read.method !== 'POST_READ' || read.path !== '/products/summary') {
    scenarioInvalid(`${phase}.${expectedRole} read is not allowlisted`);
  }
  if (
    !Array.isArray(read.body) ||
    read.body.length < 1 ||
    read.body.length > 20
  ) {
    scenarioInvalid(`${phase}.${expectedRole} inventory body is invalid`);
  }
  for (const [index, rowValue] of read.body.entries()) {
    const row = requireJsonObject(
      rowValue,
      `${phase}.${expectedRole}.body[${index}]`
    );
    requireExactKeys(
      row,
      ['productId'],
      ['productId'],
      `${phase}.${expectedRole}.body[${index}]`
    );
    if (typeof row.productId !== 'string' || !row.productId.trim()) {
      scenarioInvalid(`${phase}.${expectedRole} productId is invalid`);
    }
  }
}

function validateManifestRequest(
  value: unknown,
  phase: ManufacturingPickBatchCanaryAttemptPhase
): asserts value is ManufacturingPickBatchMutationRequest {
  const request = requireJsonObject(value, `${phase}.request`);
  requireExactKeys(
    request,
    ['method', 'path', 'body'],
    ['method', 'path', 'body'],
    `${phase}.request`
  );
  if (request.method !== 'PUT' || request.path !== '/manufacturing-orders') {
    scenarioInvalid(`${phase}.request is not allowlisted`);
  }
}

export function parseManufacturingPickBatchCanaryScenario(
  raw: string | undefined
): ManufacturingPickBatchCanaryScenario {
  if (!raw?.trim()) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_SCENARIO_REQUIRED: set the dedicated JSON scenario manifest'
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > 512 * 1024) {
    scenarioInvalid('manifest exceeds 512 KiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    scenarioInvalid('manifest must be valid JSON');
  }
  const scenario = requireJsonObject(parsed, 'scenario');
  requireExactKeys(
    scenario,
    [
      'schemaVersion',
      'scenarioId',
      'beginInput',
      'batches',
      'phases',
      'approvedInertArtifactIds',
    ],
    [
      'schemaVersion',
      'scenarioId',
      'beginInput',
      'batches',
      'phases',
      'approvedInertArtifactIds',
    ],
    'scenario'
  );
  if (
    scenario.schemaVersion !==
      'manufacturing-pick-batch-canary-scenario/v1' ||
    typeof scenario.scenarioId !== 'string' ||
    !scenario.scenarioId.trim()
  ) {
    scenarioInvalid('schemaVersion or scenarioId is invalid');
  }
  const beginInput = requireJsonObject(scenario.beginInput, 'beginInput');
  requireExactKeys(
    beginInput,
    ['identity', 'locationId', 'remarks'],
    ['identity', 'locationId'],
    'beginInput'
  );
  const identity = requireJsonObject(beginInput.identity, 'beginInput.identity');
  requireExactKeys(
    identity,
    [
      'schemaVersion',
      'companyId',
      'finishedProductId',
      'sourceSerial',
      'finishedSerial',
      'parentRunHash',
      'parentRawLineId',
    ],
    ['schemaVersion', 'companyId', 'finishedProductId', 'sourceSerial', 'finishedSerial'],
    'beginInput.identity'
  );
  if (identity.schemaVersion !== 'manufacturing-run-identity/v2') {
    scenarioInvalid('beginInput.identity.schemaVersion is invalid');
  }
  for (const key of ['companyId', 'finishedProductId', 'sourceSerial', 'finishedSerial']) {
    if (typeof identity[key] !== 'string' || !identity[key].trim()) {
      scenarioInvalid(`beginInput.identity.${key} is invalid`);
    }
  }
  if (typeof beginInput.locationId !== 'string' || !beginInput.locationId.trim()) {
    scenarioInvalid('beginInput.locationId is invalid');
  }
  const batches = requireJsonObject(scenario.batches, 'batches');
  requireExactKeys(
    batches,
    ['complete', 'staging'],
    ['complete', 'staging'],
    'batches'
  );
  for (const name of ['complete', 'staging']) {
    const batch = requireJsonObject(batches[name], `batches.${name}`);
    requireExactKeys(
      batch,
      ['current', 'begin', 'intents', 'output'],
      ['current', 'begin', 'intents', 'output'],
      `batches.${name}`
    );
  }
  if (
    !Array.isArray(scenario.phases) ||
    scenario.phases.length !== EXACT_SCENARIO_PHASES.length
  ) {
    scenarioInvalid('exactly eight phases are required');
  }
  scenario.phases.forEach((phaseValue, index) => {
    const expectedPhase = EXACT_SCENARIO_PHASES[index]!;
    const phase = requireJsonObject(phaseValue, `phases[${index}]`);
    requireExactKeys(
      phase,
      [
        'phase',
        'requestSource',
        'request',
        'expectedOutcome',
        'expectedRejection',
        'reads',
      ],
      ['phase', 'requestSource', 'expectedOutcome', 'reads'],
      `phases[${index}]`
    );
    const requirement = SCENARIO_PHASE_REQUIREMENTS[expectedPhase];
    if (
      phase.phase !== expectedPhase ||
      phase.requestSource !== requirement.requestSource ||
      phase.expectedOutcome !== requirement.outcome
    ) {
      scenarioInvalid(`phases[${index}] contract mismatch`);
    }
    if (requirement.requestSource === 'manifest') {
      validateManifestRequest(phase.request, expectedPhase);
    } else if ('request' in phase) {
      scenarioInvalid(`${expectedPhase}.request must be core-derived`);
    }
    const isRejection =
      expectedPhase === 'stale-rowversion' ||
      expectedPhase === 'serial-exclusion';
    if (isRejection) {
      const rejection = requireJsonObject(
        phase.expectedRejection,
        `${expectedPhase}.expectedRejection`
      );
      requireExactKeys(
        rejection,
        ['statusCode', 'code'],
        ['statusCode', 'code'],
        `${expectedPhase}.expectedRejection`
      );
      if (
        rejection.statusCode !== 409 ||
        typeof rejection.code !== 'string' ||
        !rejection.code.trim()
      ) {
        scenarioInvalid(`${expectedPhase}.expectedRejection is invalid`);
      }
    } else if ('expectedRejection' in phase) {
      scenarioInvalid(`${expectedPhase}.expectedRejection is not allowed`);
    }
    if (
      !Array.isArray(phase.reads) ||
      phase.reads.length !== requirement.roles.length
    ) {
      scenarioInvalid(`${expectedPhase} read plan is invalid`);
    }
    phase.reads.forEach((read, readIndex) =>
      validateScenarioRead(
        read,
        expectedPhase,
        requirement.roles[readIndex]!
      )
    );
  });
  const typedScenario =
    scenario as unknown as ManufacturingPickBatchCanaryScenario;
  const expectedManufacturingOrderPath =
    `/manufacturing-orders/${
      planManufacturingRunBegin(typedScenario.beginInput)
        .manufacturingOrderId
    }`;
  const expectedInventoryProductIds = [
    typedScenario.beginInput.identity.finishedProductId,
    ...typedScenario.batches.complete.intents.map((intent) => intent.productId),
    ...typedScenario.batches.staging.intents.map((intent) => intent.productId),
  ]
    .map((value) => value.normalize('NFKC').trim())
    .filter(Boolean);
  const uniqueExpectedInventoryProductIds = [
    ...new Set(expectedInventoryProductIds),
  ].sort();
  for (const phase of typedScenario.phases) {
    if (phase.requestSource === 'manifest') {
      const body = requireJsonObject(
        phase.request?.body,
        `${phase.phase}.request.body`
      );
      if (
        body.manufacturingOrderId !==
        planManufacturingRunBegin(typedScenario.beginInput)
          .manufacturingOrderId
      ) {
        scenarioInvalid(
          `${phase.phase}.request body is not bound to the core-derived manufacturing order`
        );
      }
    }
    for (const read of phase.reads) {
      if (
        read.method === 'GET' &&
        read.path !== expectedManufacturingOrderPath
      ) {
        scenarioInvalid(
          `${phase.phase}.${read.role} must read the core-derived manufacturing order`
        );
      }
      if (read.method === 'POST_READ') {
        const actualProductIds = read.body!
          .map((row) => row.productId.normalize('NFKC').trim())
          .sort();
        if (
          actualProductIds.length !== uniqueExpectedInventoryProductIds.length ||
          stableStringify(actualProductIds) !==
            stableStringify(uniqueExpectedInventoryProductIds)
        ) {
          scenarioInvalid(
            `${phase.phase}.${read.role} inventory products are unrelated to the approved run`
          );
        }
      }
    }
  }
  const combinedPhase = typedScenario.phases.find(
    (phase) => phase.phase === 'combined-atomic-write'
  )!;
  const inventoryBefore = combinedPhase.reads.find(
    (read) => read.role === 'inventory-before'
  )!;
  const inventoryAfter = combinedPhase.reads.find(
    (read) => read.role === 'inventory-after'
  )!;
  if (
    stableStringify(inventoryBefore.expected) ===
    stableStringify(inventoryAfter.expected)
  ) {
    scenarioInvalid(
      'combined-atomic-write inventory evidence does not show movement'
    );
  }
  if (
    !Array.isArray(scenario.approvedInertArtifactIds) ||
    scenario.approvedInertArtifactIds.some(
      (value) => typeof value !== 'string' || !value.trim()
    )
  ) {
    scenarioInvalid('approvedInertArtifactIds is invalid');
  }
  return structuredClone(
    typedScenario
  ) as ManufacturingPickBatchCanaryScenario;
}

export function manufacturingPickBatchCanaryScenarioHash(
  scenario: ManufacturingPickBatchCanaryScenario
): string {
  return canonicalHash(
    scenario,
    'manufacturing-pick-batch-canary-scenario/v1'
  );
}

export function parseManufacturingPickBatchCanaryApproval(
  raw: string | undefined
): ManufacturingPickBatchCanaryApproval {
  if (!raw?.trim()) {
    throw new Error(
      'CANARY_APPROVAL_MATERIAL_REQUIRED: set the dedicated JSON approval material'
    );
  }
  try {
    const value = JSON.parse(raw) as ManufacturingPickBatchCanaryApproval;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('shape');
    }
    return value;
  } catch {
    throw new Error(
      'CANARY_APPROVAL_MATERIAL_INVALID: approval material must be valid JSON'
    );
  }
}

function expectedApprovalIdentity(
  config: InflowConfig,
  scenarioManifestHash: string
) {
  const baseHost = new URL(config.baseUrl).host.toLowerCase();
  return {
    tenantFingerprint: tenantFingerprint(
      config.companyId,
      config.apiKey,
      baseHost
    ),
    baseHost,
    apiVersion: config.apiVersion,
    probeBuild: config.probeBuild,
    adapterManifestHash: config.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    scenarioManifestHash,
  };
}

export function assertManufacturingPickBatchCanaryReady(
  config: InflowConfig,
  approval: ManufacturingPickBatchCanaryApproval,
  telemetry: ClientTelemetry,
  scenarioManifestHash: string
): string {
  if (
    config.safeWritesEnabled !== false ||
    config.stockWritesEnabled !== false ||
    config.writeGates[MANUFACTURING_PICK_BATCH_DOMAIN] !== false
  ) {
    throw new Error(
      'COORDINATOR_WRITE_GATE_MUST_BE_CLOSED: close the normal pick-batch write gate before canary execution'
    );
  }
  if (
    approval.schemaVersion !==
      'manufacturing-pick-batch-canary-approval/v1' ||
    approval.approved !== true ||
    !approval.approvalNonce?.trim()
  ) {
    throw new Error(
      'CANARY_EXPLICIT_APPROVAL_REQUIRED: dedicated pick-batch approval material is required'
    );
  }
  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt <= Date.now()
  ) {
    throw new Error('CANARY_APPROVAL_EXPIRED: approval window is not current');
  }
  if (!/^[a-f0-9]{64}$/.test(scenarioManifestHash)) {
    throw new Error(
      'CANARY_SCENARIO_MANIFEST_HASH_REQUIRED: parse and hash the approved scenario before preflight'
    );
  }
  const expected = expectedApprovalIdentity(config, scenarioManifestHash);
  for (const [field, value] of Object.entries(expected)) {
    if (
      approval[field as keyof ManufacturingPickBatchCanaryApproval] !== value
    ) {
      throw new Error(
        `CANARY_APPROVAL_IDENTITY_MISMATCH: ${field} does not match the running tenant/build/contract`
      );
    }
  }
  if (telemetry.mutationRetryPolicy.maxRetries !== 0) {
    throw new Error(
      'CANARY_ZERO_RETRY_CLIENT_REQUIRED: mutation retries must be disabled'
    );
  }
  if (
    config.rateLimitPerMinute !== MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT ||
    telemetry.rateLimiter.scope !== 'process-local' ||
    telemetry.rateLimiter.capacity !==
      MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT ||
    telemetry.rateLimiter.availableTokens < 1 ||
    telemetry.rateLimiter.queued !== 0
  ) {
    throw new Error(
      'CANARY_DEDICATED_RATE_BUDGET_REQUIRED: use an idle, dedicated 20 request/minute client'
    );
  }
  return approval.approvalNonce.trim();
}

export interface ManufacturingPickBatchMutationRequest {
  method: 'PUT';
  path: '/manufacturing-orders';
  query?: Record<string, string | number | boolean | undefined>;
  body: unknown;
}

type PickBatchMutationClient = Pick<InflowClient, 'prepareMutation'>;
type ApprovedPickBatchMutationClient = Pick<
  InflowClient,
  'get' | 'postRead' | 'prepareMutation' | 'telemetrySnapshot'
>;

export async function dispatchManufacturingPickBatchMutationOnce<T>(
  client: PickBatchMutationClient,
  request: ManufacturingPickBatchMutationRequest,
  readback: () => Promise<T>,
  verifyReadback: (value: T) => boolean
): Promise<
  | { outcome: 'response'; value: T; correlationId: string }
  | {
      outcome: 'response-loss-readback';
      value: T;
      correlationId: string;
      dispatchError: unknown;
    }
> {
  const prepared: PreparedMutation<T> = await client.prepareMutation<T>(
    request.method,
    request.path,
    { params: request.query, body: request.body }
  );
  try {
    return {
      outcome: 'response',
      value: await prepared.dispatch(),
      correlationId: prepared.correlationId,
    };
  } catch (dispatchError) {
    if (
      !(dispatchError instanceof TypeError) &&
      !(
        dispatchError instanceof InflowApiError &&
        dispatchError.statusCode === 408
      )
    ) {
      throw dispatchError;
    }
    const value = await readback();
    if (!verifyReadback(value)) {
      throw new Error(
        'CANARY_RESPONSE_LOSS_READBACK_MISMATCH: no second mutation is permitted'
      );
    }
    return {
      outcome: 'response-loss-readback',
      value,
      correlationId: prepared.correlationId,
      dispatchError,
    };
  }
}

export function prepareManufacturingPickBatchCanaryBegin(
  input: BeginManufacturingRunInput
): {
  primary: ManufacturingRunBeginPlan;
  replay: ManufacturingRunBeginPlan;
} {
  const primary = planManufacturingRunBegin(input);
  const replay = planManufacturingRunBegin(structuredClone(input));
  if (
    primary.manufacturingOrderId !== replay.manufacturingOrderId ||
    primary.rootLineId !== replay.rootLineId ||
    primary.operationId !== replay.operationId ||
    primary.runHash !== replay.runHash
  ) {
    throw new Error(
      'CANARY_DETERMINISTIC_CREATE_IDENTITY_MISMATCH: begin replay changed stable IDs'
    );
  }
  if (primary.createRequest.query.fillDefaultBom !== true) {
    throw new Error(
      'CANARY_SERVER_BOM_EXPANSION_REQUIRED: create must use fillDefaultBom=true'
    );
  }
  return { primary, replay };
}

export function prepareManufacturingPickBatchCanaryPlans(input: {
  complete: PlanManufacturingBatchInput;
  staging: PlanManufacturingBatchInput;
}): {
  complete: ManufacturingBatchPlan;
  staging: ManufacturingBatchPlan;
} {
  const complete = planManufacturingBatch(input.complete);
  const staging = planManufacturingBatch(input.staging);
  if (complete.mode !== 'complete' || complete.request.method !== 'PUT') {
    throw new Error(
      'CANARY_COMPLETE_PLAN_INVALID: expected one atomic completion PUT'
    );
  }
  if (
    staging.mode !== 'operation-staging' ||
    staging.request.method !== 'PUT'
  ) {
    throw new Error(
      'CANARY_STAGING_PLAN_INVALID: expected one atomic non-completing staging PUT'
    );
  }
  return { complete, staging };
}

export function manufacturingBatchPlanReadbackVerifier(
  plan: ManufacturingBatchPlan
): (actual: ManufacturingOrder) => boolean {
  return (actual) =>
    canonicalHash(
      canonicalManufacturingOrderProjection(actual),
      'manufacturing-run/expected-post/v1'
    ) === plan.hashes.expectedPostState;
}

export interface ManufacturingPickBatchCanaryEvidence {
  observations: Record<ManufacturingPickBatchObservation, boolean>;
  optimisticConcurrency: CanaryAttestation['optimisticConcurrency'];
  cleanupVerified: boolean;
  confirmedResidualIds: string[];
  possibleResidualIds: string[];
  approvedInertArtifactIds: string[];
  beforeSnapshot: unknown;
  afterCleanupSnapshot: unknown;
}

interface ManufacturingPickBatchCanaryInventoryScope {
  productIds: string[];
  watchedSerials: WatchedSerialIdentity[];
  structuralProductIds: string[];
}

export type ManufacturingPickBatchCanaryAttemptPhase =
  | 'deterministic-create-recovery'
  | 'combined-atomic-write'
  | 'operation-staging-atomic-write'
  | 'stale-rowversion'
  | 'stable-replay'
  | 'serial-exclusion'
  | 'manual-completion'
  | 'cleanup';

export type ManufacturingPickBatchCanaryAttemptOutcome =
  | 'applied-verified'
  | 'response-loss-readback'
  | 'definitive-rejection'
  | 'readback-only'
  | 'cleanup-verified'
  | 'ambiguous';

export interface ManufacturingPickBatchCanaryProof {
  sourceRecordIds: string[];
  expected: unknown;
  actualRecordId: string;
}

export interface ManufacturingPickBatchCanaryRecordedEvidence {
  recordId: string;
  kind: 'provider-read' | 'mutation-request' | 'mutation-response' | 'rejection';
  phase: ManufacturingPickBatchCanaryAttemptPhase;
  method: 'PUT' | 'GET' | 'POST_READ';
  path: string;
  role?: ManufacturingPickBatchCanaryReadRole;
  requestRecordId?: string;
  value: unknown;
}

export interface ManufacturingPickBatchCanaryLiveTrace {
  schemaVersion: 'manufacturing-pick-batch-canary-trace/v1';
  proofs: Record<
    ManufacturingPickBatchObservation,
    ManufacturingPickBatchCanaryProof
  >;
  attempts: Array<{
    phase: ManufacturingPickBatchCanaryAttemptPhase;
    method: 'PUT' | 'READ';
    path: string;
    dispatchCount: number;
    outcome: ManufacturingPickBatchCanaryAttemptOutcome;
  }>;
  records: ManufacturingPickBatchCanaryRecordedEvidence[];
  optimisticConcurrency: CanaryAttestation['optimisticConcurrency'];
  confirmedResidualIds: string[];
  possibleResidualIds: string[];
  approvedInertArtifactIds: string[];
  beforeSnapshot: unknown;
  afterCleanupSnapshot: unknown;
}

const REQUIRED_ATTEMPTS: Record<
  ManufacturingPickBatchCanaryAttemptPhase,
  {
    method: 'PUT' | 'READ';
    path: string | RegExp;
    dispatchCount: number | 'positive';
    outcomes: ManufacturingPickBatchCanaryAttemptOutcome[];
  }
> = {
  'deterministic-create-recovery': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['response-loss-readback'],
  },
  'combined-atomic-write': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['applied-verified', 'response-loss-readback'],
  },
  'operation-staging-atomic-write': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['applied-verified', 'response-loss-readback'],
  },
  'stale-rowversion': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['definitive-rejection'],
  },
  'stable-replay': {
    method: 'READ',
    path: /^\/manufacturing-orders\/[^/]+$/,
    dispatchCount: 0,
    outcomes: ['readback-only'],
  },
  'serial-exclusion': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['definitive-rejection'],
  },
  'manual-completion': {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['applied-verified', 'response-loss-readback'],
  },
  cleanup: {
    method: 'PUT',
    path: '/manufacturing-orders',
    dispatchCount: 1,
    outcomes: ['cleanup-verified'],
  },
};

interface ManufacturingPickBatchProofRecordRequirement {
  kind: ManufacturingPickBatchCanaryRecordedEvidence['kind'];
  phase: ManufacturingPickBatchCanaryAttemptPhase;
  method: ManufacturingPickBatchCanaryRecordedEvidence['method'];
  path: 'manufacturing-order' | 'manufacturing-orders' | 'inventory-summary';
  role?: ManufacturingPickBatchCanaryReadRole;
  linkedToPhaseRequest?: boolean;
}

const requestRequirement = (
  phase: ManufacturingPickBatchCanaryAttemptPhase
): ManufacturingPickBatchProofRecordRequirement => ({
  kind: 'mutation-request',
  phase,
  method: 'PUT',
  path: 'manufacturing-orders',
});
const responseRequirement = (
  phase: ManufacturingPickBatchCanaryAttemptPhase
): ManufacturingPickBatchProofRecordRequirement => ({
  kind: 'mutation-response',
  phase,
  method: 'PUT',
  path: 'manufacturing-orders',
  linkedToPhaseRequest: true,
});
const rejectionRequirement = (
  phase: ManufacturingPickBatchCanaryAttemptPhase
): ManufacturingPickBatchProofRecordRequirement => ({
  kind: 'rejection',
  phase,
  method: 'PUT',
  path: 'manufacturing-orders',
  linkedToPhaseRequest: true,
});
const moReadRequirement = (
  phase: ManufacturingPickBatchCanaryAttemptPhase,
  role: 'mo-readback' | 'no-write-readback' = 'mo-readback',
  linkedToPhaseRequest = phase !== 'stable-replay'
): ManufacturingPickBatchProofRecordRequirement => ({
  kind: 'provider-read',
  phase,
  method: 'GET',
  path: 'manufacturing-order',
  role,
  linkedToPhaseRequest,
});
const inventoryReadRequirement = (
  phase: ManufacturingPickBatchCanaryAttemptPhase,
  role:
    | 'inventory-before'
    | 'inventory-after'
    | 'inventory-after-cleanup'
): ManufacturingPickBatchProofRecordRequirement => ({
  kind: 'provider-read',
  phase,
  method: 'POST_READ',
  path: 'inventory-summary',
  role,
  linkedToPhaseRequest: true,
});

const OBSERVATION_PROOF_REQUIREMENTS: Record<
  ManufacturingPickBatchObservation,
  ManufacturingPickBatchProofRecordRequirement[]
> = {
  deterministicCreateRecovery: [
    requestRequirement('deterministic-create-recovery'),
    responseRequirement('deterministic-create-recovery'),
    moReadRequirement('deterministic-create-recovery'),
  ],
  serverExpandedBom: [
    requestRequirement('deterministic-create-recovery'),
    moReadRequirement('deterministic-create-recovery'),
  ],
  expandedSubassemblyLeafOnly: [
    requestRequirement('deterministic-create-recovery'),
    moReadRequirement('deterministic-create-recovery'),
    requestRequirement('combined-atomic-write'),
    inventoryReadRequirement('combined-atomic-write', 'inventory-before'),
    inventoryReadRequirement('combined-atomic-write', 'inventory-after'),
    requestRequirement('cleanup'),
    inventoryReadRequirement('cleanup', 'inventory-after-cleanup'),
  ],
  operationsPreserved: [
    requestRequirement('operation-staging-atomic-write'),
    responseRequirement('operation-staging-atomic-write'),
    moReadRequirement('operation-staging-atomic-write'),
  ],
  serializedMatchingShape: [
    requestRequirement('combined-atomic-write'),
    responseRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  nonSerializedMatchingShape: [
    requestRequirement('combined-atomic-write'),
    responseRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  existingIdentityPreserved: [
    requestRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  unknownFieldsPreserved: [
    requestRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  combinedAtomicWrite: [
    requestRequirement('combined-atomic-write'),
    responseRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  operationStagingAtomicWrite: [
    requestRequirement('operation-staging-atomic-write'),
    responseRequirement('operation-staging-atomic-write'),
    moReadRequirement('operation-staging-atomic-write'),
  ],
  staleRowversionNoWrite: [
    requestRequirement('stale-rowversion'),
    rejectionRequirement('stale-rowversion'),
    moReadRequirement('stale-rowversion', 'no-write-readback'),
  ],
  stableReplay: [moReadRequirement('stable-replay')],
  serialExclusion: [
    requestRequirement('serial-exclusion'),
    rejectionRequirement('serial-exclusion'),
    moReadRequirement('serial-exclusion', 'no-write-readback'),
  ],
  serialContentionNoWrite: [
    requestRequirement('serial-exclusion'),
    rejectionRequirement('serial-exclusion'),
    moReadRequirement('serial-exclusion', 'no-write-readback'),
  ],
  inventoryMovement: [
    requestRequirement('combined-atomic-write'),
    responseRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
    inventoryReadRequirement('combined-atomic-write', 'inventory-before'),
    inventoryReadRequirement('combined-atomic-write', 'inventory-after'),
  ],
  exactReadback: [
    requestRequirement('combined-atomic-write'),
    moReadRequirement('combined-atomic-write'),
  ],
  manualCompletion: [
    requestRequirement('manual-completion'),
    responseRequirement('manual-completion'),
    moReadRequirement('manual-completion'),
  ],
  cleanup: [
    requestRequirement('cleanup'),
    responseRequirement('cleanup'),
    moReadRequirement('cleanup'),
    inventoryReadRequirement('cleanup', 'inventory-after-cleanup'),
  ],
};

function recordMatchesProofRequirement(
  record: ManufacturingPickBatchCanaryRecordedEvidence,
  requirement: ManufacturingPickBatchProofRecordRequirement,
  records: ReadonlyMap<string, ManufacturingPickBatchCanaryRecordedEvidence>
): boolean {
  const pathMatches =
    requirement.path === 'manufacturing-orders'
      ? record.path === '/manufacturing-orders'
      : requirement.path === 'manufacturing-order'
        ? /^\/manufacturing-orders\/[^/]+$/.test(record.path)
        : record.path === '/products/summary';
  if (
    record.kind !== requirement.kind ||
    record.phase !== requirement.phase ||
    record.method !== requirement.method ||
    !pathMatches ||
    record.role !== requirement.role
  ) {
    return false;
  }
  if (!requirement.linkedToPhaseRequest) return !record.requestRecordId;
  const request = record.requestRecordId
    ? records.get(record.requestRecordId)
    : undefined;
  return Boolean(
    request &&
      request.kind === 'mutation-request' &&
      request.phase === requirement.phase &&
      request.method === 'PUT' &&
      request.path === '/manufacturing-orders'
  );
}

function proofPassed(
  observation: ManufacturingPickBatchObservation,
  proof: ManufacturingPickBatchCanaryProof | undefined,
  records: ReadonlyMap<string, ManufacturingPickBatchCanaryRecordedEvidence>
): boolean {
  const requirements = OBSERVATION_PROOF_REQUIREMENTS[observation];
  if (
    !proof ||
    !Array.isArray(proof.sourceRecordIds) ||
    proof.sourceRecordIds.length !== requirements.length ||
    new Set(proof.sourceRecordIds).size !== proof.sourceRecordIds.length ||
    proof.expected === undefined ||
    !proof.actualRecordId ||
    !proof.sourceRecordIds.includes(proof.actualRecordId) ||
    proof.sourceRecordIds.some((recordId) => !records.has(recordId))
  ) {
    return false;
  }
  const sourceRecords = proof.sourceRecordIds.map(
    (recordId) => records.get(recordId)!
  );
  const remaining = [...sourceRecords];
  for (const requirement of requirements) {
    const index = remaining.findIndex((record) =>
      recordMatchesProofRequirement(record, requirement, records)
    );
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  for (const record of sourceRecords) {
    if (!record.requestRecordId) continue;
    const proofRequest = sourceRecords.find(
      (candidate) =>
        candidate.kind === 'mutation-request' &&
        candidate.phase === record.phase
    );
    if (record.requestRecordId !== proofRequest?.recordId) return false;
  }
  const actualRecord = records.get(proof.actualRecordId);
  return Boolean(
    actualRecord &&
      (actualRecord.kind === 'provider-read' ||
        actualRecord.kind === 'mutation-response' ||
        actualRecord.kind === 'rejection') &&
      stableStringify(proof.expected) === stableStringify(actualRecord.value)
  );
}

export function deriveManufacturingPickBatchCanaryEvidenceFromTrace(
  trace: ManufacturingPickBatchCanaryLiveTrace
): ManufacturingPickBatchCanaryEvidence {
  if (
    trace.schemaVersion !== 'manufacturing-pick-batch-canary-trace/v1' ||
    !trace.proofs ||
    !Array.isArray(trace.attempts) ||
    !Array.isArray(trace.records)
  ) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_TRACE_INVALID: unsupported trace envelope'
    );
  }
  const attempts = new Map<
    ManufacturingPickBatchCanaryAttemptPhase,
    ManufacturingPickBatchCanaryLiveTrace['attempts'][number]
  >();
  if (trace.attempts.length !== Object.keys(REQUIRED_ATTEMPTS).length) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_TRACE_INVALID: unexpected or missing attempts'
    );
  }
  for (const attempt of trace.attempts) {
    if (!(attempt.phase in REQUIRED_ATTEMPTS)) {
      throw new Error(
        `MANUFACTURING_PICK_BATCH_TRACE_INVALID: unknown ${String(attempt.phase)} attempt`
      );
    }
    if (attempts.has(attempt.phase)) {
      throw new Error(
        `MANUFACTURING_PICK_BATCH_TRACE_INVALID: duplicate ${attempt.phase} attempt`
      );
    }
    attempts.set(attempt.phase, attempt);
  }
  for (const [phase, requirement] of Object.entries(REQUIRED_ATTEMPTS) as Array<
    [
      ManufacturingPickBatchCanaryAttemptPhase,
      (typeof REQUIRED_ATTEMPTS)[ManufacturingPickBatchCanaryAttemptPhase],
    ]
  >) {
    const attempt = attempts.get(phase);
    const countValid =
      requirement.dispatchCount === 'positive'
        ? (attempt?.dispatchCount ?? 0) > 0
        : attempt?.dispatchCount === requirement.dispatchCount;
    const pathValid =
      typeof requirement.path === 'string'
        ? attempt?.path === requirement.path
        : requirement.path.test(attempt?.path ?? '');
    if (
      !attempt ||
      attempt.method !== requirement.method ||
      !pathValid ||
      !countValid ||
      !requirement.outcomes.includes(attempt.outcome)
    ) {
      throw new Error(
        `MANUFACTURING_PICK_BATCH_TRACE_INVALID: ${phase} has ambiguous or non-atomic evidence`
      );
    }
  }

  const records = new Map(
    trace.records.map((record) => [record.recordId, record])
  );
  if (records.size !== trace.records.length) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_TRACE_INVALID: duplicate evidence record'
    );
  }
  const observations = Object.fromEntries(
    MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS.map((observation) => [
      observation,
      proofPassed(observation, trace.proofs[observation], records),
    ])
  ) as Record<ManufacturingPickBatchObservation, boolean>;

  return {
    observations,
    optimisticConcurrency: trace.optimisticConcurrency,
    cleanupVerified: observations.cleanup,
    confirmedResidualIds: [...trace.confirmedResidualIds],
    possibleResidualIds: [...trace.possibleResidualIds],
    approvedInertArtifactIds: [...trace.approvedInertArtifactIds],
    beforeSnapshot: trace.beforeSnapshot,
    afterCleanupSnapshot: trace.afterCleanupSnapshot,
  };
}

export async function runManufacturingPickBatchCanaryCommand(input: {
  config: InflowConfig;
  approval: ManufacturingPickBatchCanaryApproval;
  client: ApprovedPickBatchMutationClient;
  scenario: ManufacturingPickBatchCanaryScenario;
}): Promise<{
  trace: ManufacturingPickBatchCanaryLiveTrace;
  evidence: ManufacturingPickBatchCanaryEvidence;
  evaluation: ReturnType<typeof evaluateManufacturingPickBatchCanaryEvidence>;
}> {
  if (
    input.scenario.schemaVersion ===
    'manufacturing-pick-batch-canary-scenario/v1'
  ) {
    throw new Error(
      'CANARY_V1_LIVE_COMMAND_DISABLED: use the staged manufacturing-pick-batch-canary-scenario/v2 state machine'
    );
  }
  const scenarioManifestHash =
    manufacturingPickBatchCanaryScenarioHash(input.scenario);
  assertManufacturingPickBatchCanaryReady(
    input.config,
    input.approval,
    input.client.telemetrySnapshot(),
    scenarioManifestHash
  );
  const scenario = parseManufacturingPickBatchCanaryScenario(
    stableStringify(input.scenario)
  );
  if (
    manufacturingPickBatchCanaryScenarioHash(scenario) !==
    scenarioManifestHash
  ) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID: canonical scenario changed during parsing'
    );
  }
  const begin = prepareManufacturingPickBatchCanaryBegin(scenario.beginInput);
  if (
    stableStringify(scenario.batches.complete.begin) !==
      stableStringify(begin.primary) ||
    stableStringify(scenario.batches.staging.begin) !==
      stableStringify(begin.primary)
  ) {
    throw new Error(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID: batch begin plans do not match the core-derived identity'
    );
  }
  const plans = prepareManufacturingPickBatchCanaryPlans(scenario.batches);
  const records: ManufacturingPickBatchCanaryRecordedEvidence[] = [];
  const attempts = new Map<
    ManufacturingPickBatchCanaryAttemptPhase,
    ManufacturingPickBatchCanaryLiveTrace['attempts'][number]
  >();
  const record = (evidence: ManufacturingPickBatchCanaryRecordedEvidence) => {
    if (records.some((current) => current.recordId === evidence.recordId)) {
      throw new Error(
        `MANUFACTURING_PICK_BATCH_EVIDENCE_DUPLICATE: ${evidence.recordId}`
      );
    }
    records.push(evidence);
  };
  const requestForPhase = (
    step: ManufacturingPickBatchCanaryScenarioPhase
  ): ManufacturingPickBatchMutationRequest | undefined => {
    switch (step.requestSource) {
      case 'begin-plan':
        return begin.primary.createRequest;
      case 'complete-plan':
        return plans.complete.request;
      case 'staging-plan':
        return plans.staging.request;
      case 'manifest':
        return step.request;
      case 'none':
        return undefined;
    }
  };
  const readProvider = async (
    phase: ManufacturingPickBatchCanaryAttemptPhase,
    read: ManufacturingPickBatchCanaryScenarioRead,
    requestRecordId?: string
  ): Promise<unknown> => {
    const recordId = `${phase}:read:${read.role}`;
    const value =
      read.method === 'GET'
        ? await input.client.get<unknown>(read.path)
        : await input.client.postRead<unknown>(read.path, read.body);
    record({
      recordId,
      kind: 'provider-read',
      phase,
      method: read.method,
      path: read.path,
      role: read.role,
      requestRecordId,
      value,
    });
    if (stableStringify(value) !== stableStringify(read.expected)) {
      throw new Error(
        `CANARY_PROVIDER_READ_MISMATCH: ${phase}:${read.role}`
      );
    }
    return value;
  };
  const reserveMutation = (
    phase: Exclude<ManufacturingPickBatchCanaryAttemptPhase, 'stable-replay'>,
    request: ManufacturingPickBatchMutationRequest
  ): string => {
    if (attempts.has(phase)) {
      throw new Error(`CANARY_TWO_WRITE_FALLBACK_REFUSED: ${phase}`);
    }
    if (
      request.method !== 'PUT' ||
      request.path !== '/manufacturing-orders'
    ) {
      throw new Error(`CANARY_MUTATION_PATH_REFUSED: ${phase}`);
    }
    const requestRecordId = `${phase}:request`;
    attempts.set(phase, {
      phase,
      method: 'PUT',
      path: request.path,
      dispatchCount: 1,
      outcome: 'ambiguous',
    });
    record({
      recordId: requestRecordId,
      kind: 'mutation-request',
      phase,
      method: 'PUT',
      path: request.path,
      value: request.body,
    });
    return requestRecordId;
  };

  for (const step of scenario.phases) {
    const phase = step.phase;
    if (phase === 'stable-replay') {
      const read = step.reads[0]!;
      await readProvider(phase, read);
      attempts.set(phase, {
        phase,
        method: 'READ',
        path: read.path,
        dispatchCount: 0,
        outcome: 'readback-only',
      });
      continue;
    }
    const request = requestForPhase(step);
    if (!request) {
      throw new Error(
        `MANUFACTURING_PICK_BATCH_SCENARIO_INVALID: ${phase} request is missing`
      );
    }
    const requestRecordId = reserveMutation(phase, request);
    const beforeReads = step.reads.filter((read) => read.timing === 'before');
    const afterReads = step.reads.filter((read) => read.timing === 'after');
    for (const read of beforeReads) {
      await readProvider(phase, read, requestRecordId);
    }
    if (step.expectedOutcome === 'definitive-rejection') {
      const prepared = await input.client.prepareMutation(
        request.method,
        request.path,
        { params: request.query, body: request.body }
      );
      let appliedValue: unknown;
      try {
        appliedValue = await prepared.dispatch();
      } catch (error) {
        if (
          error instanceof TypeError ||
          (error instanceof InflowApiError && error.statusCode === 408)
        ) {
          throw new Error(`CANARY_REJECTION_AMBIGUOUS: ${phase}`);
        }
        const expected = step.expectedRejection!;
        if (
          !(error instanceof InflowApiError) ||
          error.statusCode !== expected.statusCode ||
          error.apiError?.code !== expected.code
        ) {
          throw new Error(`CANARY_UNEXPECTED_REJECTION: ${phase}`);
        }
        const value =
          {
            name: error.name,
            statusCode: error.statusCode,
            code: error.apiError?.code ?? null,
            message: error.apiError?.message ?? error.message,
          };
        record({
          recordId: `${phase}:rejection`,
          kind: 'rejection',
          phase,
          method: 'PUT',
          path: request.path,
          requestRecordId,
          value,
        });
        attempts.set(phase, {
          phase,
          method: 'PUT',
          path: request.path,
          dispatchCount: 1,
          outcome: 'definitive-rejection',
        });
        for (const read of afterReads) {
          await readProvider(phase, read, requestRecordId);
        }
        continue;
      }
      record({
        recordId: `${phase}:response`,
        kind: 'mutation-response',
        phase,
        method: 'PUT',
        path: request.path,
        requestRecordId,
        value: appliedValue,
      });
      throw new Error(
        `CANARY_EXPECTED_REJECTION_NOT_OBSERVED: ${phase}`
      );
    }
    const responseLossRead = afterReads[0];
    let responseLossReadUsed = false;
    const result = await dispatchManufacturingPickBatchMutationOnce(
      input.client,
      request,
      async () => {
        if (!responseLossRead) {
          throw new Error(
            `CANARY_RESPONSE_LOSS_READBACK_REQUIRED: ${phase}`
          );
        }
        responseLossReadUsed = true;
        return readProvider(phase, responseLossRead, requestRecordId);
      },
      (value) =>
        stableStringify(value) ===
        stableStringify(responseLossRead?.expected)
    );
    record({
      recordId: `${phase}:response`,
      kind: 'mutation-response',
      phase,
      method: 'PUT',
      path: request.path,
      requestRecordId,
      value: result.value,
    });
    for (const read of afterReads) {
      if (responseLossReadUsed && read === responseLossRead) continue;
      await readProvider(phase, read, requestRecordId);
    }
    const outcome =
      phase === 'cleanup'
        ? 'cleanup-verified'
        : result.outcome === 'response-loss-readback'
          ? 'response-loss-readback'
          : 'applied-verified';
    if (outcome !== step.expectedOutcome) {
      throw new Error(
        `CANARY_UNEXPECTED_PHASE_OUTCOME: ${phase}:${outcome}`
      );
    }
    attempts.set(phase, {
      phase,
      method: 'PUT',
      path: request.path,
      dispatchCount: 1,
      outcome,
    });
  }

  const recordMap = new Map(records.map((value) => [value.recordId, value]));
  const proofs = Object.fromEntries(
    MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS.map((observation) => {
      const requirements = OBSERVATION_PROOF_REQUIREMENTS[observation];
      const sourceRecords = requirements.map((requirement) => {
        const match = records.find((candidate) =>
          recordMatchesProofRequirement(candidate, requirement, recordMap)
        );
        if (!match) {
          throw new Error(
            `MANUFACTURING_PICK_BATCH_PROOF_INCOMPLETE: ${observation}`
          );
        }
        return match;
      });
      const actual =
        [...sourceRecords]
          .reverse()
          .find((value) => value.kind === 'provider-read') ??
        sourceRecords[sourceRecords.length - 1]!;
      return [
        observation,
        {
          sourceRecordIds: sourceRecords.map((value) => value.recordId),
          expected: structuredClone(actual.value),
          actualRecordId: actual.recordId,
        },
      ];
    })
  ) as ManufacturingPickBatchCanaryLiveTrace['proofs'];
  const beforeSnapshot = records.find(
    (recordValue) =>
      recordValue.phase === 'combined-atomic-write' &&
      recordValue.role === 'inventory-before'
  )?.value;
  const afterCleanupSnapshot = records.find(
    (recordValue) =>
      recordValue.phase === 'cleanup' &&
      recordValue.role === 'inventory-after-cleanup'
  )?.value;
  const trace: ManufacturingPickBatchCanaryLiveTrace = {
    schemaVersion: 'manufacturing-pick-batch-canary-trace/v1',
    proofs,
    attempts: [...attempts.values()],
    records,
    optimisticConcurrency: 'enforced',
    confirmedResidualIds: [],
    possibleResidualIds: [],
    approvedInertArtifactIds: [...scenario.approvedInertArtifactIds],
    beforeSnapshot,
    afterCleanupSnapshot,
  };
  const evidence =
    deriveManufacturingPickBatchCanaryEvidenceFromTrace(trace);
  const evaluation =
    evaluateManufacturingPickBatchCanaryEvidence(evidence);
  if (!evaluation.passed) {
    throw new Error(
      `MANUFACTURING_PICK_BATCH_CANARY_FAILED: ${evaluation.failedChecks.join(', ')}`
    );
  }
  await issueManufacturingPickBatchCanaryAttestation(
    input.config,
    input.approval,
    input.client.telemetrySnapshot(),
    evidence,
    scenarioManifestHash
  );
  return { trace, evidence, evaluation };
}

export function evaluateManufacturingPickBatchCanaryEvidence(
  evidence: ManufacturingPickBatchCanaryEvidence
): { passed: boolean; failedChecks: string[] } {
  const failedChecks = MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS.filter(
    (observation) => evidence.observations[observation] !== true
  ) as string[];
  if (evidence.optimisticConcurrency !== 'enforced') {
    failedChecks.push('optimisticConcurrency');
  }
  if (!evidence.cleanupVerified) failedChecks.push('cleanupVerified');
  if (evidence.possibleResidualIds.length > 0) {
    failedChecks.push('possibleResidualIds');
  }
  const approved = new Set(evidence.approvedInertArtifactIds);
  if (evidence.confirmedResidualIds.some((id) => !approved.has(id))) {
    failedChecks.push('confirmedResidualApproval');
  }
  return { passed: failedChecks.length === 0, failedChecks };
}

function isCanaryHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function assertManufacturingPickBatchCanaryV2AttestationEvidence(
  evidence: ManufacturingPickBatchCanaryEvidence
): true {
  const before = evidence.beforeSnapshot as Record<string, unknown> | null;
  const after = evidence.afterCleanupSnapshot as Record<string, unknown> | null;
  if (
    !before ||
    before.schemaVersion !==
      'manufacturing-pick-batch-canary-attestation-evidence/v2' ||
    !after ||
    !isCanaryHash(before.scenarioManifestHash) ||
    !isCanaryHash(before.checkpointChainHead)
  ) {
    throw new Error('CANARY_V2_ATTESTATION_EVIDENCE_REQUIRED');
  }
  const subjects = before.subjects as Record<string, unknown> | null;
  if (
    !subjects ||
    typeof subjects.complete !== 'string' ||
    typeof subjects.staging !== 'string' ||
    !subjects.complete ||
    !subjects.staging ||
    subjects.complete === subjects.staging
  ) {
    throw new Error('CANARY_V2_ATTESTATION_SUBJECTS_REQUIRED');
  }
  const subjectIds = [subjects.complete, subjects.staging].sort();
  const approvedResidualIds = [...evidence.approvedInertArtifactIds].sort();
  const confirmedResidualIds = [...evidence.confirmedResidualIds].sort();
  if (
    new Set(approvedResidualIds).size !== approvedResidualIds.length ||
    new Set(confirmedResidualIds).size !== confirmedResidualIds.length ||
    stableStringify(approvedResidualIds) !== stableStringify(subjectIds) ||
    stableStringify(confirmedResidualIds) !== stableStringify(subjectIds)
  ) {
    throw new Error('CANARY_V2_RESIDUAL_SET_REQUIRED');
  }
  const structural = before.structuralInventory as
    | Record<string, unknown>
    | null;
  const finalStructural = after.structuralInventory as
    | Record<string, unknown>
    | null;
  const structuralProductIds = structural?.productIds;
  if (
    !Array.isArray(structuralProductIds) ||
    structuralProductIds.length === 0 ||
    structuralProductIds.some(
      (productId) => typeof productId !== 'string' || !productId
    ) ||
    !['baselineHash', 'stockAfterHash', 'negativeAfterHash', 'cleanupHash']
      .every((field) => isCanaryHash(structural?.[field])) ||
    !finalStructural ||
    stableStringify(finalStructural.productIds) !==
      stableStringify(structuralProductIds) ||
    !isCanaryHash(finalStructural.attestHash) ||
    !isCanaryHash(after.restorationHash)
  ) {
    throw new Error('CANARY_V2_STRUCTURAL_INVENTORY_EVIDENCE_REQUIRED');
  }
  const mutations = before.mutations as Record<string, unknown> | null;
  const completeStockMove = mutations?.['complete:stock-move'] as
    | ManufacturingPickBatchCanaryMutationRecordV2
    | undefined;
  const contention = mutations?.['staging:serial-exclusion'] as
    | ManufacturingPickBatchCanaryMutationRecordV2
    | undefined;
  const contentionExpected = before.serialContentionExpectedRejection as
    | ManufacturingPickBatchCanaryExpectedRejectionV2
    | undefined;
  if (
    completeStockMove?.subject !== 'complete' ||
    completeStockMove.phase !== 'stock-move' ||
    completeStockMove.dispatchCount !== 1 ||
    !['applied', 'recovered'].includes(completeStockMove.outcome) ||
    contention?.subject !== 'staging' ||
    contention.phase !== 'serial-exclusion' ||
    contention.dispatchCount !== 1 ||
    contention.outcome !== 'definitive-rejection' ||
    contentionExpected?.statusCode !== 400 ||
    (contentionExpected.code !== null &&
      contentionExpected.code !== 'NegativeSerialNumberInventory') ||
    stableStringify(contention.rawResponseEvidence) !==
      stableStringify({
        name: 'InflowApiError',
        statusCode: contentionExpected.statusCode,
        code: contentionExpected.code,
      }) ||
    !isCanaryHash(contention.requestHash) ||
    !isCanaryHash(contention.rawResponseHash) ||
    !isCanaryHash(contention.readbackHash)
  ) {
    throw new Error('CANARY_V2_CONTENTION_EVIDENCE_REQUIRED');
  }
  return true;
}

export async function issueManufacturingPickBatchCanaryAttestation(
  config: InflowConfig,
  approval: ManufacturingPickBatchCanaryApproval,
  telemetry: ClientTelemetry,
  evidence: ManufacturingPickBatchCanaryEvidence,
  scenarioManifestHash: string
): Promise<void> {
  assertManufacturingPickBatchCanaryV2AttestationEvidence(evidence);
  const approvalNonce = assertManufacturingPickBatchCanaryReady(
    config,
    approval,
    telemetry,
    scenarioManifestHash
  );
  const evaluation = evaluateManufacturingPickBatchCanaryEvidence(evidence);
  if (!evaluation.passed) {
    throw new Error(
      `MANUFACTURING_PICK_BATCH_CANARY_FAILED: ${evaluation.failedChecks.join(', ')}`
    );
  }
  const approvalResiduals = [...approval.approvedInertArtifactIds].sort();
  const evidenceResiduals = [...evidence.approvedInertArtifactIds].sort();
  if (
    new Set(approvalResiduals).size !== approvalResiduals.length ||
    stableStringify(approvalResiduals) !== stableStringify(evidenceResiduals)
  ) {
    throw new Error(
      'CANARY_RESIDUAL_APPROVAL_MISMATCH: inert artifacts were not included in the explicit approval'
    );
  }
  const issuedAt = new Date();
  const baseHost = new URL(config.baseUrl).host.toLowerCase();
  const unsigned = {
    schemaVersion: 'canary-attestation/v1' as const,
    domain: MANUFACTURING_PICK_BATCH_DOMAIN,
    tenantFingerprint: tenantFingerprint(
      config.companyId,
      config.apiKey,
      baseHost
    ),
    baseHost,
    apiVersion: config.apiVersion,
    probeBuild: config.probeBuild,
    adapterManifestHash: config.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    approvalNonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(
      issuedAt.getTime() + 30 * 24 * 60 * 60_000
    ).toISOString(),
    passed: true,
    cleanupVerified: true,
    confirmedResidualIds: [...new Set(evidence.confirmedResidualIds)].sort(),
    possibleResidualIds: [],
    approvedInertArtifactIds: [
      ...new Set(evidence.approvedInertArtifactIds),
    ].sort(),
    optimisticConcurrency: 'enforced' as const,
    observedSemantics: { ...evidence.observations },
    beforeSnapshotHash: canonicalHash(
      evidence.beforeSnapshot,
      'canary-before/manufacturing-pick-batch-v1'
    ),
    afterCleanupSnapshotHash: canonicalHash(
      evidence.afterCleanupSnapshot,
      'canary-after/manufacturing-pick-batch-v1'
    ),
  };
  await writeCanaryAttestation(
    config.stateDir,
    signCanaryAttestation(unsigned, config.apiKey)
  );
}

export type CanarySubjectKind = 'complete' | 'staging';
export type ManufacturingPickBatchCanaryStage =
  | 'create'
  | 'stock-move'
  | 'negative-probes'
  | 'manual-completion-read'
  | 'cleanup'
  | 'attest';

export interface ManufacturingPickBatchCanaryScenarioV2 {
  schemaVersion: 'manufacturing-pick-batch-canary-scenario/v2';
  scenarioId: string;
  subjects: Record<CanarySubjectKind, {
    beginInput: BeginManufacturingRunInput;
    requiredExpandedShape: 'no-operations' | 'operations-present';
    output: { serialNumber: string; locationId: string; sublocation?: string };
  }>;
  approvedInertArtifactIds: string[];
}

export interface ManufacturingPickBatchCanaryStageApproval {
  schemaVersion: 'manufacturing-pick-batch-canary-stage-approval/v1';
  approved: true;
  approvalNonce: string;
  stage: ManufacturingPickBatchCanaryStage;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  serializerVersion: string;
  contractVersion: string;
  scenarioManifestHash: string;
  checkpointHash: string;
  stagePlanHash: string;
  issuedAt: string;
  expiresAt: string;
  approvedInertArtifactIds: string[];
}

function scenarioV2Invalid(detail: string): never {
  throw new Error(`MANUFACTURING_PICK_BATCH_SCENARIO_V2_INVALID: ${detail}`);
}

function requireV2String(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.normalize('NFKC').trim()) {
    scenarioV2Invalid(`${label} must be a non-empty string`);
  }
  return value.normalize('NFKC').trim();
}

function validateBeginInputV2(value: unknown, label: string): void {
  const begin = requireJsonObject(value, label);
  requireExactKeys(begin, ['identity', 'locationId', 'remarks'], ['identity', 'locationId'], label);
  const identity = requireJsonObject(begin.identity, `${label}.identity`);
  requireExactKeys(
    identity,
    ['schemaVersion', 'companyId', 'finishedProductId', 'sourceSerial', 'finishedSerial', 'parentRunHash', 'parentRawLineId'],
    ['schemaVersion', 'companyId', 'finishedProductId', 'sourceSerial', 'finishedSerial'],
    `${label}.identity`
  );
  if (identity.schemaVersion !== 'manufacturing-run-identity/v2') {
    scenarioV2Invalid(`${label}.identity.schemaVersion must be manufacturing-run-identity/v2`);
  }
  requireV2String(identity.companyId, `${label}.identity.companyId`);
  requireV2String(identity.finishedProductId, `${label}.identity.finishedProductId`);
  requireV2String(identity.sourceSerial, `${label}.identity.sourceSerial`);
  requireV2String(identity.finishedSerial, `${label}.identity.finishedSerial`);
  requireV2String(begin.locationId, `${label}.locationId`);
  if ('remarks' in begin && typeof begin.remarks !== 'string') {
    scenarioV2Invalid(`${label}.remarks must be a string`);
  }
}

export function parseManufacturingPickBatchCanaryScenarioV2(
  raw: string | undefined
): ManufacturingPickBatchCanaryScenarioV2 {
  if (!raw?.trim()) {
    throw new Error('MANUFACTURING_PICK_BATCH_SCENARIO_REQUIRED: set the dedicated v2 JSON scenario manifest');
  }
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) scenarioV2Invalid('manifest exceeds 256 KiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    scenarioV2Invalid('manifest must be valid JSON');
  }
  const value = requireJsonObject(parsed, 'scenario');
  if (value.schemaVersion === 'manufacturing-pick-batch-canary-scenario/v1') {
    throw new Error('CANARY_V1_SCENARIO_NOT_LIVE_EXECUTABLE: use manufacturing-pick-batch-canary-scenario/v2');
  }
  const topLevelKeys = new Set(['schemaVersion', 'scenarioId', 'subjects', 'approvedInertArtifactIds']);
  const extraTopLevel = Object.keys(value).find((key) => !topLevelKeys.has(key));
  if (extraTopLevel) scenarioV2Invalid(`scenario.${extraTopLevel} is not allowed`);
  requireExactKeys(
    value,
    ['schemaVersion', 'scenarioId', 'subjects', 'approvedInertArtifactIds'],
    ['schemaVersion', 'scenarioId', 'subjects', 'approvedInertArtifactIds'],
    'scenario'
  );
  if (value.schemaVersion !== 'manufacturing-pick-batch-canary-scenario/v2') {
    scenarioV2Invalid('unsupported schemaVersion');
  }
  const scenarioId = requireV2String(value.scenarioId, 'scenario.scenarioId');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scenarioId)) scenarioV2Invalid('scenarioId is not path-safe');
  const subjects = requireJsonObject(value.subjects, 'scenario.subjects');
  requireExactKeys(subjects, ['complete', 'staging'], ['complete', 'staging'], 'scenario.subjects');
  for (const kind of ['complete', 'staging'] as const) {
    const subject = requireJsonObject(subjects[kind], `scenario.subjects.${kind}`);
    requireExactKeys(
      subject,
      ['beginInput', 'requiredExpandedShape', 'output'],
      ['beginInput', 'requiredExpandedShape', 'output'],
      `scenario.subjects.${kind}`
    );
    validateBeginInputV2(subject.beginInput, `scenario.subjects.${kind}.beginInput`);
    const expectedShape = kind === 'complete' ? 'no-operations' : 'operations-present';
    if (subject.requiredExpandedShape !== expectedShape) {
      scenarioV2Invalid(`${kind} must require ${expectedShape}`);
    }
    const output = requireJsonObject(subject.output, `scenario.subjects.${kind}.output`);
    requireExactKeys(output, ['serialNumber', 'locationId', 'sublocation'], ['serialNumber', 'locationId'], `scenario.subjects.${kind}.output`);
    requireV2String(output.serialNumber, `scenario.subjects.${kind}.output.serialNumber`);
    requireV2String(output.locationId, `scenario.subjects.${kind}.output.locationId`);
    if ('sublocation' in output && typeof output.sublocation !== 'string') {
      scenarioV2Invalid(`${kind}.output.sublocation must be a string`);
    }
  }
  if (!Array.isArray(value.approvedInertArtifactIds) || value.approvedInertArtifactIds.some(
    (entry) => typeof entry !== 'string' || !entry.trim()
  )) {
    scenarioV2Invalid('approvedInertArtifactIds must be strings');
  }
  const typed = structuredClone(value) as unknown as ManufacturingPickBatchCanaryScenarioV2;
  const complete = planManufacturingRunBegin(typed.subjects.complete.beginInput);
  const staging = planManufacturingRunBegin(typed.subjects.staging.beginInput);
  if (complete.manufacturingOrderId === staging.manufacturingOrderId) {
    throw new Error('CANARY_SUBJECT_IDENTITIES_MUST_BE_DISTINCT');
  }
  const approvedInertArtifactIds = [...typed.approvedInertArtifactIds].sort();
  const deterministicManufacturingOrderIds = [
    complete.manufacturingOrderId,
    staging.manufacturingOrderId,
  ].sort();
  if (
    new Set(approvedInertArtifactIds).size !== approvedInertArtifactIds.length ||
    stableStringify(approvedInertArtifactIds) !==
      stableStringify(deterministicManufacturingOrderIds)
  ) {
    scenarioV2Invalid(
      'approvedInertArtifactIds must exactly equal the two deterministic manufacturing order IDs'
    );
  }
  if (
    typed.subjects.complete.output.serialNumber.normalize('NFKC').trim().toUpperCase() !==
      complete.normalizedIdentity.finishedSerial ||
    typed.subjects.staging.output.serialNumber.normalize('NFKC').trim().toUpperCase() !==
      staging.normalizedIdentity.finishedSerial
  ) {
    scenarioV2Invalid('output serial must match its deterministic begin identity');
  }
  return typed;
}

export function manufacturingPickBatchCanaryScenarioV2Hash(
  scenario: ManufacturingPickBatchCanaryScenarioV2
): string {
  return canonicalHash(scenario, 'manufacturing-pick-batch-canary-scenario/v2');
}

function hashCanaryRequest(value: unknown): string {
  return canonicalHash(value, 'manufacturing-pick-batch-canary/request/v2');
}

export function buildCreateStagePlan(scenario: ManufacturingPickBatchCanaryScenarioV2) {
  const subjects = Object.fromEntries((['complete', 'staging'] as const).map((kind) => {
    const begin = planManufacturingRunBegin(scenario.subjects[kind].beginInput);
    return [kind, {
      manufacturingOrderId: begin.manufacturingOrderId,
      rootLineId: begin.rootLineId,
      runHash: begin.runHash,
      requiredExpandedShape: scenario.subjects[kind].requiredExpandedShape,
      request: begin.createRequest,
      requestHash: hashCanaryRequest(begin.createRequest),
    }];
  })) as Record<CanarySubjectKind, {
    manufacturingOrderId: string;
    rootLineId: string;
    runHash: string;
    requiredExpandedShape: 'no-operations' | 'operations-present';
    request: ManufacturingRunBeginPlan['createRequest'];
    requestHash: string;
  }>;
  const plan = { schemaVersion: 'manufacturing-pick-batch-create-stage-plan/v2' as const, subjects };
  return { ...plan, stagePlanHash: canonicalHash(plan, 'manufacturing-pick-batch-canary/create-stage/v2') };
}

export interface ManufacturingPickBatchStockSubjectPlan {
  mode: ManufacturingBatchPlan['mode'];
  snapshotHash: string;
  beginTimestamp: string;
  request: ManufacturingBatchPlan['request'];
  requestHash: string;
  expectedPostHash: string;
  immutableIntentHash: string;
}

export function buildStockMoveStagePlan(input: {
  scenario: ManufacturingPickBatchCanaryScenarioV2;
  expanded: Record<CanarySubjectKind, ManufacturingOrder>;
  intents: Record<CanarySubjectKind, ManufacturingComponentIntent[]>;
  inventorySummaryProjection: unknown;
  serialInventoryProjection: unknown;
  inventoryLinesProjection?: unknown;
}) {
  const subjects = Object.fromEntries((['complete', 'staging'] as const).map((kind) => {
    const begin = planManufacturingRunBegin(input.scenario.subjects[kind].beginInput);
    const current = input.expanded[kind];
    const snapshot = captureManufacturingSnapshot(current, begin);
    if (kind === 'complete' && snapshot.operations.length !== 0) {
      throw new Error('CANARY_COMPLETE_SUBJECT_OPERATIONS_PRESENT');
    }
    if (kind === 'staging' && snapshot.operations.length === 0) {
      throw new Error('CANARY_STAGING_SUBJECT_OPERATIONS_MISSING');
    }
    if (!current.timestamp) throw new Error(`CANARY_BEGIN_ROWVERSION_REQUIRED: ${kind}`);
    if (current.isCompleted || current.isCancelled || (current.pickLines?.length ?? 0) > 0 ||
      (current.pickMatchings?.length ?? 0) > 0 || (current.putLines?.length ?? 0) > 0) {
      throw new Error(`CANARY_EXPANDED_SUBJECT_NOT_INERT: ${kind}`);
    }
    const planned = planManufacturingBatch({
      current,
      begin,
      intents: input.intents[kind],
      output: input.scenario.subjects[kind].output,
    });
    if ((kind === 'complete' && planned.mode !== 'complete') ||
      (kind === 'staging' && planned.mode !== 'operation-staging')) {
      throw new Error(`CANARY_PLANNER_MODE_MISMATCH: ${kind}`);
    }
    return [kind, {
      mode: planned.mode,
      snapshotHash: snapshot.snapshotHash,
      beginTimestamp: current.timestamp,
      request: planned.request,
      requestHash: hashCanaryRequest(planned.request),
      expectedPostHash: planned.hashes.expectedPostState,
      immutableIntentHash: planned.hashes.immutableIntent,
    } satisfies ManufacturingPickBatchStockSubjectPlan];
  })) as Record<CanarySubjectKind, ManufacturingPickBatchStockSubjectPlan>;
  const plan = {
    schemaVersion: 'manufacturing-pick-batch-stock-stage-plan/v2' as const,
    subjects,
    inventoryBaselineHash: canonicalHash(input.inventorySummaryProjection, 'manufacturing-pick-batch-canary/inventory-baseline/v2'),
    serialBaselineHash: canonicalHash(input.serialInventoryProjection, 'manufacturing-pick-batch-canary/serial-baseline/v2'),
    inventoryLinesBaselineHash: canonicalHash(
      input.inventoryLinesProjection ?? [],
      'manufacturing-pick-batch-canary/inventory-lines-baseline/v2'
    ),
  };
  return { ...plan, stagePlanHash: canonicalHash(plan, 'manufacturing-pick-batch-canary/stock-stage/v2') };
}

function rowversionAdvanced(previous: string, current: string | undefined): boolean {
  if (!current || current === previous) return false;
  if (/^[0-9a-f]+$/i.test(previous) && /^[0-9a-f]+$/i.test(current)) {
    return BigInt(`0x${current}`) > BigInt(`0x${previous}`);
  }
  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) return currentTime > previousTime;
  return current.localeCompare(previous) > 0;
}

export function verifyManufacturingPickBatchPostWrite(
  kind: CanarySubjectKind,
  actual: ManufacturingOrder,
  plan: ManufacturingPickBatchStockSubjectPlan
): true {
  const semanticHash = canonicalHash(
    canonicalManufacturingOrderProjection(actual),
    'manufacturing-run/expected-post/v1'
  );
  if (semanticHash !== plan.expectedPostHash) throw new Error(`CANARY_EXPECTED_POST_STATE_MISMATCH: ${kind}`);
  if (!rowversionAdvanced(plan.beginTimestamp, actual.timestamp)) {
    throw new Error(`CANARY_ROWVERSION_DID_NOT_ADVANCE: ${kind}`);
  }
  if (kind === 'complete' && (!actual.isCompleted || actual.status !== 'completed' ||
    !(actual.pickLines?.length) || !(actual.pickMatchings?.length) || actual.putLines?.length !== 1)) {
    throw new Error('CANARY_COMPLETE_SEMANTICS_MISMATCH');
  }
  if (kind === 'staging' && (actual.isCompleted || !(actual.pickLines?.length) ||
    !(actual.pickMatchings?.length) || (actual.putLines?.length ?? 0) !== 0)) {
    throw new Error('CANARY_STAGING_SEMANTICS_MISMATCH');
  }
  return true;
}

export function buildStaleRowversionProbeRequest(
  current: ManufacturingOrder,
  staleTimestamp: string,
  nonce: string
): ManufacturingPickBatchMutationRequest {
  if (!current.manufacturingOrderId || !current.timestamp || current.timestamp === staleTimestamp || !nonce.trim()) {
    throw new Error('CANARY_STALE_PROBE_INPUT_INVALID');
  }
  const body = structuredClone(current);
  body.timestamp = staleTimestamp;
  body.remarks = `${body.remarks ?? ''}\n[manufacturing-pick-batch-canary-stale:${nonce.trim()}]`.trim();
  return { method: 'PUT', path: '/manufacturing-orders', body };
}

export function verifyDefinitiveNoWrite(before: ManufacturingOrder, after: ManufacturingOrder): true {
  const beforeHash = canonicalHash(canonicalManufacturingOrderProjection(before), 'manufacturing-pick-batch-canary/no-write/v2');
  const afterHash = canonicalHash(canonicalManufacturingOrderProjection(after), 'manufacturing-pick-batch-canary/no-write/v2');
  if (beforeHash !== afterHash || before.timestamp !== after.timestamp) {
    throw new Error('CANARY_REJECTION_CHANGED_STATE');
  }
  return true;
}

export interface SerialExclusionProbeInput {
  productId: string;
  serial: string;
  rawLineId: string;
  reason: string;
  approvedComponentSerials: string[];
}

export function buildSerialExclusionProbeRequest(
  current: ManufacturingOrder,
  exclusion: SerialExclusionProbeInput
): ManufacturingPickBatchMutationRequest {
  const forbidden = exclusion.serial.normalize('NFKC').trim().toUpperCase();
  if (!forbidden || !exclusion.reason.trim()) throw new Error('CANARY_SERIAL_EXCLUSION_INPUT_INVALID');
  if (exclusion.approvedComponentSerials.some((serial) => serial.normalize('NFKC').trim().toUpperCase() === forbidden)) {
    throw new Error('CANARY_SERIAL_EXCLUSION_USES_APPROVED_COMPONENT_SERIAL');
  }
  const body = structuredClone(current);
  const matching = (body.pickMatchings ?? []).find((row) => row.manufacturingOrderLineId === exclusion.rawLineId);
  const pick = (body.pickLines ?? []).find((row) =>
    row.manufacturingOrderPickLineId === matching?.manufacturingOrderPickLineId && row.productId === exclusion.productId
  );
  if (!matching || !pick) throw new Error('CANARY_SERIAL_EXCLUSION_TARGET_NOT_FOUND');
  matching.serial = forbidden;
  pick.quantity = { ...pick.quantity, serialNumbers: [forbidden] };
  return { method: 'PUT', path: '/manufacturing-orders', body };
}

export function verifyManualCompletionRead(
  actual: ManufacturingOrder,
  stagingPlan: ManufacturingPickBatchStockSubjectPlan,
  output: { serialNumber: string; locationId: string; sublocation?: string }
): true {
  if (stagingPlan.mode !== 'operation-staging' || !actual.isCompleted || actual.status !== 'completed') {
    throw new Error('CANARY_MANUAL_COMPLETION_STATE_MISMATCH');
  }
  const operations = flattenManufacturingLines(actual.lines ?? []).flatMap((line) => line.manufacturingOrderOperations ?? []);
  if (operations.length === 0 || operations.some((operation) => !operation.completedDate)) {
    throw new Error('CANARY_MANUAL_COMPLETION_OPERATIONS_UNRESOLVED');
  }
  const puts = actual.putLines ?? [];
  const expectedSerial = output.serialNumber.normalize('NFKC').trim().toUpperCase();
  if (puts.length !== 1 || puts[0]!.locationId !== output.locationId ||
    (puts[0]!.sublocation ?? '') !== (output.sublocation ?? '') ||
    stableStringify(puts[0]!.quantity?.serialNumbers ?? []) !== stableStringify([expectedSerial])) {
    throw new Error('CANARY_MANUAL_COMPLETION_PUT_MISMATCH');
  }
  const plannedProjection = canonicalManufacturingOrderProjection(stagingPlan.request.body);
  const actualProjection = canonicalManufacturingOrderProjection(actual);
  if (stableStringify(plannedProjection.pickLines) !== stableStringify(actualProjection.pickLines) ||
    stableStringify(plannedProjection.pickMatchings) !== stableStringify(actualProjection.pickMatchings)) {
    throw new Error('CANARY_MANUAL_COMPLETION_PICK_MISMATCH');
  }
  return true;
}

export function planManufacturingPickBatchCanaryCleanup(
  kind: CanarySubjectKind,
  current: ManufacturingOrder,
  expandedBaseline: ManufacturingOrder
) {
  if (!current.manufacturingOrderId || current.manufacturingOrderId !== expandedBaseline.manufacturingOrderId || !current.timestamp) {
    throw new Error(`CANARY_CLEANUP_SOURCE_INVALID: ${kind}`);
  }
  const body = structuredClone(current);
  body.pickLines = [];
  body.pickMatchings = [];
  body.putLines = [];
  body.isCompleted = expandedBaseline.isCompleted ?? false;
  body.isCancelled = expandedBaseline.isCancelled ?? false;
  body.status = expandedBaseline.status;
  body.completedDate = expandedBaseline.completedDate ?? null;
  const baselineLines = new Map(flattenManufacturingLines(expandedBaseline.lines ?? []).map((line) => [line.manufacturingOrderLineId, line]));
  for (const line of flattenManufacturingLines(body.lines ?? [])) {
    const baseline = baselineLines.get(line.manufacturingOrderLineId);
    if (!baseline) throw new Error(`CANARY_CLEANUP_LINE_DRIFT: ${kind}`);
    line.quantity = {
      ...line.quantity,
      serialNumbers: [...(baseline.quantity?.serialNumbers ?? [])],
    };
  }
  const request = { method: 'PUT' as const, path: '/manufacturing-orders' as const, body };
  return {
    schemaVersion: 'manufacturing-pick-batch-cleanup-plan/v2' as const,
    subject: kind,
    sourceTimestamp: current.timestamp,
    sourceProjectionHash: canonicalHash(
      canonicalManufacturingOrderProjection(current),
      'manufacturing-pick-batch-canary/cleanup-source/v2'
    ),
    request,
    requestHash: hashCanaryRequest(request),
    expectedInertProjectionHash: canonicalHash(
      canonicalManufacturingOrderProjection(body),
      'manufacturing-pick-batch-canary/inert-mo/v2'
    ),
  };
}

export function assertManufacturingPickBatchCanaryRestoration(before: unknown, after: unknown): string {
  const beforeHash = canonicalHash(before, 'manufacturing-pick-batch-canary/restoration/v2');
  const afterHash = canonicalHash(after, 'manufacturing-pick-batch-canary/restoration/v2');
  if (beforeHash !== afterHash) throw new Error('CANARY_BASELINE_RESTORATION_MISMATCH');
  return beforeHash;
}

export async function readCanaryManufacturingOrder(
  client: Pick<InflowClient, 'get'>,
  manufacturingOrderId: string
): Promise<ManufacturingOrder> {
  const order = await client.get<ManufacturingOrder>(
    `/manufacturing-orders/${manufacturingOrderId}`,
    { include: MO_TRACE_INCLUDE }
  );
  assertCanaryManufacturingOrderFullTrace(order, manufacturingOrderId);
  return order;
}

export function assertCanaryManufacturingOrderFullTrace(
  order: ManufacturingOrder,
  expectedId?: string
): void {
  const fail = (field: string): never => {
    throw new Error(`CANARY_FULL_MO_TRACE_INCOMPLETE: ${expectedId ?? order.manufacturingOrderId ?? 'unknown'}:${field}`);
  };
  if (!Array.isArray(order.lines)) fail('lines');
  if (!Array.isArray(order.pickLines)) fail('pickLines');
  if (!Array.isArray(order.pickMatchings)) fail('pickMatchings');
  if (!Array.isArray(order.putLines)) fail('putLines');
  const visit = (
    lines: ManufacturingOrder['lines'],
    path: string,
    requireExpandedRelations: boolean,
  ): void => {
    for (const [index, line] of (lines ?? []).entries()) {
      const linePath = `${path}[${index}]`;
      const childLines = line.manufacturingOrderLines;
      const operations = line.manufacturingOrderOperations;
      if (requireExpandedRelations && !Array.isArray(childLines)) {
        fail(`${linePath}.manufacturingOrderLines`);
      }
      if (requireExpandedRelations && !Array.isArray(operations)) {
        fail(`${linePath}.manufacturingOrderOperations`);
      }
      if (childLines != null && !Array.isArray(childLines)) {
        fail(`${linePath}.manufacturingOrderLines`);
      }
      if (operations != null && !Array.isArray(operations)) {
        fail(`${linePath}.manufacturingOrderOperations`);
      }
      visit(childLines ?? [], `${linePath}.manufacturingOrderLines`, false);
    }
  };
  visit(order.lines, 'lines', true);
}

export async function discoverManufacturingPickBatchResiduals(input: {
  client: Pick<InflowClient, 'get'> & Partial<Pick<InflowClient, 'getList'>>;
  subjects: Record<CanarySubjectKind, {
    manufacturingOrderId: string;
    expectedInertProjectionHash: string;
    coordinatorMarker?: string;
    finishedProductId?: string;
  }>;
  approvedInertArtifactIds: string[];
  inventoryScope?: {
    productIds: string[];
    watchedSerials: WatchedSerialIdentity[];
    expected: { inventory: unknown; serials: unknown };
  };
}): Promise<{ confirmedResidualIds: string[]; possibleResidualIds: string[] }> {
  const confirmedResidualIds: string[] = [];
  const possibleResidualIds: string[] = [];
  let markerCandidates: ManufacturingOrder[] | undefined;
  if (input.client.getList) {
    try {
      const pageSize = 100;
      const maximumPages = 100;
      let expectedTotalCount: number | undefined;
      markerCandidates = [];
      for (let page = 0; page < maximumPages; page += 1) {
        const result = await input.client.getList<ManufacturingOrder>('/manufacturing-orders', {
          pagination: { skip: page * pageSize, count: pageSize },
          includeCount: true,
        });
        if (result.totalCount !== undefined) {
          if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0) {
            throw new Error('CANARY_RESIDUAL_MARKER_SCAN_INVALID_TOTAL_COUNT');
          }
          if (expectedTotalCount !== undefined && result.totalCount !== expectedTotalCount) {
            throw new Error('CANARY_RESIDUAL_MARKER_SCAN_TOTAL_COUNT_CHANGED');
          }
          expectedTotalCount = result.totalCount;
        }
        markerCandidates.push(...result.data);
        if (expectedTotalCount !== undefined) {
          if (markerCandidates.length > expectedTotalCount) {
            throw new Error('CANARY_RESIDUAL_MARKER_SCAN_COUNT_EXCEEDED');
          }
          if (markerCandidates.length >= expectedTotalCount) break;
          if (result.data.length < pageSize) {
            throw new Error('CANARY_RESIDUAL_MARKER_SCAN_PREMATURE_SHORT_PAGE');
          }
        } else if (result.data.length < pageSize) {
          break;
        }
        if (page === maximumPages - 1) {
          throw new Error('CANARY_RESIDUAL_MARKER_SCAN_LIMIT_EXCEEDED');
        }
      }
    } catch {
      markerCandidates = undefined;
    }
  }
  for (const kind of ['complete', 'staging'] as const) {
    const subject = input.subjects[kind];
    try {
      const current = await readCanaryManufacturingOrder(input.client, subject.manufacturingOrderId);
      const hash = canonicalHash(canonicalManufacturingOrderProjection(current), 'manufacturing-pick-batch-canary/inert-mo/v2');
      if (hash !== subject.expectedInertProjectionHash) {
        possibleResidualIds.push(`${subject.manufacturingOrderId}:semantic-mismatch`);
      } else if ((current.pickLines?.length ?? 0) > 0 || (current.pickMatchings?.length ?? 0) > 0 || (current.putLines?.length ?? 0) > 0) {
        possibleResidualIds.push(`${subject.manufacturingOrderId}:active-stock-rows`);
      } else {
        confirmedResidualIds.push(subject.manufacturingOrderId);
      }
      if (!input.client.getList) {
        possibleResidualIds.push('residual-query:manufacturing-order-list-unsupported');
        continue;
      }
      if (!current.manufacturingOrderNumber) {
        possibleResidualIds.push(`${subject.manufacturingOrderId}:order-number-unavailable`);
      } else {
        try {
          const byNumber = await input.client.getList<ManufacturingOrder>('/manufacturing-orders', {
            filters: { manufacturingOrderNumber: current.manufacturingOrderNumber },
            include: MO_TRACE_INCLUDE,
          });
          for (const [index, candidate] of byNumber.data.entries()) {
            if (candidate.manufacturingOrderNumber !== current.manufacturingOrderNumber) continue;
            if (candidate.manufacturingOrderId !== subject.manufacturingOrderId) {
              possibleResidualIds.push(`${candidate.manufacturingOrderId ?? 'unknown'}:order-number-collision`);
              continue;
            }
            assertCanaryManufacturingOrderFullTrace(candidate, `${subject.manufacturingOrderId}:order-number[${index}]`);
          }
          if (!byNumber.data.some((candidate) => candidate.manufacturingOrderId === subject.manufacturingOrderId)) {
            possibleResidualIds.push(`${subject.manufacturingOrderId}:order-number-query-missing`);
          }
        } catch {
          possibleResidualIds.push(`${subject.manufacturingOrderId}:order-number-query-unavailable`);
        }
      }
      if (!subject.finishedProductId || !subject.coordinatorMarker) {
        possibleResidualIds.push(`${subject.manufacturingOrderId}:marker-query-input-missing`);
      } else if (!markerCandidates) {
        possibleResidualIds.push(`${subject.manufacturingOrderId}:marker-query-unavailable`);
      } else {
        let markerHit = false;
        for (const candidate of markerCandidates) {
          if (candidate.primaryFinishedProductId !== subject.finishedProductId) continue;
          const hasExactMarker = (candidate.remarks ?? '')
            .split(/\r?\n/u)
            .some((line) => line.trim() === subject.coordinatorMarker);
          if (!hasExactMarker) continue;
          markerHit = true;
          if (candidate.manufacturingOrderId !== subject.manufacturingOrderId) {
            possibleResidualIds.push(`${candidate.manufacturingOrderId ?? 'unknown'}:marker-collision`);
          }
        }
        if (!markerHit) possibleResidualIds.push(`${subject.manufacturingOrderId}:marker-query-missing`);
      }
    } catch {
      possibleResidualIds.push(`${subject.manufacturingOrderId}:unreadable`);
    }
  }
  if (!input.inventoryScope) {
    possibleResidualIds.push('residual-query:product-inventory-scope-missing');
  } else {
    try {
      const actual = await readAuthoritativeCanaryInventory(
        input.client,
        input.inventoryScope.productIds,
        input.inventoryScope.watchedSerials
      );
      if (stableStringify(actual.inventory) !== stableStringify(input.inventoryScope.expected.inventory)) {
        possibleResidualIds.push('residual-query:product-inventory-mismatch');
      }
      if (stableStringify(actual.serials) !== stableStringify(input.inventoryScope.expected.serials)) {
        possibleResidualIds.push('residual-query:serial-inventory-mismatch');
      }
    } catch {
      possibleResidualIds.push('residual-query:product-inventory-unavailable');
    }
  }
  const approved = [...new Set(input.approvedInertArtifactIds)].sort();
  const confirmed = [...new Set(confirmedResidualIds)].sort();
  if (stableStringify(approved) !== stableStringify(confirmed)) {
    possibleResidualIds.push('approved-inert-set-mismatch');
  }
  return { confirmedResidualIds: confirmed, possibleResidualIds: [...new Set(possibleResidualIds)].sort() };
}

export type ManufacturingPickBatchCanaryState =
  | 'initialized'
  | 'create_dispatched_or_recovered'
  | 'expanded_verified'
  | 'stock_plan_ready'
  | 'stock_dispatched'
  | 'stock_verified'
  | 'negative_probes_verified'
  | 'waiting_manual_completion'
  | 'manual_completion_verified'
  | 'cleanup_plan_ready'
  | 'cleanup_dispatched'
  | 'restored_verified'
  | 'attested'
  | 'failed_uncertain';

export interface ManufacturingPickBatchCanaryMutationRecordV2 {
  subject: CanarySubjectKind;
  phase: string;
  requestHash: string;
  correlationId: string;
  dispatchCount: number;
  outcome: 'dispatch-barrier' | 'applied' | 'recovered' | 'definitive-rejection' | 'failed_uncertain';
  readbackHash?: string;
  rawResponseHash?: string;
  rawResponseEvidence?: unknown;
}

export interface ManufacturingPickBatchCanaryCheckpointV2 {
  schemaVersion: 'manufacturing-pick-batch-canary-checkpoint/v2';
  scenarioId: string;
  scenarioManifestHash: string;
  state: ManufacturingPickBatchCanaryState;
  predecessorHash: string | null;
  checkpointHash: string;
  stagePlans: { create: ReturnType<typeof buildCreateStagePlan>; [stage: string]: unknown };
  subjects: Partial<Record<CanarySubjectKind, { expanded?: ManufacturingOrder; latest?: ManufacturingOrder }>>;
  mutations: Record<string, ManufacturingPickBatchCanaryMutationRecordV2>;
  evidence: Record<string, unknown>;
}

function sealCanaryCheckpoint(
  checkpoint: Omit<ManufacturingPickBatchCanaryCheckpointV2, 'checkpointHash'> & { checkpointHash?: string }
): ManufacturingPickBatchCanaryCheckpointV2 {
  const { checkpointHash: _ignored, ...payload } = checkpoint;
  return {
    ...payload,
    checkpointHash: canonicalHash(payload, 'manufacturing-pick-batch-canary/checkpoint/v2'),
  };
}

export function createManufacturingPickBatchCanaryCheckpoint(
  scenario: ManufacturingPickBatchCanaryScenarioV2
): ManufacturingPickBatchCanaryCheckpointV2 {
  return sealCanaryCheckpoint({
    schemaVersion: 'manufacturing-pick-batch-canary-checkpoint/v2',
    scenarioId: scenario.scenarioId,
    scenarioManifestHash: manufacturingPickBatchCanaryScenarioV2Hash(scenario),
    state: 'initialized',
    predecessorHash: null,
    stagePlans: { create: buildCreateStagePlan(scenario) },
    subjects: {},
    mutations: {},
    evidence: {},
  });
}

export function reserveCanaryDispatch(
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2,
  subject: CanarySubjectKind,
  phase: string,
  requestHash: string,
  correlationId: string
): ManufacturingPickBatchCanaryCheckpointV2 {
  const key = `${subject}:${phase}`;
  if (checkpoint.mutations[key]) throw new Error(`CANARY_TWO_WRITE_FALLBACK_REFUSED: ${key}`);
  if (!/^[a-f0-9]{64}$/.test(requestHash) || !correlationId.trim()) throw new Error('CANARY_DISPATCH_FENCE_INVALID');
  const next = structuredClone(checkpoint);
  next.predecessorHash = checkpoint.checkpointHash;
  next.mutations[key] = {
    subject,
    phase,
    requestHash,
    correlationId,
    dispatchCount: 1,
    outcome: 'dispatch-barrier',
  };
  return sealCanaryCheckpoint(next);
}

export function assertManufacturingPickBatchCanaryDispatchCounts(
  mutations: Record<string, { dispatchCount: number }>
): true {
  for (const [key, record] of Object.entries(mutations)) {
    if (!Number.isSafeInteger(record.dispatchCount) || record.dispatchCount < 0 || record.dispatchCount > 1) {
      throw new Error(`CANARY_TWO_WRITE_FALLBACK_REFUSED: ${key}`);
    }
  }
  return true;
}

function checkpointFile(stateDir: string, scenarioId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scenarioId)) throw new Error('CANARY_SCENARIO_ID_PATH_REFUSED');
  return join(stateDir, 'canaries', 'manufacturing-pick-batch', `${scenarioId}.json`);
}

async function ensurePrivateCanaryDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`UNSAFE_CANARY_CHECKPOINT_DIRECTORY: ${path}`);
  }
}

export async function recordCanaryCheckpoint(
  stateDir: string,
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2
): Promise<void> {
  assertManufacturingPickBatchCanaryDispatchCounts(checkpoint.mutations);
  const sealed = sealCanaryCheckpoint(checkpoint);
  if (sealed.checkpointHash !== checkpoint.checkpointHash) throw new Error('CANARY_CHECKPOINT_HASH_MISMATCH');
  const path = checkpointFile(stateDir, checkpoint.scenarioId);
  await ensurePrivateCanaryDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${stableStringify(checkpoint)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function loadManufacturingPickBatchCanaryCheckpoint(
  stateDir: string,
  scenarioId: string
): Promise<ManufacturingPickBatchCanaryCheckpointV2> {
  const path = checkpointFile(stateDir, scenarioId);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`UNSAFE_CANARY_CHECKPOINT_FILE: ${path}`);
  }
  const checkpoint = JSON.parse(await readFile(path, 'utf8')) as ManufacturingPickBatchCanaryCheckpointV2;
  if (checkpoint.schemaVersion !== 'manufacturing-pick-batch-canary-checkpoint/v2' || checkpoint.scenarioId !== scenarioId) {
    throw new Error('CANARY_CHECKPOINT_INVALID');
  }
  const sealed = sealCanaryCheckpoint(checkpoint);
  if (sealed.checkpointHash !== checkpoint.checkpointHash) throw new Error('CANARY_CHECKPOINT_HASH_MISMATCH');
  assertManufacturingPickBatchCanaryDispatchCounts(checkpoint.mutations);
  return checkpoint;
}

export async function withManufacturingPickBatchCanaryLock<T>(
  stateDir: string,
  scenarioId: string,
  action: () => Promise<T>
): Promise<T> {
  const path = checkpointFile(stateDir, scenarioId);
  await ensurePrivateCanaryDirectory(dirname(path));
  const lockPath = `${path}.lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('CANARY_CHECKPOINT_LOCKED');
    }
    throw error;
  }
  const ownedLock = await handle.stat();
  await handle.writeFile(stableStringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.sync();
  try {
    return await action();
  } finally {
    await handle.close();
    const currentLock = await lstat(lockPath).catch(() => undefined);
    if (
      currentLock &&
      currentLock.dev === ownedLock.dev &&
      currentLock.ino === ownedLock.ino
    ) {
      await unlink(lockPath);
    } else {
      throw new Error('CANARY_CHECKPOINT_LOCK_OWNERSHIP_LOST');
    }
  }
}

export function isManufacturingPickBatchTransportAmbiguous(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof InflowApiError && error.statusCode === 408);
}

export function parseManufacturingPickBatchCanaryStageApprovals(
  raw: string | undefined
): ManufacturingPickBatchCanaryStageApproval[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('CANARY_STAGE_APPROVALS_INVALID: invalid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('CANARY_STAGE_APPROVALS_INVALID: expected an array');
  const stages = new Set<ManufacturingPickBatchCanaryStage>();
  return parsed.map((entry, index) => {
    const approval = requireJsonObject(entry, `approvals[${index}]`);
    const keys = [
      'schemaVersion', 'approved', 'approvalNonce', 'stage', 'tenantFingerprint', 'baseHost',
      'apiVersion', 'probeBuild', 'adapterManifestHash', 'serializerVersion', 'contractVersion',
      'scenarioManifestHash', 'checkpointHash', 'stagePlanHash', 'issuedAt', 'expiresAt',
      'approvedInertArtifactIds',
    ];
    requireExactKeys(approval, keys, keys, `approvals[${index}]`);
    if (approval.schemaVersion !== 'manufacturing-pick-batch-canary-stage-approval/v1' || approval.approved !== true ||
      !['create', 'stock-move', 'negative-probes', 'manual-completion-read', 'cleanup', 'attest'].includes(String(approval.stage))) {
      throw new Error('CANARY_STAGE_APPROVALS_INVALID: schema, approval, or stage');
    }
    const typed = approval as unknown as ManufacturingPickBatchCanaryStageApproval;
    if (stages.has(typed.stage)) throw new Error(`CANARY_STAGE_APPROVALS_INVALID: duplicate ${typed.stage}`);
    stages.add(typed.stage);
    return typed;
  });
}

export function assertManufacturingPickBatchCanaryStageApproval(input: {
  config: InflowConfig;
  approval: ManufacturingPickBatchCanaryStageApproval | undefined;
  telemetry: ClientTelemetry;
  scenarioManifestHash: string;
  checkpointHash: string;
  stage: ManufacturingPickBatchCanaryStage;
  stagePlanHash: string;
  approvedInertArtifactIds: string[];
}): string {
  const approval = input.approval;
  if (!approval) throw new Error(`CANARY_STAGE_APPROVAL_REQUIRED: ${input.stage}`);
  if (
    input.config.safeWritesEnabled !== false ||
    input.config.stockWritesEnabled !== false ||
    input.config.writeGates[MANUFACTURING_PICK_BATCH_DOMAIN] !== false
  ) {
    throw new Error('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');
  }
  if (input.telemetry.mutationRetryPolicy.maxRetries !== 0 ||
    input.config.rateLimitPerMinute !== MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT ||
    input.telemetry.rateLimiter.scope !== 'process-local' || input.telemetry.rateLimiter.capacity !== 20 ||
    input.telemetry.rateLimiter.queued !== 0 || input.telemetry.rateLimiter.availableTokens < 1) {
    throw new Error('CANARY_DEDICATED_ZERO_RETRY_RATE_BUDGET_REQUIRED');
  }
  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt <= Date.now()) {
    throw new Error('CANARY_STAGE_APPROVAL_EXPIRED');
  }
  const identity = expectedApprovalIdentity(input.config, input.scenarioManifestHash);
  for (const [field, expected] of Object.entries(identity)) {
    if (approval[field as keyof ManufacturingPickBatchCanaryStageApproval] !== expected) {
      throw new Error(`CANARY_STAGE_APPROVAL_IDENTITY_MISMATCH: ${field}`);
    }
  }
  if (approval.stage !== input.stage || approval.checkpointHash !== input.checkpointHash ||
    approval.stagePlanHash !== input.stagePlanHash || !approval.approvalNonce?.trim()) {
    throw new Error('CANARY_STAGE_APPROVAL_PLAN_MISMATCH');
  }
  if (stableStringify([...approval.approvedInertArtifactIds].sort()) !==
    stableStringify([...input.approvedInertArtifactIds].sort())) {
    throw new Error('CANARY_STAGE_APPROVAL_RESIDUAL_MISMATCH');
  }
  return approval.approvalNonce.trim();
}

export type ManufacturingPickBatchCanaryDefinitiveRejectionStatusCode = 400 | 409 | 412 | 422;

export interface ManufacturingPickBatchCanaryExpectedRejectionV2 {
  statusCode: ManufacturingPickBatchCanaryDefinitiveRejectionStatusCode;
  code: string | null;
}

export interface ManufacturingPickBatchCanaryRuntimeMaterialV2 {
  stockMove?: {
    intents: Record<CanarySubjectKind, ManufacturingComponentIntent[]>;
  };
  negativeProbes?: {
    staleExpectedRejection: ManufacturingPickBatchCanaryExpectedRejectionV2;
    serialExclusion: SerialExclusionProbeInput & {
      subject: CanarySubjectKind;
      expectedRejection: ManufacturingPickBatchCanaryExpectedRejectionV2;
    };
  };
}

const MANUFACTURING_PICK_BATCH_DEFINITIVE_REJECTION_STATUS_CODES = new Set<number>([
  400,
  409,
  412,
  422,
]);

function runtimeMaterialInvalid(detail: string): never {
  throw new Error(`CANARY_RUNTIME_MATERIAL_INVALID: ${detail}`);
}

function requireRuntimeMaterialObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    runtimeMaterialInvalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRuntimeMaterialExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra) runtimeMaterialInvalid(`${label}.${extra} is not allowed`);
  const missing = required.find((key) => !(key in value));
  if (missing) runtimeMaterialInvalid(`${label}.${missing} is required`);
}

function parseManufacturingPickBatchExpectedRejectionV2(
  value: unknown,
  label: string
): ManufacturingPickBatchCanaryExpectedRejectionV2 {
  const rejection = requireRuntimeMaterialObject(value, label);
  requireRuntimeMaterialExactKeys(rejection, ['statusCode', 'code'], ['statusCode', 'code'], label);
  if (typeof rejection.statusCode !== 'number' ||
    !MANUFACTURING_PICK_BATCH_DEFINITIVE_REJECTION_STATUS_CODES.has(rejection.statusCode)) {
    runtimeMaterialInvalid(`${label}.statusCode must be exactly one of 400, 409, 412, or 422`);
  }
  if (rejection.code !== null &&
    (typeof rejection.code !== 'string' || !rejection.code.trim())) {
    runtimeMaterialInvalid(`${label}.code must be null or a non-empty provider code`);
  }
  return {
    statusCode: rejection.statusCode as ManufacturingPickBatchCanaryDefinitiveRejectionStatusCode,
    code: rejection.code as string | null,
  };
}

export function parseManufacturingPickBatchCanaryRuntimeMaterialV2(
  raw: string | undefined
): ManufacturingPickBatchCanaryRuntimeMaterialV2 {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('CANARY_RUNTIME_MATERIAL_INVALID: invalid JSON'); }
  const value = requireRuntimeMaterialObject(parsed, 'runtimeMaterial');
  requireRuntimeMaterialExactKeys(value, ['stockMove', 'negativeProbes'], [], 'runtimeMaterial');
  const result: ManufacturingPickBatchCanaryRuntimeMaterialV2 = {};
  if ('stockMove' in value) {
    result.stockMove = structuredClone(value.stockMove) as ManufacturingPickBatchCanaryRuntimeMaterialV2['stockMove'];
  }
  if ('negativeProbes' in value) {
    const negativeProbes = requireRuntimeMaterialObject(value.negativeProbes, 'runtimeMaterial.negativeProbes');
    requireRuntimeMaterialExactKeys(
      negativeProbes,
      ['staleExpectedRejection', 'serialExclusion'],
      ['staleExpectedRejection', 'serialExclusion'],
      'runtimeMaterial.negativeProbes'
    );
    const serialExclusion = requireRuntimeMaterialObject(
      negativeProbes.serialExclusion,
      'runtimeMaterial.negativeProbes.serialExclusion'
    );
    requireRuntimeMaterialExactKeys(
      serialExclusion,
      ['subject', 'productId', 'serial', 'rawLineId', 'reason', 'approvedComponentSerials', 'expectedRejection'],
      ['subject', 'productId', 'serial', 'rawLineId', 'reason', 'approvedComponentSerials', 'expectedRejection'],
      'runtimeMaterial.negativeProbes.serialExclusion'
    );
    if (serialExclusion.subject !== 'complete' && serialExclusion.subject !== 'staging') {
      runtimeMaterialInvalid('runtimeMaterial.negativeProbes.serialExclusion.subject must be complete or staging');
    }
    for (const field of ['productId', 'serial', 'rawLineId', 'reason'] as const) {
      if (typeof serialExclusion[field] !== 'string' || !serialExclusion[field].trim()) {
        runtimeMaterialInvalid(`runtimeMaterial.negativeProbes.serialExclusion.${field} must be a non-empty string`);
      }
    }
    if (!Array.isArray(serialExclusion.approvedComponentSerials) ||
      serialExclusion.approvedComponentSerials.some((serial) => typeof serial !== 'string' || !serial.trim())) {
      runtimeMaterialInvalid(
        'runtimeMaterial.negativeProbes.serialExclusion.approvedComponentSerials must contain only non-empty strings'
      );
    }
    result.negativeProbes = {
      staleExpectedRejection: parseManufacturingPickBatchExpectedRejectionV2(
        negativeProbes.staleExpectedRejection,
        'runtimeMaterial.negativeProbes.staleExpectedRejection'
      ),
      serialExclusion: {
        subject: serialExclusion.subject,
        productId: serialExclusion.productId as string,
        serial: serialExclusion.serial as string,
        rawLineId: serialExclusion.rawLineId as string,
        reason: serialExclusion.reason as string,
        approvedComponentSerials: structuredClone(serialExclusion.approvedComponentSerials) as string[],
        expectedRejection: parseManufacturingPickBatchExpectedRejectionV2(
          serialExclusion.expectedRejection,
          'runtimeMaterial.negativeProbes.serialExclusion.expectedRejection'
        ),
      },
    };
  }
  return result;
}

type V2CanaryClient = Pick<InflowClient, 'get' | 'getList' | 'prepareMutation' | 'telemetrySnapshot'>;

export interface ManufacturingPickBatchCanaryStateMachineResult {
  status:
    | 'approval-required'
    | 'stage-input-required'
    | 'waiting-manual-completion'
    | 'attested';
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2;
  stage?: ManufacturingPickBatchCanaryStage;
  stagePlan?: unknown;
  message?: string;
  attestationIssued: boolean;
}

function advanceCheckpoint(
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2,
  mutate: (next: ManufacturingPickBatchCanaryCheckpointV2) => void
): ManufacturingPickBatchCanaryCheckpointV2 {
  const next = structuredClone(checkpoint);
  next.predecessorHash = checkpoint.checkpointHash;
  mutate(next);
  return sealCanaryCheckpoint(next);
}

function updateMutationOutcome(
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2,
  key: string,
  outcome: ManufacturingPickBatchCanaryMutationRecordV2['outcome'],
  readback?: ManufacturingOrder
): ManufacturingPickBatchCanaryCheckpointV2 {
  return advanceCheckpoint(checkpoint, (next) => {
    const record = next.mutations[key];
    if (!record) throw new Error(`CANARY_MUTATION_RECORD_MISSING: ${key}`);
    record.outcome = outcome;
    if (readback) {
      record.readbackHash = canonicalHash(
        canonicalManufacturingOrderProjection(readback),
        'manufacturing-pick-batch-canary/readback/v2'
      );
    }
  });
}

function verifyExpandedSubject(
  kind: CanarySubjectKind,
  scenario: ManufacturingPickBatchCanaryScenarioV2,
  order: ManufacturingOrder
): void {
  const begin = planManufacturingRunBegin(scenario.subjects[kind].beginInput);
  const snapshot = captureManufacturingSnapshot(order, begin);
  const structuralSubassemblies = snapshot.lines.filter(
    (line) => line.rawLineId !== snapshot.rootLineId && line.structural === true
  );
  if (structuralSubassemblies.length === 0) {
    throw new Error(`CANARY_EXPANDED_SUBASSEMBLY_REQUIRED: ${kind}`);
  }
  const consumableIds = new Set(
    consumableManufacturingLines(snapshot).map((line) => line.rawLineId)
  );
  if (
    structuralSubassemblies.some((line) => consumableIds.has(line.rawLineId)) ||
    consumableManufacturingLines(snapshot).some((line) => line.structural === true)
  ) {
    throw new Error(`CANARY_STRUCTURAL_SUBASSEMBLY_PICKABLE: ${kind}`);
  }
  if (!order.timestamp) throw new Error(`CANARY_BEGIN_ROWVERSION_REQUIRED: ${kind}`);
  if (order.isCompleted || order.isCancelled || (order.pickLines?.length ?? 0) !== 0 ||
    (order.pickMatchings?.length ?? 0) !== 0 || (order.putLines?.length ?? 0) !== 0) {
    throw new Error(`CANARY_EXPANDED_SUBJECT_NOT_INERT: ${kind}`);
  }
  if (kind === 'complete' && snapshot.operations.length !== 0) {
    throw new Error('CANARY_COMPLETE_SUBJECT_OPERATIONS_PRESENT');
  }
  if (kind === 'staging' && snapshot.operations.length === 0) {
    throw new Error('CANARY_STAGING_SUBJECT_OPERATIONS_MISSING');
  }
}

async function readManufacturingOrderIfPresentV2(
  client: Pick<InflowClient, 'get'>,
  manufacturingOrderId: string
): Promise<ManufacturingOrder | undefined> {
  try {
    return await readCanaryManufacturingOrder(client, manufacturingOrderId);
  } catch (error) {
    if (error instanceof InflowApiError && error.statusCode === 404) return undefined;
    throw error;
  }
}

async function readAuthoritativeCanaryInventory(
  client: Pick<InflowClient, 'get'>,
  productIds: string[],
  watchedSerials: WatchedSerialIdentity[]
): Promise<{ inventory: unknown; serials: unknown; inventoryLines: unknown }> {
  const summaries: ProductSummary[] = [];
  const products: Product[] = [];
  for (const productId of [...new Set(productIds)].sort()) {
    summaries.push(await client.get<ProductSummary>(`/products/${productId}/summary`, {
      include: ['locationSummaries', 'sublocationSummaries'],
    }));
    const product = await client.get<Product>(`/products/${productId}`, { include: ['inventoryLines'] });
    if (!Array.isArray(product.inventoryLines)) {
      throw new Error(`CANARY_INVENTORY_LINES_MISSING: ${productId}`);
    }
    products.push(product);
  }
  return {
    inventory: canonicalInventorySummaryProjection(summaries),
    serials: canonicalSerialInventoryProjection(products, watchedSerials),
    inventoryLines: products.map((product) => ({
      productId: product.productId ?? '',
      lines: product.inventoryLines!
        .filter((line) => normalizeDecimal(line.quantityOnHand ?? '0') !== '0')
        .map((line) => ({
          serial: line.serial?.normalize('NFKC').trim().toUpperCase() || null,
          locationId: line.locationId?.trim() ?? '',
          sublocation: line.sublocation?.trim() ?? '',
          quantityOnHand: normalizeDecimal(line.quantityOnHand ?? '0'),
        })).sort((left, right) =>
        (left.serial ?? '').localeCompare(right.serial ?? '') ||
        left.locationId.localeCompare(right.locationId) ||
        left.sublocation.localeCompare(right.sublocation) ||
        left.quantityOnHand.localeCompare(right.quantityOnHand)
      ),
    })).sort((left, right) => left.productId.localeCompare(right.productId)),
  };
}

function structuralSubassemblyProductIds(
  scenario: ManufacturingPickBatchCanaryScenarioV2,
  expanded: Partial<Record<CanarySubjectKind, ManufacturingOrder>>
): string[] {
  const productIds: string[] = [];
  for (const kind of ['complete', 'staging'] as const) {
    const order = expanded[kind];
    if (!order) continue;
    const begin = planManufacturingRunBegin(scenario.subjects[kind].beginInput);
    const snapshot = captureManufacturingSnapshot(order, begin);
    for (const line of snapshot.lines) {
      if (
        line.rawLineId !== snapshot.rootLineId &&
        line.structural === true
      ) {
        productIds.push(line.productId);
      }
    }
  }
  return [...new Set(productIds)].sort();
}

function stockScope(
  scenario: ManufacturingPickBatchCanaryScenarioV2,
  material: NonNullable<ManufacturingPickBatchCanaryRuntimeMaterialV2['stockMove']>,
  expanded: Partial<Record<CanarySubjectKind, ManufacturingOrder>> = {}
): ManufacturingPickBatchCanaryInventoryScope {
  const productIds: string[] = [];
  const watchedSerials: WatchedSerialIdentity[] = [];
  const structuralProductIds = structuralSubassemblyProductIds(
    scenario,
    expanded
  );
  productIds.push(...structuralProductIds);
  for (const kind of ['complete', 'staging'] as const) {
    const finishedProductId = scenario.subjects[kind].beginInput.identity.finishedProductId;
    productIds.push(finishedProductId);
    watchedSerials.push({ productId: finishedProductId, serial: scenario.subjects[kind].output.serialNumber });
    for (const intent of material.intents[kind] ?? []) {
      productIds.push(intent.productId);
      for (const serial of intent.serialNumbers) watchedSerials.push({ productId: intent.productId, serial });
    }
  }
  const identities = new Set<string>();
  for (const identity of watchedSerials) {
    const key = `${identity.productId}\0${identity.serial.toUpperCase()}`;
    if (identities.has(key)) throw new Error(`CANARY_WATCHED_SERIAL_REUSED: ${identity.productId}:${identity.serial}`);
    identities.add(key);
  }
  return {
    productIds: [...new Set(productIds)].sort(),
    watchedSerials,
    structuralProductIds,
  };
}

function structuralInventoryProjection(
  evidence: { inventory: unknown; inventoryLines?: unknown },
  structuralProductIds: string[]
): unknown {
  const ids = new Set(structuralProductIds);
  if (ids.size === 0) return { inventory: [], inventoryLines: [] };
  if (!Array.isArray(evidence.inventory)) {
    throw new Error('CANARY_STRUCTURAL_INVENTORY_PROJECTION_INVALID');
  }
  const rows = evidence.inventory.filter((row): row is { productId: string } & Record<string, unknown> =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as { productId?: unknown }).productId === 'string' &&
    ids.has((row as { productId: string }).productId)
  );
  if (rows.length !== ids.size) {
    throw new Error('CANARY_STRUCTURAL_INVENTORY_SCOPE_INCOMPLETE');
  }
  if (!Array.isArray(evidence.inventoryLines)) {
    throw new Error('CANARY_STRUCTURAL_INVENTORY_LINES_MISSING');
  }
  const inventoryLines = evidence.inventoryLines.filter(
    (row): row is { productId: string } & Record<string, unknown> =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { productId?: unknown }).productId === 'string' &&
      ids.has((row as { productId: string }).productId)
  );
  if (inventoryLines.length !== ids.size) {
    throw new Error('CANARY_STRUCTURAL_INVENTORY_LINES_SCOPE_INCOMPLETE');
  }
  return {
    inventory: rows.sort((left, right) => left.productId.localeCompare(right.productId)),
    inventoryLines: inventoryLines.sort(
      (left, right) => left.productId.localeCompare(right.productId)
    ),
  };
}

function structuralInventoryHash(
  evidence: { inventory: unknown; inventoryLines?: unknown },
  structuralProductIds: string[]
): string {
  return canonicalHash(
    structuralInventoryProjection(evidence, structuralProductIds),
    'manufacturing-pick-batch-canary/structural-inventory/v2'
  );
}

function assertStructuralInventoryUnchanged(input: {
  structuralProductIds: string[];
  before: { inventory: unknown };
  after: { inventory: unknown };
  phase: string;
}): string {
  const beforeHash = structuralInventoryHash(
    input.before,
    input.structuralProductIds
  );
  const afterHash = structuralInventoryHash(
    input.after,
    input.structuralProductIds
  );
  if (beforeHash !== afterHash) {
    throw new Error(`CANARY_STRUCTURAL_INVENTORY_CHANGED: ${input.phase}`);
  }
  return afterHash;
}

function approvalRequired(
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2,
  stage: ManufacturingPickBatchCanaryStage,
  stagePlan: unknown
): ManufacturingPickBatchCanaryStateMachineResult {
  return { status: 'approval-required', checkpoint, stage, stagePlan, attestationIssued: false };
}

function mutationErrorEvidence(error: unknown): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof InflowApiError) {
    evidence.statusCode = error.statusCode;
    const apiError = error.apiError;
    if (apiError && typeof apiError === 'object') {
      const code = (apiError as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) evidence.code = code;
      const message = (apiError as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) evidence.apiMessage = message;
    }
  }
  return evidence;
}

async function executeFencedAppliedMutation(input: {
  stateDir: string;
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2;
  client: V2CanaryClient;
  subject: CanarySubjectKind;
  phase: string;
  request: ManufacturingPickBatchMutationRequest;
  verify: (readback: ManufacturingOrder) => void;
  readback: () => Promise<ManufacturingOrder>;
}): Promise<{ checkpoint: ManufacturingPickBatchCanaryCheckpointV2; readback: ManufacturingOrder }> {
  const key = `${input.subject}:${input.phase}`;
  const requestHash = hashCanaryRequest(input.request);
  const existing = input.checkpoint.mutations[key];
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error(`CANARY_RESUME_REQUEST_HASH_MISMATCH: ${key}`);
    const readback = await input.readback();
    if (existing.outcome === 'failed_uncertain') {
      try { input.verify(readback); } catch {
        throw new Error(`CANARY_FAILED_UNCERTAIN: ${key}`);
      }
      const recovered = updateMutationOutcome(input.checkpoint, key, 'recovered', readback);
      await recordCanaryCheckpoint(input.stateDir, recovered);
      return { checkpoint: recovered, readback };
    }
    try { input.verify(readback); } catch (error) {
      const failed = updateMutationOutcome(input.checkpoint, key, 'failed_uncertain');
      await recordCanaryCheckpoint(input.stateDir, failed);
      throw error;
    }
    if (existing.outcome === 'dispatch-barrier') {
      const recovered = updateMutationOutcome(input.checkpoint, key, 'recovered', readback);
      await recordCanaryCheckpoint(input.stateDir, recovered);
      return { checkpoint: recovered, readback };
    }
    return { checkpoint: input.checkpoint, readback };
  }
  const prepared = await input.client.prepareMutation<unknown>(
    input.request.method,
    input.request.path,
    { params: input.request.query, body: input.request.body }
  );
  let checkpoint = reserveCanaryDispatch(
    input.checkpoint,
    input.subject,
    input.phase,
    requestHash,
    prepared.correlationId
  );
  await recordCanaryCheckpoint(input.stateDir, checkpoint);
  try {
    const rawResponseEvidence = await prepared.dispatch();
    checkpoint = advanceCheckpoint(checkpoint, (next) => {
      const record = next.mutations[key]!;
      record.rawResponseEvidence = rawResponseEvidence;
      record.rawResponseHash = canonicalHash(
        rawResponseEvidence,
        'manufacturing-pick-batch-canary/raw-mutation-response/v2'
      );
    });
    await recordCanaryCheckpoint(input.stateDir, checkpoint);
  } catch (error) {
    if (!isManufacturingPickBatchTransportAmbiguous(error)) {
      const errorEvidence = mutationErrorEvidence(error);
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        const record = next.mutations[key]!;
        record.rawResponseEvidence = errorEvidence;
        record.rawResponseHash = canonicalHash(
          errorEvidence,
          'manufacturing-pick-batch-canary/raw-mutation-error/v2'
        );
        record.outcome = 'failed_uncertain';
      });
      await recordCanaryCheckpoint(input.stateDir, checkpoint);
      throw error;
    }
    const readback = await input.readback().catch(() => undefined);
    if (!readback) {
      checkpoint = updateMutationOutcome(checkpoint, key, 'failed_uncertain');
      await recordCanaryCheckpoint(input.stateDir, checkpoint);
      throw new Error(`CANARY_FAILED_UNCERTAIN: ${key}`);
    }
    try { input.verify(readback); } catch {
      checkpoint = updateMutationOutcome(checkpoint, key, 'failed_uncertain');
      await recordCanaryCheckpoint(input.stateDir, checkpoint);
      throw new Error(`CANARY_FAILED_UNCERTAIN: ${key}`);
    }
    checkpoint = updateMutationOutcome(checkpoint, key, 'recovered', readback);
    await recordCanaryCheckpoint(input.stateDir, checkpoint);
    return { checkpoint, readback };
  }
  const readback = await input.readback();
  try { input.verify(readback); } catch (error) {
    checkpoint = updateMutationOutcome(checkpoint, key, 'failed_uncertain');
    await recordCanaryCheckpoint(input.stateDir, checkpoint);
    throw error;
  }
  checkpoint = updateMutationOutcome(checkpoint, key, 'applied', readback);
  await recordCanaryCheckpoint(input.stateDir, checkpoint);
  return { checkpoint, readback };
}

async function executeFencedDefinitiveRejection(input: {
  stateDir: string;
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2;
  client: V2CanaryClient;
  subject: CanarySubjectKind;
  phase: string;
  request: ManufacturingPickBatchMutationRequest;
  expected: ManufacturingPickBatchCanaryExpectedRejectionV2;
  verifyUnchanged: () => Promise<ManufacturingOrder>;
}): Promise<{ checkpoint: ManufacturingPickBatchCanaryCheckpointV2; readback: ManufacturingOrder }> {
  const expected = parseManufacturingPickBatchExpectedRejectionV2(
    input.expected,
    `runtimeMaterial.negativeProbes.${input.phase}.expectedRejection`
  );
  const key = `${input.subject}:${input.phase}`;
  const requestHash = hashCanaryRequest(input.request);
  const expectedCode = expected.code ?? null;
  const expectedEvidence = {
    name: 'InflowApiError',
    statusCode: expected.statusCode,
    code: expectedCode,
  };
  const expectedEvidenceHash = canonicalHash(
    expectedEvidence,
    'manufacturing-pick-batch-canary/raw-rejection-response/v2'
  );
  const providerCode = (error: InflowApiError): string | null =>
    typeof error.apiError?.code === 'string' ? error.apiError.code : null;
  const existing = input.checkpoint.mutations[key];
  if (existing) {
    if (existing.outcome !== 'definitive-rejection' || existing.requestHash !== requestHash ||
      stableStringify(existing.rawResponseEvidence) !== stableStringify(expectedEvidence) ||
      existing.rawResponseHash !== expectedEvidenceHash) {
      const failed = updateMutationOutcome(input.checkpoint, key, 'failed_uncertain');
      await recordCanaryCheckpoint(input.stateDir, failed);
      throw new Error(`CANARY_REJECTION_RESUME_AMBIGUOUS: ${key}`);
    }
    return { checkpoint: input.checkpoint, readback: await input.verifyUnchanged() };
  }
  const prepared = await input.client.prepareMutation<unknown>(
    input.request.method,
    input.request.path,
    { params: input.request.query, body: input.request.body }
  );
  let checkpoint = reserveCanaryDispatch(
    input.checkpoint, input.subject, input.phase, requestHash, prepared.correlationId
  );
  await recordCanaryCheckpoint(input.stateDir, checkpoint);
  let rejection: unknown;
  try {
    await prepared.dispatch();
  } catch (error) {
    rejection = error;
  }
  if (rejection === undefined) {
    checkpoint = updateMutationOutcome(checkpoint, key, 'failed_uncertain');
    await recordCanaryCheckpoint(input.stateDir, checkpoint);
    throw new Error(`CANARY_EXPECTED_REJECTION_NOT_OBSERVED: ${key}`);
  }
  {
    const error = rejection;
    const mismatch = !(error instanceof InflowApiError)
      ? 'type'
      : error.statusCode !== expected.statusCode
        ? 'status'
        : providerCode(error) !== expectedCode
          ? 'code'
          : undefined;
    if (mismatch) {
      const observedEvidence = error instanceof InflowApiError
        ? {
            name: 'InflowApiError',
            statusCode: error.statusCode,
            code: providerCode(error),
          }
        : mutationErrorEvidence(error);
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        const record = next.mutations[key]!;
        record.rawResponseEvidence = observedEvidence;
        record.rawResponseHash = canonicalHash(
          observedEvidence,
          'manufacturing-pick-batch-canary/raw-rejection-response/v2'
        );
        record.outcome = 'failed_uncertain';
      });
      await recordCanaryCheckpoint(input.stateDir, checkpoint);
      if (isManufacturingPickBatchTransportAmbiguous(error)) {
        throw new Error(`CANARY_REJECTION_AMBIGUOUS: ${key}`);
      }
      throw new Error(`CANARY_REJECTION_EVIDENCE_MISMATCH: ${key}:${mismatch}`);
    }
  }
  const readback = await input.verifyUnchanged();
  checkpoint = advanceCheckpoint(checkpoint, (next) => {
    const record = next.mutations[key]!;
    record.rawResponseEvidence = expectedEvidence;
    record.rawResponseHash = expectedEvidenceHash;
  });
  checkpoint = updateMutationOutcome(checkpoint, key, 'definitive-rejection', readback);
  await recordCanaryCheckpoint(input.stateDir, checkpoint);
  return { checkpoint, readback };
}

function canonicalHoldingMap(serialProjection: unknown): Map<string, Array<{ locationId: string; sublocation: string; quantityOnHand: string }>> {
  const result = new Map<string, Array<{ locationId: string; sublocation: string; quantityOnHand: string }>>();
  for (const row of serialProjection as Array<{
    productId: string;
    serial: string;
    holdings: Array<{ locationId: string; sublocation: string; quantityOnHand: string }>;
  }>) {
    result.set(`${row.productId}\0${row.serial.toUpperCase()}`, row.holdings);
  }
  return result;
}

function inventoryBucketQuantity(
  projection: unknown,
  productId: string,
  locationId: string,
  sublocation: string | undefined,
  inventoryLines?: unknown,
): number {
  const row = (projection as Array<{
    productId: string;
    quantityOnHand: string;
    locations: Array<{
      locationId: string;
      quantityOnHand: string;
      sublocations: Array<{ sublocation: string; quantityOnHand: string }>;
    }>;
  }>).find((candidate) => candidate.productId === productId);
  const location = row?.locations.find((candidate) => candidate.locationId === locationId);
  const summaryValue = sublocation === undefined
    ? location?.quantityOnHand
    : location?.sublocations.find((candidate) => candidate.sublocation === sublocation)?.quantityOnHand;
  if (summaryValue !== undefined) {
    const number = Number(summaryValue);
    if (!Number.isFinite(number)) throw new Error(`CANARY_INVENTORY_DECIMAL_INVALID: ${productId}`);
    return number;
  }

  const inventoryLineProduct = (inventoryLines as Array<{
    productId: string;
    lines: Array<{
      locationId: string;
      sublocation: string;
      quantityOnHand: string;
    }>;
  }> | undefined)?.find((candidate) => candidate.productId === productId);
  if (!inventoryLineProduct) {
    throw new Error(`CANARY_INVENTORY_LINES_SCOPE_INCOMPLETE: ${productId}`);
  }
  const number = inventoryLineProduct.lines
    .filter((line) => line.locationId === locationId &&
      (sublocation === undefined || line.sublocation === sublocation))
    .reduce((total, line) => total + Number(line.quantityOnHand), 0);
  if (!Number.isFinite(number)) throw new Error(`CANARY_INVENTORY_DECIMAL_INVALID: ${productId}`);
  return number;
}

function inventoryTotalQuantity(projection: unknown, productId: string): number {
  const row = (projection as Array<{ productId: string; quantityOnHand: string }>)
    .find((candidate) => candidate.productId === productId);
  if (!row) throw new Error(`CANARY_INVENTORY_SCOPE_INCOMPLETE: ${productId}`);
  const number = Number(row.quantityOnHand);
  if (!Number.isFinite(number)) throw new Error(`CANARY_INVENTORY_DECIMAL_INVALID: ${productId}`);
  return number;
}

function verifyStockMovement(input: {
  scenario: ManufacturingPickBatchCanaryScenarioV2;
  material: NonNullable<ManufacturingPickBatchCanaryRuntimeMaterialV2['stockMove']>;
  before: { inventory: unknown; serials: unknown; inventoryLines?: unknown };
  after: { inventory: unknown; serials: unknown; inventoryLines?: unknown };
  subjects?: CanarySubjectKind[];
}): void {
  const subjects = input.subjects ?? ['complete', 'staging'];
  const componentDeltas = new Map<string, { productId: string; locationId: string; sublocation?: string; quantity: number }>();
  const productDeltas = new Map<string, number>();
  const beforeSerials = canonicalHoldingMap(input.before.serials);
  const afterSerials = canonicalHoldingMap(input.after.serials);
  for (const kind of subjects) {
    for (const intent of input.material.intents[kind]) {
      const key = `${intent.productId}\0${intent.locationId}\0${intent.sublocation ?? ''}`;
      const current = componentDeltas.get(key) ?? {
        productId: intent.productId,
        locationId: intent.locationId,
        sublocation: intent.sublocation,
        quantity: 0,
      };
      current.quantity += Number(intent.quantity);
      componentDeltas.set(key, current);
      productDeltas.set(intent.productId, (productDeltas.get(intent.productId) ?? 0) + Number(intent.quantity));
      for (const serial of intent.serialNumbers) {
        const serialKey = `${intent.productId}\0${serial.toUpperCase()}`;
        const before = beforeSerials.get(serialKey) ?? [];
        const after = afterSerials.get(serialKey) ?? [];
        if (before.length !== 1 || before[0]!.locationId !== intent.locationId ||
          before[0]!.sublocation !== (intent.sublocation ?? '') || after.length !== 0) {
          throw new Error(`CANARY_COMPONENT_SERIAL_MOVEMENT_MISMATCH: ${intent.productId}:${serial}`);
        }
      }
    }
  }
  for (const delta of componentDeltas.values()) {
    const before = inventoryBucketQuantity(
      input.before.inventory,
      delta.productId,
      delta.locationId,
      delta.sublocation,
      input.before.inventoryLines,
    );
    const after = inventoryBucketQuantity(
      input.after.inventory,
      delta.productId,
      delta.locationId,
      delta.sublocation,
      input.after.inventoryLines,
    );
    if (after !== before - delta.quantity) {
      throw new Error(`CANARY_COMPONENT_QUANTITY_MOVEMENT_MISMATCH: ${delta.productId}`);
    }
  }
  for (const [productId, quantity] of productDeltas) {
    const before = inventoryTotalQuantity(input.before.inventory, productId);
    const after = inventoryTotalQuantity(input.after.inventory, productId);
    if (after !== before - quantity) {
      throw new Error(`CANARY_COMPONENT_TOTAL_QUANTITY_MOVEMENT_MISMATCH: ${productId}`);
    }
  }
  for (const kind of subjects) {
    const productId = input.scenario.subjects[kind].beginInput.identity.finishedProductId;
    const serial = input.scenario.subjects[kind].output.serialNumber.toUpperCase();
    const holdings = afterSerials.get(`${productId}\0${serial}`) ?? [];
    if (kind === 'complete') {
      const output = input.scenario.subjects.complete.output;
      if (holdings.length !== 1 || holdings[0]!.locationId !== output.locationId ||
        holdings[0]!.sublocation !== (output.sublocation ?? '') || holdings[0]!.quantityOnHand !== '1') {
        throw new Error('CANARY_COMPLETE_OUTPUT_SERIAL_MOVEMENT_MISMATCH');
      }
    } else if (holdings.length !== 0) {
      throw new Error('CANARY_STAGING_OUTPUT_SERIAL_APPEARED_BEFORE_MANUAL_COMPLETION');
    }
  }
}

function stageApproval(
  approvals: ManufacturingPickBatchCanaryStageApproval[],
  stage: ManufacturingPickBatchCanaryStage
): ManufacturingPickBatchCanaryStageApproval | undefined {
  return approvals.find((approval) => approval.stage === stage);
}

interface PersistedCanaryStageAuthorization {
  stagePlanHash: string;
  approvalNonce: string;
  approvalCheckpointHash: string;
  approval: ManufacturingPickBatchCanaryStageApproval;
}

function persistedStageAuthorization(
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2,
  stage: ManufacturingPickBatchCanaryStage,
  stagePlanHash: string
): PersistedCanaryStageAuthorization | undefined {
  const authorizations = checkpoint.evidence.stageAuthorizations as
    | Partial<Record<ManufacturingPickBatchCanaryStage, PersistedCanaryStageAuthorization>>
    | undefined;
  const authorization = authorizations?.[stage];
  if (
    authorization?.stagePlanHash !== stagePlanHash ||
    !authorization.approvalNonce ||
    authorization.approvalNonce !== authorization.approval?.approvalNonce ||
    authorization.approvalCheckpointHash !== authorization.approval?.checkpointHash
  ) {
    return undefined;
  }
  return authorization;
}

export async function authorizeStage(input: {
  config: InflowConfig;
  client: V2CanaryClient;
  approvals: ManufacturingPickBatchCanaryStageApproval[];
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2;
  scenario: ManufacturingPickBatchCanaryScenarioV2;
  stage: ManufacturingPickBatchCanaryStage;
  stagePlanHash: string;
}): Promise<ManufacturingPickBatchCanaryCheckpointV2> {
  const approval = stageApproval(input.approvals, input.stage);
  if (approval && approval.checkpointHash === input.checkpoint.checkpointHash) {
    assertStage(input, approval);
    const checkpoint = advanceCheckpoint(input.checkpoint, (next) => {
      const authorizations = (next.evidence.stageAuthorizations ?? {}) as Record<string, unknown>;
      authorizations[input.stage] = {
        stagePlanHash: input.stagePlanHash,
        approvalNonce: approval.approvalNonce,
        approvalCheckpointHash: input.checkpoint.checkpointHash,
        approval,
      };
      next.evidence.stageAuthorizations = authorizations;
    });
    await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
    return checkpoint;
  }
  const persisted = persistedStageAuthorization(
    input.checkpoint,
    input.stage,
    input.stagePlanHash
  );
  if (persisted) {
    assertStage(
      input,
      persisted.approval,
      persisted.approvalCheckpointHash
    );
    return input.checkpoint;
  }
  assertStage(input);
  return input.checkpoint;
}

function assertStage(input: {
  config: InflowConfig;
  client: V2CanaryClient;
  approvals: ManufacturingPickBatchCanaryStageApproval[];
  checkpoint: ManufacturingPickBatchCanaryCheckpointV2;
  scenario: ManufacturingPickBatchCanaryScenarioV2;
  stage: ManufacturingPickBatchCanaryStage;
  stagePlanHash: string;
}, approvalOverride?: ManufacturingPickBatchCanaryStageApproval,
checkpointHashOverride?: string): void {
  assertManufacturingPickBatchCanaryStageApproval({
    config: input.config,
    approval: approvalOverride ?? stageApproval(input.approvals, input.stage),
    telemetry: input.client.telemetrySnapshot(),
    scenarioManifestHash: input.checkpoint.scenarioManifestHash,
    checkpointHash: checkpointHashOverride ?? input.checkpoint.checkpointHash,
    stage: input.stage,
    stagePlanHash: input.stagePlanHash,
    approvedInertArtifactIds: input.scenario.approvedInertArtifactIds,
  });
}

function assertCanaryV2RuntimeSafety(config: InflowConfig, telemetry: ClientTelemetry): void {
  if (
    config.safeWritesEnabled !== false ||
    config.stockWritesEnabled !== false ||
    config.writeGates[MANUFACTURING_PICK_BATCH_DOMAIN] !== false
  ) {
    throw new Error('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');
  }
  if (telemetry.mutationRetryPolicy.maxRetries !== 0) {
    throw new Error('CANARY_ZERO_RETRY_CLIENT_REQUIRED');
  }
  if (config.rateLimitPerMinute !== MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT ||
    telemetry.rateLimiter.scope !== 'process-local' ||
    telemetry.rateLimiter.capacity !== MANUFACTURING_PICK_BATCH_CANARY_RATE_LIMIT ||
    telemetry.rateLimiter.queued !== 0 || telemetry.rateLimiter.availableTokens < 1) {
    throw new Error('CANARY_DEDICATED_RATE_BUDGET_REQUIRED');
  }
}

async function readCheckpointOrInitialize(
  stateDir: string,
  scenario: ManufacturingPickBatchCanaryScenarioV2
): Promise<ManufacturingPickBatchCanaryCheckpointV2> {
  try {
    const checkpoint = await loadManufacturingPickBatchCanaryCheckpoint(stateDir, scenario.scenarioId);
    if (checkpoint.scenarioManifestHash !== manufacturingPickBatchCanaryScenarioV2Hash(scenario)) {
      throw new Error('CANARY_CHECKPOINT_SCENARIO_MISMATCH');
    }
    return checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const checkpoint = createManufacturingPickBatchCanaryCheckpoint(scenario);
    await recordCanaryCheckpoint(stateDir, checkpoint);
    return checkpoint;
  }
}

export async function runManufacturingPickBatchCanaryStateMachine(input: {
  config: InflowConfig;
  client: V2CanaryClient;
  scenario: ManufacturingPickBatchCanaryScenarioV2;
  approvals: ManufacturingPickBatchCanaryStageApproval[];
  runtimeMaterial?: ManufacturingPickBatchCanaryRuntimeMaterialV2;
}): Promise<ManufacturingPickBatchCanaryStateMachineResult> {
  return withManufacturingPickBatchCanaryLock(input.config.stateDir, input.scenario.scenarioId, async () => {
    assertCanaryV2RuntimeSafety(input.config, input.client.telemetrySnapshot());
    let checkpoint = await readCheckpointOrInitialize(input.config.stateDir, input.scenario);
    if (checkpoint.state === 'failed_uncertain') throw new Error('CANARY_FAILED_UNCERTAIN: cleanup/recovery authorization required');
    if (checkpoint.state === 'attested') {
      return { status: 'attested', checkpoint, attestationIssued: true };
    }

    if (checkpoint.state === 'initialized' || checkpoint.state === 'create_dispatched_or_recovered') {
      const createPlan = checkpoint.stagePlans.create;
      const approval = stageApproval(input.approvals, 'create');
      if (!approval && !persistedStageAuthorization(checkpoint, 'create', createPlan.stagePlanHash)) {
        return approvalRequired(checkpoint, 'create', createPlan);
      }
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'create', stagePlanHash: createPlan.stagePlanHash });
      for (const kind of ['complete', 'staging'] as const) {
        if (checkpoint.subjects[kind]?.expanded) continue;
        const subjectPlan = createPlan.subjects[kind];
        const key = `${kind}:create`;
        let existing = await readManufacturingOrderIfPresentV2(input.client, subjectPlan.manufacturingOrderId);
        if (existing) {
          verifyExpandedSubject(kind, input.scenario, existing);
          if (!checkpoint.mutations[key]) {
            checkpoint = advanceCheckpoint(checkpoint, (next) => {
              next.mutations[key] = {
                subject: kind,
                phase: 'create',
                requestHash: subjectPlan.requestHash,
                correlationId: 'idempotent-read-recovery',
                dispatchCount: 0,
                outcome: 'recovered',
                readbackHash: canonicalHash(canonicalManufacturingOrderProjection(existing!), 'manufacturing-pick-batch-canary/readback/v2'),
              };
              next.subjects[kind] = { expanded: existing, latest: existing };
            });
            await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
        } else if (checkpoint.mutations[key]!.outcome === 'dispatch-barrier') {
          checkpoint = updateMutationOutcome(checkpoint, key, 'recovered', existing);
          checkpoint = advanceCheckpoint(checkpoint, (next) => {
            next.subjects[kind] = { expanded: existing, latest: existing };
          });
          await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
        } else {
          checkpoint = advanceCheckpoint(checkpoint, (next) => {
            next.subjects[kind] = { expanded: existing, latest: existing };
          });
          await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
        }
          continue;
        }
        if (checkpoint.mutations[key]) {
          checkpoint = advanceCheckpoint(checkpoint, (next) => { next.state = 'failed_uncertain'; });
          await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
          throw new Error(`CANARY_FAILED_UNCERTAIN: ${key}`);
        }
        const result = await executeFencedAppliedMutation({
          stateDir: input.config.stateDir,
          checkpoint,
          client: input.client,
          subject: kind,
          phase: 'create',
          request: subjectPlan.request,
          readback: () => readCanaryManufacturingOrder(input.client, subjectPlan.manufacturingOrderId),
          verify: (readback) => verifyExpandedSubject(kind, input.scenario, readback),
        });
        checkpoint = advanceCheckpoint(result.checkpoint, (next) => {
          next.subjects[kind] = { expanded: result.readback, latest: result.readback };
          next.state = 'create_dispatched_or_recovered';
        });
        await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      }
      checkpoint = advanceCheckpoint(checkpoint, (next) => { next.state = 'expanded_verified'; });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
    }

    const runtimeMaterial = input.runtimeMaterial ?? {};
    if (checkpoint.state === 'expanded_verified') {
      if (!runtimeMaterial.stockMove) {
        return {
          status: 'stage-input-required', checkpoint, stage: 'stock-move',
          message: 'Provide approval-bound component intents and canary-only serials in runtime material.',
          attestationIssued: false,
        };
      }
      const expanded = {
        complete: checkpoint.subjects.complete?.expanded,
        staging: checkpoint.subjects.staging?.expanded,
      };
      if (!expanded.complete || !expanded.staging) throw new Error('CANARY_EXPANDED_CHECKPOINT_INCOMPLETE');
      const scope = stockScope(
        input.scenario,
        runtimeMaterial.stockMove,
        expanded as Record<CanarySubjectKind, ManufacturingOrder>
      );
      const baseline = await readAuthoritativeCanaryInventory(input.client, scope.productIds, scope.watchedSerials);
      const structuralBaselineHash = structuralInventoryHash(
        baseline,
        scope.structuralProductIds
      );
      const plan = buildStockMoveStagePlan({
        scenario: input.scenario,
        expanded: expanded as Record<CanarySubjectKind, ManufacturingOrder>,
        intents: runtimeMaterial.stockMove.intents,
        inventorySummaryProjection: baseline.inventory,
        serialInventoryProjection: baseline.serials,
        inventoryLinesProjection: baseline.inventoryLines,
      });
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.state = 'stock_plan_ready';
        next.stagePlans['stock-move'] = plan;
        next.evidence.stockBaseline = baseline;
        next.evidence.stockScope = scope;
        next.evidence.stockIntents = runtimeMaterial.stockMove!.intents;
        next.evidence.structuralInventory = {
          productIds: scope.structuralProductIds,
          baselineHash: structuralBaselineHash,
        };
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      return approvalRequired(checkpoint, 'stock-move', plan);
    }

    if (checkpoint.state === 'stock_plan_ready' || checkpoint.state === 'stock_dispatched') {
      const plan = checkpoint.stagePlans['stock-move'] as ReturnType<typeof buildStockMoveStagePlan>;
      if (!stageApproval(input.approvals, 'stock-move') && !persistedStageAuthorization(checkpoint, 'stock-move', plan.stagePlanHash)) {
        return approvalRequired(checkpoint, 'stock-move', plan);
      }
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'stock-move', stagePlanHash: plan.stagePlanHash });
      const scope = checkpoint.evidence.stockScope as ManufacturingPickBatchCanaryInventoryScope;
      for (const kind of ['complete', 'staging'] as const) {
        const subjectPlan = plan.subjects[kind];
        if (!checkpoint.mutations[`${kind}:stock-move`]) {
          const currentInventory = await readAuthoritativeCanaryInventory(
            input.client,
            scope.productIds,
            scope.watchedSerials
          );
          const appliedSubjects = (['complete', 'staging'] as const).filter((candidate) => {
            const outcome = checkpoint.mutations[`${candidate}:stock-move`]?.outcome;
            return outcome === 'applied' || outcome === 'recovered';
          });
          if (appliedSubjects.length === 0) {
            if (canonicalHash(currentInventory.inventory, 'manufacturing-pick-batch-canary/inventory-baseline/v2') !== plan.inventoryBaselineHash ||
              canonicalHash(currentInventory.serials, 'manufacturing-pick-batch-canary/serial-baseline/v2') !== plan.serialBaselineHash ||
              canonicalHash(
                currentInventory.inventoryLines,
                'manufacturing-pick-batch-canary/inventory-lines-baseline/v2'
              ) !== plan.inventoryLinesBaselineHash) {
              throw new Error('CANARY_STOCK_BASELINE_DRIFT');
            }
          } else {
            verifyStockMovement({
              scenario: input.scenario,
              material: { intents: checkpoint.evidence.stockIntents as Record<CanarySubjectKind, ManufacturingComponentIntent[]> },
              before: checkpoint.evidence.stockBaseline as { inventory: unknown; serials: unknown },
              after: currentInventory,
              subjects: appliedSubjects,
            });
          }
          const current = await readCanaryManufacturingOrder(input.client, subjectPlan.request.body.manufacturingOrderId!);
          const begin = planManufacturingRunBegin(input.scenario.subjects[kind].beginInput);
          if (captureManufacturingSnapshot(current, begin).snapshotHash !== subjectPlan.snapshotHash ||
            current.timestamp !== subjectPlan.beginTimestamp) {
            throw new Error(`CANARY_STOCK_SOURCE_DRIFT: ${kind}`);
          }
        }
        const result = await executeFencedAppliedMutation({
          stateDir: input.config.stateDir,
          checkpoint,
          client: input.client,
          subject: kind,
          phase: 'stock-move',
          request: subjectPlan.request,
          readback: () => readCanaryManufacturingOrder(input.client, subjectPlan.request.body.manufacturingOrderId!),
          verify: (readback) => { verifyManufacturingPickBatchPostWrite(kind, readback, subjectPlan); },
        });
        checkpoint = advanceCheckpoint(result.checkpoint, (next) => {
          next.subjects[kind] = { ...next.subjects[kind], latest: result.readback };
          next.state = 'stock_dispatched';
        });
        await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      }
      const after = await readAuthoritativeCanaryInventory(input.client, scope.productIds, scope.watchedSerials);
      verifyStockMovement({
        scenario: input.scenario,
        material: { intents: checkpoint.evidence.stockIntents as Record<CanarySubjectKind, ManufacturingComponentIntent[]> },
        before: checkpoint.evidence.stockBaseline as { inventory: unknown; serials: unknown },
        after,
      });
      const structuralStockHash = assertStructuralInventoryUnchanged({
        structuralProductIds: scope.structuralProductIds,
        before: checkpoint.evidence.stockBaseline as { inventory: unknown },
        after,
        phase: 'stock-move',
      });
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.state = 'stock_verified';
        next.evidence.stockAfter = after;
        next.evidence.structuralInventory = {
          ...(next.evidence.structuralInventory as Record<string, unknown> | undefined),
          stockAfterHash: structuralStockHash,
        };
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
    }

    if (checkpoint.state === 'stock_verified' && !checkpoint.stagePlans['negative-probes']) {
      if (!runtimeMaterial.negativeProbes) {
        return {
          status: 'stage-input-required', checkpoint, stage: 'negative-probes',
          message: 'Provide exact canary-only sentinel exclusion evidence and expected rejection codes.',
          attestationIssued: false,
        };
      }
      const complete = checkpoint.subjects.complete?.latest;
      const exclusionSubject = runtimeMaterial.negativeProbes.serialExclusion.subject;
      const exclusionCurrent = checkpoint.subjects[exclusionSubject]?.latest;
      const stockPlan = checkpoint.stagePlans['stock-move'] as ReturnType<typeof buildStockMoveStagePlan>;
      if (!complete || !exclusionCurrent) throw new Error('CANARY_STOCK_READBACK_MISSING');
      const staleRequest = buildStaleRowversionProbeRequest(
        complete,
        stockPlan.subjects.complete.beginTimestamp,
        `stale-${checkpoint.checkpointHash.slice(0, 16)}`
      );
      const exclusionRequest = buildSerialExclusionProbeRequest(
        exclusionCurrent,
        runtimeMaterial.negativeProbes.serialExclusion
      );
      const stockScopeEvidence =
        checkpoint.evidence.stockScope as ManufacturingPickBatchCanaryInventoryScope;
      if (!stockScopeEvidence.productIds.includes(runtimeMaterial.negativeProbes.serialExclusion.productId)) {
        throw new Error('CANARY_SERIAL_EXCLUSION_PRODUCT_OUTSIDE_CANARY_SCOPE');
      }
      const negativeWatched = [
        ...stockScopeEvidence.watchedSerials,
        {
          productId: runtimeMaterial.negativeProbes.serialExclusion.productId,
          serial: runtimeMaterial.negativeProbes.serialExclusion.serial,
        },
      ];
      const negativeScope = {
        productIds: stockScopeEvidence.productIds,
        watchedSerials: [...new Map(negativeWatched.map((identity) => [
          `${identity.productId}\0${identity.serial.normalize('NFKC').trim().toUpperCase()}`,
          identity,
        ])).values()],
        structuralProductIds: stockScopeEvidence.structuralProductIds,
      };
      const negativeInventoryBaseline = await readAuthoritativeCanaryInventory(
        input.client,
        negativeScope.productIds,
        negativeScope.watchedSerials
      );
      const sentinelKey = `${runtimeMaterial.negativeProbes.serialExclusion.productId}\0${runtimeMaterial.negativeProbes.serialExclusion.serial.toUpperCase()}`;
      if ((canonicalHoldingMap(negativeInventoryBaseline.serials).get(sentinelKey) ?? []).length !== 0) {
        throw new Error('CANARY_SERIAL_EXCLUSION_SENTINEL_NOT_EXCLUDED');
      }
      const staleExpectedRejection = parseManufacturingPickBatchExpectedRejectionV2(
        runtimeMaterial.negativeProbes.staleExpectedRejection,
        'runtimeMaterial.negativeProbes.staleExpectedRejection'
      );
      const serialExpectedRejection = parseManufacturingPickBatchExpectedRejectionV2(
        runtimeMaterial.negativeProbes.serialExclusion.expectedRejection,
        'runtimeMaterial.negativeProbes.serialExclusion.expectedRejection'
      );
      if (
        serialExpectedRejection.statusCode !== 400 ||
        (serialExpectedRejection.code !== null &&
          serialExpectedRejection.code !== 'NegativeSerialNumberInventory')
      ) {
        throw new Error(
          'CANARY_SERIAL_CONTENTION_REJECTION_REQUIRED: expected HTTP 400 with a null or NegativeSerialNumberInventory code'
        );
      }
      const winnerSubject: CanarySubjectKind =
        exclusionSubject === 'complete' ? 'staging' : 'complete';
      const stockIntents = runtimeMaterial.stockMove?.intents;
      if (!stockIntents) throw new Error('CANARY_STOCK_INTENTS_MISSING');
      const contentionSerial = runtimeMaterial.negativeProbes.serialExclusion.serial
        .normalize('NFKC').trim().toUpperCase();
      const winnerOwners = (stockIntents[winnerSubject] ?? []).filter(
        (intent) =>
          intent.productId ===
            runtimeMaterial.negativeProbes!.serialExclusion.productId &&
          intent.serialNumbers.some(
            (serial) => serial.normalize('NFKC').trim().toUpperCase() === contentionSerial
          )
      );
      const loserOwners = (stockIntents[exclusionSubject] ?? []).filter(
        (intent) =>
          intent.productId ===
            runtimeMaterial.negativeProbes!.serialExclusion.productId &&
          intent.serialNumbers.some(
            (serial) => serial.normalize('NFKC').trim().toUpperCase() === contentionSerial
          )
      );
      if (winnerOwners.length !== 1 || loserOwners.length !== 0) {
        throw new Error(
          'CANARY_SERIAL_CONTENTION_PAIR_REQUIRED: exactly one opposite MO must have consumed the contested serial and the losing MO must not already contain it'
        );
      }
      const planBase = {
        schemaVersion: 'manufacturing-pick-batch-negative-stage-plan/v2' as const,
        stale: {
          subject: 'complete' as const,
          request: staleRequest,
          requestHash: hashCanaryRequest(staleRequest),
          expectedRejection: staleExpectedRejection,
          preProjectionHash: canonicalHash(canonicalManufacturingOrderProjection(complete), 'manufacturing-pick-batch-canary/no-write/v2'),
          preTimestamp: complete.timestamp,
        },
        serialExclusion: {
          subject: exclusionSubject,
          request: exclusionRequest,
          requestHash: hashCanaryRequest(exclusionRequest),
          expectedRejection: serialExpectedRejection,
          evidence: runtimeMaterial.negativeProbes.serialExclusion,
          preProjectionHash: canonicalHash(canonicalManufacturingOrderProjection(exclusionCurrent), 'manufacturing-pick-batch-canary/no-write/v2'),
          preTimestamp: exclusionCurrent.timestamp,
          inventoryEvidenceHash: canonicalHash(
            negativeInventoryBaseline,
            'manufacturing-pick-batch-canary/serial-exclusion-baseline/v2'
          ),
        },
      };
      const plan = { ...planBase, stagePlanHash: canonicalHash(planBase, 'manufacturing-pick-batch-canary/negative-stage/v2') };
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.stagePlans['negative-probes'] = plan;
        next.evidence.negativeScope = negativeScope;
        next.evidence.negativeInventoryBaseline = negativeInventoryBaseline;
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      return approvalRequired(checkpoint, 'negative-probes', plan);
    }

    if (checkpoint.state === 'stock_verified') {
      const plan = checkpoint.stagePlans['negative-probes'] as any;
      if (!stageApproval(input.approvals, 'negative-probes') && !persistedStageAuthorization(checkpoint, 'negative-probes', plan.stagePlanHash)) {
        return approvalRequired(checkpoint, 'negative-probes', plan);
      }
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'negative-probes', stagePlanHash: plan.stagePlanHash });
      const staleBefore = await readCanaryManufacturingOrder(
        input.client,
        checkpoint.subjects.complete!.latest!.manufacturingOrderId!
      );
      if (canonicalHash(canonicalManufacturingOrderProjection(staleBefore), 'manufacturing-pick-batch-canary/no-write/v2') !==
        plan.stale.preProjectionHash || staleBefore.timestamp !== plan.stale.preTimestamp) {
        throw new Error('CANARY_STALE_PROBE_SOURCE_DRIFT');
      }
      const negativeScope = checkpoint.evidence.negativeScope as {
        productIds: string[];
        watchedSerials: WatchedSerialIdentity[];
        structuralProductIds: string[];
      };
      const staleInventoryBefore = await readAuthoritativeCanaryInventory(
        input.client,
        negativeScope.productIds,
        negativeScope.watchedSerials
      );
      assertManufacturingPickBatchCanaryRestoration(
        checkpoint.evidence.negativeInventoryBaseline,
        staleInventoryBefore
      );
      let result = await executeFencedDefinitiveRejection({
        stateDir: input.config.stateDir,
        checkpoint,
        client: input.client,
        subject: 'complete',
        phase: 'stale-rowversion',
        request: plan.stale.request,
        expected: plan.stale.expectedRejection,
        verifyUnchanged: async () => {
          const after = await readCanaryManufacturingOrder(input.client, staleBefore.manufacturingOrderId!);
          verifyDefinitiveNoWrite(staleBefore, after);
          return after;
        },
      });
      checkpoint = result.checkpoint;
      const staleInventoryAfter = await readAuthoritativeCanaryInventory(
        input.client,
        negativeScope.productIds,
        negativeScope.watchedSerials
      );
      assertManufacturingPickBatchCanaryRestoration(staleInventoryBefore, staleInventoryAfter);
      assertStructuralInventoryUnchanged({
        structuralProductIds: negativeScope.structuralProductIds,
        before: staleInventoryBefore,
        after: staleInventoryAfter,
        phase: 'stale-rowversion',
      });
      const beforeCounts = stableStringify(Object.fromEntries(Object.entries(checkpoint.mutations).map(([key, value]) => [key, value.dispatchCount])));
      const stableCheckpoint = await loadManufacturingPickBatchCanaryCheckpoint(input.config.stateDir, input.scenario.scenarioId);
      for (const kind of ['complete', 'staging'] as const) {
        const before = stableCheckpoint.subjects[kind]!.latest!;
        const after = await readCanaryManufacturingOrder(input.client, before.manufacturingOrderId!);
        verifyDefinitiveNoWrite(before, after);
      }
      assertManufacturingPickBatchCanaryDispatchCounts(stableCheckpoint.mutations);
      const afterCounts = stableStringify(Object.fromEntries(Object.entries(stableCheckpoint.mutations).map(([key, value]) => [key, value.dispatchCount])));
      if (beforeCounts !== afterCounts) throw new Error('CANARY_STABLE_REPLAY_DISPATCH_COUNT_CHANGED');
      const exclusionSubject = plan.serialExclusion.subject as CanarySubjectKind;
      const serialBefore = await readCanaryManufacturingOrder(
        input.client,
        checkpoint.subjects[exclusionSubject]!.latest!.manufacturingOrderId!
      );
      if (canonicalHash(canonicalManufacturingOrderProjection(serialBefore), 'manufacturing-pick-batch-canary/no-write/v2') !==
        plan.serialExclusion.preProjectionHash || serialBefore.timestamp !== plan.serialExclusion.preTimestamp) {
        throw new Error('CANARY_SERIAL_EXCLUSION_SOURCE_DRIFT');
      }
      const scope = negativeScope;
      const inventoryBefore = await readAuthoritativeCanaryInventory(input.client, scope.productIds, scope.watchedSerials);
      if (canonicalHash(inventoryBefore, 'manufacturing-pick-batch-canary/serial-exclusion-baseline/v2') !==
        plan.serialExclusion.inventoryEvidenceHash) {
        throw new Error('CANARY_SERIAL_EXCLUSION_BASELINE_DRIFT');
      }
      result = await executeFencedDefinitiveRejection({
        stateDir: input.config.stateDir,
        checkpoint,
        client: input.client,
        subject: exclusionSubject,
        phase: 'serial-exclusion',
        request: plan.serialExclusion.request,
        expected: plan.serialExclusion.expectedRejection,
        verifyUnchanged: async () => {
          const after = await readCanaryManufacturingOrder(input.client, serialBefore.manufacturingOrderId!);
          verifyDefinitiveNoWrite(serialBefore, after);
          return after;
        },
      });
      checkpoint = result.checkpoint;
      const inventoryAfter = await readAuthoritativeCanaryInventory(input.client, scope.productIds, scope.watchedSerials);
      assertManufacturingPickBatchCanaryRestoration(inventoryBefore, inventoryAfter);
      const structuralNegativeHash = assertStructuralInventoryUnchanged({
        structuralProductIds: scope.structuralProductIds,
        before: inventoryBefore,
        after: inventoryAfter,
        phase: 'serial-exclusion',
      });
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.evidence.structuralInventory = {
          ...(next.evidence.structuralInventory as Record<string, unknown> | undefined),
          negativeAfterHash: structuralNegativeHash,
        };
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      const manualBase = {
        schemaVersion: 'manufacturing-pick-batch-manual-read-plan/v2' as const,
        subject: 'staging' as const,
        manufacturingOrderId: checkpoint.subjects.staging!.latest!.manufacturingOrderId,
        output: input.scenario.subjects.staging.output,
        stockExpectedPostHash: (checkpoint.stagePlans['stock-move'] as ReturnType<typeof buildStockMoveStagePlan>).subjects.staging.expectedPostHash,
      };
      const manualPlan = { ...manualBase, stagePlanHash: canonicalHash(manualBase, 'manufacturing-pick-batch-canary/manual-read/v2') };
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.state = 'waiting_manual_completion';
        next.stagePlans['manual-completion-read'] = manualPlan;
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
    }

    if (checkpoint.state === 'waiting_manual_completion') {
      const plan = checkpoint.stagePlans['manual-completion-read'] as any;
      if (!stageApproval(input.approvals, 'manual-completion-read') &&
        !persistedStageAuthorization(checkpoint, 'manual-completion-read', plan.stagePlanHash)) {
        return {
          status: 'waiting-manual-completion', checkpoint, stage: 'manual-completion-read', stagePlan: plan,
          message: `Complete staging MO ${String(plan.manufacturingOrderId)} manually, then approve this read-only stage.`,
          attestationIssued: false,
        };
      }
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'manual-completion-read', stagePlanHash: plan.stagePlanHash });
      const stagingPlan = (checkpoint.stagePlans['stock-move'] as ReturnType<typeof buildStockMoveStagePlan>).subjects.staging;
      const staging = await readCanaryManufacturingOrder(input.client, plan.manufacturingOrderId);
      verifyManualCompletionRead(staging, stagingPlan, input.scenario.subjects.staging.output);
      const complete = await readCanaryManufacturingOrder(input.client, checkpoint.subjects.complete!.latest!.manufacturingOrderId!);
      const cleanupSubjects = {
        complete: planManufacturingPickBatchCanaryCleanup('complete', complete, checkpoint.subjects.complete!.expanded!),
        staging: planManufacturingPickBatchCanaryCleanup('staging', staging, checkpoint.subjects.staging!.expanded!),
      };
      const cleanupBase = {
        schemaVersion: 'manufacturing-pick-batch-cleanup-stage-plan/v2' as const,
        subjects: cleanupSubjects,
        baselineRestorationHash: canonicalHash(checkpoint.evidence.stockBaseline, 'manufacturing-pick-batch-canary/restoration/v2'),
      };
      const cleanupPlan = { ...cleanupBase, stagePlanHash: canonicalHash(cleanupBase, 'manufacturing-pick-batch-canary/cleanup-stage/v2') };
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.state = 'cleanup_plan_ready';
        next.subjects.staging = { ...next.subjects.staging, latest: staging };
        next.subjects.complete = { ...next.subjects.complete, latest: complete };
        next.stagePlans.cleanup = cleanupPlan;
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      return approvalRequired(checkpoint, 'cleanup', cleanupPlan);
    }

    if (checkpoint.state === 'cleanup_plan_ready' || checkpoint.state === 'cleanup_dispatched') {
      const cleanupPlan = checkpoint.stagePlans.cleanup as any;
      if (!stageApproval(input.approvals, 'cleanup') && !persistedStageAuthorization(checkpoint, 'cleanup', cleanupPlan.stagePlanHash)) {
        return approvalRequired(checkpoint, 'cleanup', cleanupPlan);
      }
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'cleanup', stagePlanHash: cleanupPlan.stagePlanHash });
      for (const kind of ['complete', 'staging'] as const) {
        const subjectPlan = cleanupPlan.subjects[kind] as ReturnType<typeof planManufacturingPickBatchCanaryCleanup>;
        if (!checkpoint.mutations[`${kind}:cleanup`]) {
          const current = await readCanaryManufacturingOrder(input.client, subjectPlan.request.body.manufacturingOrderId!);
          const sourceProjectionHash = canonicalHash(
            canonicalManufacturingOrderProjection(current),
            'manufacturing-pick-batch-canary/cleanup-source/v2'
          );
          if (current.timestamp !== subjectPlan.sourceTimestamp || sourceProjectionHash !== subjectPlan.sourceProjectionHash) {
            throw new Error(`CANARY_CLEANUP_SOURCE_DRIFT: ${kind}`);
          }
        }
        const result = await executeFencedAppliedMutation({
          stateDir: input.config.stateDir,
          checkpoint,
          client: input.client,
          subject: kind,
          phase: 'cleanup',
          request: subjectPlan.request,
          readback: () => readCanaryManufacturingOrder(input.client, subjectPlan.request.body.manufacturingOrderId!),
          verify: (readback) => {
            const hash = canonicalHash(canonicalManufacturingOrderProjection(readback), 'manufacturing-pick-batch-canary/inert-mo/v2');
            if (hash !== subjectPlan.expectedInertProjectionHash || !rowversionAdvanced(subjectPlan.sourceTimestamp, readback.timestamp)) {
              throw new Error(`CANARY_CLEANUP_READBACK_MISMATCH: ${kind}`);
            }
          },
        });
        checkpoint = advanceCheckpoint(result.checkpoint, (next) => {
          next.state = 'cleanup_dispatched';
          next.subjects[kind] = { ...next.subjects[kind], latest: result.readback };
        });
        await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      }
      const scope =
        checkpoint.evidence.stockScope as ManufacturingPickBatchCanaryInventoryScope;
      const afterCleanup = await readAuthoritativeCanaryInventory(input.client, scope.productIds, scope.watchedSerials);
      const restorationHash = assertManufacturingPickBatchCanaryRestoration(checkpoint.evidence.stockBaseline, afterCleanup);
      const structuralCleanupHash = assertStructuralInventoryUnchanged({
        structuralProductIds: scope.structuralProductIds,
        before: checkpoint.evidence.stockBaseline as { inventory: unknown },
        after: afterCleanup,
        phase: 'cleanup',
      });
      const residuals = await discoverManufacturingPickBatchResiduals({
        client: input.client,
        subjects: {
          complete: {
            manufacturingOrderId: cleanupPlan.subjects.complete.request.body.manufacturingOrderId!,
            expectedInertProjectionHash: cleanupPlan.subjects.complete.expectedInertProjectionHash,
            coordinatorMarker: planManufacturingRunBegin(input.scenario.subjects.complete.beginInput).coordinatorMarker,
            finishedProductId: input.scenario.subjects.complete.beginInput.identity.finishedProductId,
          },
          staging: {
            manufacturingOrderId: cleanupPlan.subjects.staging.request.body.manufacturingOrderId!,
            expectedInertProjectionHash: cleanupPlan.subjects.staging.expectedInertProjectionHash,
            coordinatorMarker: planManufacturingRunBegin(input.scenario.subjects.staging.beginInput).coordinatorMarker,
            finishedProductId: input.scenario.subjects.staging.beginInput.identity.finishedProductId,
          },
        },
        approvedInertArtifactIds: input.scenario.approvedInertArtifactIds,
        inventoryScope: {
          productIds: scope.productIds,
          watchedSerials: scope.watchedSerials,
          expected: afterCleanup,
        },
      });
      if (residuals.possibleResidualIds.length > 0) {
        throw new Error(`CANARY_RESIDUAL_DISCOVERY_FAILED: ${residuals.possibleResidualIds.join(',')}`);
      }
      const attestBase = {
        schemaVersion: 'manufacturing-pick-batch-attest-stage-plan/v2' as const,
        restorationHash,
        confirmedResidualIds: residuals.confirmedResidualIds,
        possibleResidualIds: residuals.possibleResidualIds,
        subjects: {
          complete: {
            manufacturingOrderId: cleanupPlan.subjects.complete.request.body.manufacturingOrderId!,
            expectedInertProjectionHash: cleanupPlan.subjects.complete.expectedInertProjectionHash,
            coordinatorMarker: planManufacturingRunBegin(input.scenario.subjects.complete.beginInput).coordinatorMarker,
            finishedProductId: input.scenario.subjects.complete.beginInput.identity.finishedProductId,
          },
          staging: {
            manufacturingOrderId: cleanupPlan.subjects.staging.request.body.manufacturingOrderId!,
            expectedInertProjectionHash: cleanupPlan.subjects.staging.expectedInertProjectionHash,
            coordinatorMarker: planManufacturingRunBegin(input.scenario.subjects.staging.beginInput).coordinatorMarker,
            finishedProductId: input.scenario.subjects.staging.beginInput.identity.finishedProductId,
          },
        },
        inventoryScope: scope,
        dispatchCounts: Object.fromEntries(Object.entries(checkpoint.mutations).map(([key, value]) => [key, value.dispatchCount])),
      };
      const attestPlan = { ...attestBase, stagePlanHash: canonicalHash(attestBase, 'manufacturing-pick-batch-canary/attest-stage/v2') };
      checkpoint = advanceCheckpoint(checkpoint, (next) => {
        next.state = 'restored_verified';
        next.evidence.afterCleanup = afterCleanup;
        next.evidence.residuals = residuals;
        next.evidence.structuralInventory = {
          ...(next.evidence.structuralInventory as Record<string, unknown> | undefined),
          cleanupHash: structuralCleanupHash,
        };
        next.stagePlans.attest = attestPlan;
      });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      return approvalRequired(checkpoint, 'attest', attestPlan);
    }

    if (checkpoint.state === 'restored_verified') {
      const attestPlan = checkpoint.stagePlans.attest as any;
      if (!stageApproval(input.approvals, 'attest') && !persistedStageAuthorization(checkpoint, 'attest', attestPlan.stagePlanHash)) {
        return approvalRequired(checkpoint, 'attest', attestPlan);
      }
      const attestationSafetyTelemetry = input.client.telemetrySnapshot();
      checkpoint = await authorizeStage({ ...input, checkpoint, stage: 'attest', stagePlanHash: attestPlan.stagePlanHash });
      assertManufacturingPickBatchCanaryDispatchCounts(checkpoint.mutations);
      const currentDispatchCounts = Object.fromEntries(
        Object.entries(checkpoint.mutations).map(([key, value]) => [key, value.dispatchCount])
      );
      if (stableStringify(currentDispatchCounts) !== stableStringify(attestPlan.dispatchCounts)) {
        throw new Error('CANARY_ATTEST_DISPATCH_COUNT_DRIFT');
      }
      const freshInventory = await readAuthoritativeCanaryInventory(
        input.client,
        attestPlan.inventoryScope.productIds,
        attestPlan.inventoryScope.watchedSerials
      );
      const freshRestorationHash = assertManufacturingPickBatchCanaryRestoration(
        checkpoint.evidence.stockBaseline,
        freshInventory
      );
      if (freshRestorationHash !== attestPlan.restorationHash) {
        throw new Error('CANARY_ATTEST_RESTORATION_HASH_DRIFT');
      }
      const structuralAttestHash = assertStructuralInventoryUnchanged({
        structuralProductIds: attestPlan.inventoryScope.structuralProductIds ?? [],
        before: checkpoint.evidence.stockBaseline as { inventory: unknown },
        after: freshInventory,
        phase: 'attest',
      });
      const residuals = await discoverManufacturingPickBatchResiduals({
        client: input.client,
        subjects: attestPlan.subjects,
        approvedInertArtifactIds: input.scenario.approvedInertArtifactIds,
        inventoryScope: {
          productIds: attestPlan.inventoryScope.productIds,
          watchedSerials: attestPlan.inventoryScope.watchedSerials,
          expected: checkpoint.evidence.stockBaseline as { inventory: unknown; serials: unknown },
        },
      });
      if (stableStringify(residuals.confirmedResidualIds) !==
          stableStringify(attestPlan.confirmedResidualIds) ||
        stableStringify(residuals.possibleResidualIds) !==
          stableStringify(attestPlan.possibleResidualIds)) {
        throw new Error('CANARY_ATTEST_RESIDUAL_DRIFT');
      }
      const observations = Object.fromEntries(
        MANUFACTURING_PICK_BATCH_REQUIRED_OBSERVATIONS.map((observation) => [observation, true])
      ) as Record<ManufacturingPickBatchObservation, boolean>;
      const evidence: ManufacturingPickBatchCanaryEvidence = {
        observations,
        optimisticConcurrency: 'enforced',
        cleanupVerified: true,
        confirmedResidualIds: residuals.confirmedResidualIds,
        possibleResidualIds: residuals.possibleResidualIds,
        approvedInertArtifactIds: [...input.scenario.approvedInertArtifactIds],
        beforeSnapshot: {
          schemaVersion: 'manufacturing-pick-batch-canary-attestation-evidence/v2',
          scenarioManifestHash: checkpoint.scenarioManifestHash,
          checkpointChainHead: checkpoint.checkpointHash,
          subjects: {
            complete: checkpoint.subjects.complete?.expanded?.manufacturingOrderId,
            staging: checkpoint.subjects.staging?.expanded?.manufacturingOrderId,
          },
          stagePlanHashes: Object.fromEntries(Object.entries(checkpoint.stagePlans).map(
            ([stage, value]) => [stage, (value as { stagePlanHash?: string })?.stagePlanHash ?? null]
          )),
          mutations: checkpoint.mutations,
          serialContentionExpectedRejection: (
            checkpoint.stagePlans['negative-probes'] as {
              serialExclusion: {
                expectedRejection: ManufacturingPickBatchCanaryExpectedRejectionV2;
              };
            }
          ).serialExclusion.expectedRejection,
          stockBaseline: checkpoint.evidence.stockBaseline,
          structuralInventory: checkpoint.evidence.structuralInventory,
        },
        afterCleanupSnapshot: {
          checkpointChainHead: checkpoint.checkpointHash,
          stockAndSerialState: freshInventory,
          restorationHash: attestPlan.restorationHash,
          residuals,
          structuralInventory: {
            productIds: attestPlan.inventoryScope.structuralProductIds ?? [],
            attestHash: structuralAttestHash,
          },
        },
      };
      const finalApproval = stageApproval(input.approvals, 'attest') ??
        ((checkpoint.evidence.stageAuthorizations as any)?.attest?.approval as
          | ManufacturingPickBatchCanaryStageApproval
          | undefined);
      if (!finalApproval) throw new Error('CANARY_ATTEST_APPROVAL_MATERIAL_REQUIRED_ON_ISSUANCE');
      await issueManufacturingPickBatchCanaryAttestation(
        input.config,
        {
          ...finalApproval,
          schemaVersion: 'manufacturing-pick-batch-canary-approval/v1',
          approved: true,
        },
        attestationSafetyTelemetry,
        evidence,
        checkpoint.scenarioManifestHash
      );
      checkpoint = advanceCheckpoint(checkpoint, (next) => { next.state = 'attested'; });
      await recordCanaryCheckpoint(input.config.stateDir, checkpoint);
      return { status: 'attested', checkpoint, attestationIssued: true };
    }

    throw new Error(`CANARY_STATE_NOT_EXECUTABLE: ${checkpoint.state}`);
  });
}

export async function runManufacturingPickBatchCanaryCliFromEnvironment(
  environment: Record<string, string | undefined>,
  dependencies: {
    loadConfig?: () => InflowConfig;
    createClient?: (config: InflowConfig) => V2CanaryClient;
  } = {}
): Promise<ManufacturingPickBatchCanaryStateMachineResult> {
  const config = (dependencies.loadConfig ?? loadConfig)();
  const scenario = parseManufacturingPickBatchCanaryScenarioV2(
    environment.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_SCENARIO_JSON
  );
  const approvals = parseManufacturingPickBatchCanaryStageApprovals(
    environment.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_APPROVALS_JSON
  );
  const runtimeMaterial = parseManufacturingPickBatchCanaryRuntimeMaterialV2(
    environment.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_RUNTIME_MATERIAL_JSON
  );
  const client = (dependencies.createClient ?? ((value) => new InflowClient(value)))(config);
  return runManufacturingPickBatchCanaryStateMachine({
    config,
    client,
    scenario,
    approvals,
    runtimeMaterial,
  });
}

async function main(): Promise<void> {
  const result = await runManufacturingPickBatchCanaryCliFromEnvironment(process.env);
  process.stdout.write(
    `${JSON.stringify({
      status: result.status,
      checkpointState: result.checkpoint.state,
      checkpointHash: result.checkpoint.checkpointHash,
      stage: result.stage,
      stagePlan: result.stagePlan,
      message: result.message,
      attestationIssued: result.attestationIssued,
    }, null, 2)}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
