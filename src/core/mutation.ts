import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalHash,
  semanticDiff,
  stableStringify,
  type SemanticDiff,
} from './canonical-json.js';
import {
  MutationJournal,
  type MutationJournalRecord,
  type JournalState,
} from './mutation-journal.js';
import {
  PreviewTokenService,
  type PreviewTokenPayload,
} from './preview-token.js';

export const MUTATION_CONTRACT_VERSION = 'mutation/v1';
export const SERIALIZER_VERSION = 'canonical/v1';
export const EXPLICIT_CONFIRMATION_SCOPE_VERSION = 'explicit-confirmation-scope/v1';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const confirmationSourceHashSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  hash: sha256Schema,
}).strict();

export const explicitMutationConfirmationScopeSchema = z.object({
  schemaVersion: z.literal(EXPLICIT_CONFIRMATION_SCOPE_VERSION),
  tenantFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  baseHost: z.string().min(1),
  apiVersion: z.string().min(1),
  serverBuildIdentity: sha256Schema,
  operation: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1).nullable(),
  mode: z.string(),
  adapterVersion: z.string().min(1),
  serializerVersion: z.string().min(1),
  contractVersion: z.string().min(1),
  currentSemanticHash: sha256Schema.nullable(),
  currentWriteShapeHash: sha256Schema.nullable(),
  entityTimestamp: z.string().min(1).nullable(),
  sourceHashes: z.array(confirmationSourceHashSchema).superRefine((entries, context) => {
    const names = entries.map((entry) => entry.name);
    const sorted = [...names].sort();
    if (stableStringify(names) !== stableStringify(sorted) || new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceHashes must use unique names in lexical order',
      });
    }
  }),
  desiredHash: sha256Schema,
}).strict();

export type ExplicitMutationConfirmationScope = z.infer<
  typeof explicitMutationConfirmationScopeSchema
>;

export const explicitMutationConfirmationSchema = z.object({
  scope: explicitMutationConfirmationScopeSchema,
  confirmationHash: sha256Schema,
}).strict();

export type ExplicitMutationConfirmation = z.infer<
  typeof explicitMutationConfirmationSchema
>;

export function confirmationHashForScope(
  scope: ExplicitMutationConfirmationScope
): string {
  return canonicalHash(scope, EXPLICIT_CONFIRMATION_SCOPE_VERSION);
}

export type ApplicationState =
  | 'preview'
  | 'no_op'
  | 'not_applied'
  | 'conflict'
  | 'blocked'
  | 'applied_verified'
  | 'applied_unverified'
  | 'unknown_after_write'
  | 'partial_applied';

export interface MutationControl {
  dryRun?: boolean;
  previewToken?: string;
  idempotencyKey?: string;
  expectedSemanticHash?: string;
  expectedWriteShapeHash?: string;
  expectedEntityTimestamp?: string;
  expectedDesiredHash?: string;
  confirmation?: ExplicitMutationConfirmation;
}

export interface MutationResult<T> {
  schemaVersion: typeof MUTATION_CONTRACT_VERSION;
  operationId: string;
  resultCode?: string;
  idempotencyKey?: string;
  resourceType: string;
  resourceId?: string;
  previewToken?: string;
  applicationState: ApplicationState;
  applied: boolean | 'unknown';
  appliedMayBeTrue: boolean;
  partialApplied: boolean;
  verified: boolean;
  cacheInvalidationRequired: boolean;
  currentSemanticHash?: string;
  currentWriteShapeHash?: string;
  desiredHash: string;
  entityTimestamp?: string;
  sourceHashes?: Record<string, string>;
  confirmationScope?: ExplicitMutationConfirmationScope;
  confirmationHash?: string;
  confirmationValidated?: boolean;
  before?: T;
  desired?: T;
  actual?: T;
  diff: SemanticDiff;
  completedSteps?: string[];
  failedStep?: string;
  residualIds?: string[];
  possibleResidualIds?: string[];
  affectedResources: Array<{ type: string; id?: string }>;
  invalidationTags: string[];
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface MutationRuntime {
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  serverBuildIdentity: string;
  tokenService: PreviewTokenService;
  journal: MutationJournal;
  previewTtlMs?: number;
}

export interface MutationAdapter<TInput, TCurrent, TDesired, TOutput> {
  operation: string;
  resourceType: string;
  resourceId(input: TInput): string | undefined;
  mode(input: TInput): string;
  adapterVersion: string;
  isCreate?(input: TInput, current: TCurrent | undefined): boolean;
  isSaga?: boolean;
  read(input: TInput): Promise<TCurrent | undefined>;
  planIds?(input: TInput, operationId: string, current: TCurrent | undefined): Record<string, string[]>;
  buildDesired(
    input: TInput,
    current: TCurrent | undefined,
    plannedIds: Record<string, string[]>
  ): Promise<TDesired> | TDesired;
  semantic(value: TCurrent | TDesired): unknown;
  writeShape(current: TCurrent | undefined): unknown;
  timestamp(current: TCurrent | undefined): string | undefined;
  sourceHashes?(input: TInput, current: TCurrent | undefined): Record<string, string>;
  output(value: TCurrent | TDesired): TOutput;
  validate?(input: TInput, current: TCurrent | undefined, desired: TDesired): Promise<void> | void;
  validateBeforeDispatch?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired
  ): Promise<void> | void;
  /** Re-evaluated after token/stale checks and again immediately before dispatch. */
  authorizeApply?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired
  ): Promise<void> | void;
  /**
   * Defaults to create-or-saga. Set true for additive, stock-affecting, or
   * other multi-step mutations; deterministic full replacements may use false.
   */
  requiresIdempotency?:
    | boolean
    | ((input: TInput, current: TCurrent | undefined) => boolean);
  /** Custom no-op semantics, notably repeated exact-target deletes. */
  isNoOp?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired
  ): boolean;
  noOpResultCode?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired
  ): string | undefined;
  /** Custom conclusive readback, including verified absence after deletes. */
  verifyReadback?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired,
    actual: TCurrent | undefined
  ): Promise<boolean> | boolean;
  prepareDispatch?(
    input: TInput,
    current: TCurrent | undefined,
    desired: TDesired
  ): Promise<() => Promise<unknown>>;
  dispatch(input: TInput, current: TCurrent | undefined, desired: TDesired): Promise<unknown>;
  affectedResources(input: TInput, desired: TDesired): Array<{ type: string; id?: string }>;
  invalidationTags(input: TInput, desired: TDesired): string[];
  lockResourceIds?(input: TInput): string[];
  writesEnabled: boolean;
  disabledCode?: string;
  disabledMessage?: string;
  requireTimestamp?: boolean;
  requiresExplicitConfirmation?: boolean;
}

const STATE_FLAGS: Record<ApplicationState, {
  applied: boolean | 'unknown';
  appliedMayBeTrue: boolean;
  partialApplied: boolean;
  verified: boolean;
  cacheInvalidationRequired: boolean;
}> = {
  preview: { applied: false, appliedMayBeTrue: false, partialApplied: false, verified: false, cacheInvalidationRequired: false },
  no_op: { applied: false, appliedMayBeTrue: false, partialApplied: false, verified: true, cacheInvalidationRequired: false },
  not_applied: { applied: false, appliedMayBeTrue: false, partialApplied: false, verified: false, cacheInvalidationRequired: false },
  conflict: { applied: false, appliedMayBeTrue: false, partialApplied: false, verified: false, cacheInvalidationRequired: false },
  blocked: { applied: false, appliedMayBeTrue: false, partialApplied: false, verified: false, cacheInvalidationRequired: false },
  applied_verified: { applied: true, appliedMayBeTrue: true, partialApplied: false, verified: true, cacheInvalidationRequired: true },
  applied_unverified: { applied: true, appliedMayBeTrue: true, partialApplied: false, verified: false, cacheInvalidationRequired: true },
  unknown_after_write: { applied: 'unknown', appliedMayBeTrue: true, partialApplied: false, verified: false, cacheInvalidationRequired: true },
  partial_applied: { applied: true, appliedMayBeTrue: true, partialApplied: true, verified: false, cacheInvalidationRequired: true },
};

export function stateFlags(state: ApplicationState) {
  return STATE_FLAGS[state];
}

function keyHash(tenant: string, resourceType: string, key: string): string {
  return createHash('sha256').update(`${tenant}\0${resourceType}\0${key}`).digest('hex');
}

function errorInfo(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? 'MUTATION_ERROR';
  return { code, message, retryable: false };
}

function journalState(state: ApplicationState): JournalState {
  return state === 'blocked' ? 'not_applied' : state;
}

function replayApplicationState(state: JournalState): ApplicationState {
  if (state === 'prepared') return 'not_applied';
  if (state === 'dispatched') return 'unknown_after_write';
  return state;
}

function makeResult<T>(
  state: ApplicationState,
  base: Omit<MutationResult<T>, keyof ReturnType<typeof stateFlags> | 'applicationState'>
): MutationResult<T> {
  return { ...base, applicationState: state, ...stateFlags(state) };
}

function buildConfirmationScope<TInput extends MutationControl, TCurrent, TDesired, TOutput>(
  runtime: MutationRuntime,
  adapter: MutationAdapter<TInput, TCurrent, TDesired, TOutput>,
  input: TInput,
  values: {
    resourceId: string | undefined;
    currentSemanticHash: string | undefined;
    currentWriteShapeHash: string | undefined;
    entityTimestamp: string | undefined;
    sourceHashes: Record<string, string> | undefined;
    desiredHash: string;
  }
): ExplicitMutationConfirmationScope {
  return explicitMutationConfirmationScopeSchema.parse({
    schemaVersion: EXPLICIT_CONFIRMATION_SCOPE_VERSION,
    tenantFingerprint: runtime.tenantFingerprint,
    baseHost: runtime.baseHost,
    apiVersion: runtime.apiVersion,
    serverBuildIdentity: runtime.serverBuildIdentity,
    operation: adapter.operation,
    resourceType: adapter.resourceType,
    resourceId: values.resourceId ?? null,
    mode: adapter.mode(input),
    adapterVersion: adapter.adapterVersion,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    currentSemanticHash: values.currentSemanticHash ?? null,
    currentWriteShapeHash: values.currentWriteShapeHash ?? null,
    entityTimestamp: values.entityTimestamp ?? null,
    sourceHashes: Object.entries(values.sourceHashes ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, hash]) => ({ name, hash })),
    desiredHash: values.desiredHash,
  });
}

function validateExplicitConfirmation(
  supplied: ExplicitMutationConfirmation | undefined,
  expectedScope: ExplicitMutationConfirmationScope,
  expectedHash: string
): void {
  if (!supplied) {
    throw new Error('USER_CONFIRMATION_REQUIRED: supply the exact full preview confirmation');
  }
  const parsed = explicitMutationConfirmationSchema.safeParse(supplied);
  if (!parsed.success) {
    throw new Error('USER_CONFIRMATION_SCOPE_MISMATCH: malformed confirmation payload');
  }
  if (
    parsed.data.confirmationHash !== expectedHash ||
    parsed.data.confirmationHash !== confirmationHashForScope(parsed.data.scope) ||
    stableStringify(parsed.data.scope) !== stableStringify(expectedScope)
  ) {
    throw new Error('USER_CONFIRMATION_SCOPE_MISMATCH: confirmation does not match the fresh preview scope');
  }
}

export async function executeMutation<TInput extends MutationControl, TCurrent, TDesired, TOutput>(
  runtime: MutationRuntime,
  adapter: MutationAdapter<TInput, TCurrent, TDesired, TOutput>,
  input: TInput
): Promise<MutationResult<TOutput>> {
  if (input.dryRun ?? true) return executeMutationUnlocked(runtime, adapter, input);
  const resourceKey = adapter.resourceId(input) ?? input.idempotencyKey ?? adapter.mode(input);
  const lockNames = Array.from(new Set([
    resourceKey,
    ...(adapter.lockResourceIds?.(input) ?? []),
  ])).map((key) => {
    const lockKey = createHash('sha256')
      .update(`${runtime.tenantFingerprint}\0${adapter.resourceType}\0${key}`)
      .digest('hex');
    return `resource-${lockKey}`;
  }).sort();
  const withLocks = (index: number): Promise<MutationResult<TOutput>> => {
    if (index >= lockNames.length) return executeMutationUnlocked(runtime, adapter, input);
    return runtime.journal.withLock(lockNames[index]!, () => withLocks(index + 1));
  };
  return withLocks(0);
}

async function executeMutationUnlocked<TInput extends MutationControl, TCurrent, TDesired, TOutput>(
  runtime: MutationRuntime,
  adapter: MutationAdapter<TInput, TCurrent, TDesired, TOutput>,
  input: TInput
): Promise<MutationResult<TOutput>> {
  const dryRun = input.dryRun ?? true;
  if (!dryRun && !input.previewToken) {
    throw new Error('PREVIEW_TOKEN_REQUIRED: run preview first');
  }
  const current = await adapter.read(input);
  const create = adapter.isCreate?.(input, current) ?? current === undefined;
  const idempotencyRequired = typeof adapter.requiresIdempotency === 'function'
    ? adapter.requiresIdempotency(input, current)
    : adapter.requiresIdempotency ?? (create || adapter.isSaga === true);
  const preliminarilyApproved = input.previewToken
    ? runtime.tokenService.verify(input.previewToken, {
        tenantFingerprint: runtime.tenantFingerprint,
        baseHost: runtime.baseHost,
        operation: adapter.operation,
        apiVersion: runtime.apiVersion,
        resourceType: adapter.resourceType,
        resourceId: adapter.resourceId(input),
        adapterVersion: adapter.adapterVersion,
        serializerVersion: SERIALIZER_VERSION,
        contractVersion: MUTATION_CONTRACT_VERSION,
      })
    : undefined;
  let idempotencyKey = input.idempotencyKey;
  if (!dryRun && preliminarilyApproved?.idempotencyKeyHash && !idempotencyKey) {
    throw new Error('MUTATION_PRECONDITION_REQUIRED: missing idempotency key');
  }
  if (dryRun && idempotencyRequired && !idempotencyKey) idempotencyKey = randomUUID();
  if (!dryRun && idempotencyRequired && !idempotencyKey) {
    throw new Error('MUTATION_PRECONDITION_REQUIRED: missing idempotency key');
  }

  const idempotencyHash = idempotencyKey
    ? keyHash(runtime.tenantFingerprint, adapter.resourceType, idempotencyKey)
    : undefined;
  if (preliminarilyApproved && preliminarilyApproved.idempotencyKeyHash !== idempotencyHash) {
    throw new Error('PREVIEW_TOKEN_SCOPE_MISMATCH: idempotency key');
  }
  const existingMapping = idempotencyHash
    ? await runtime.journal.getIdempotency(idempotencyHash)
    : undefined;
  const operationId = existingMapping?.operationId ?? preliminarilyApproved?.operationId ?? randomUUID();
  const plannedIds = existingMapping?.plannedIds ?? preliminarilyApproved?.plannedIds ?? adapter.planIds?.(input, operationId, current) ?? {};
  const desired = await adapter.buildDesired(input, current, plannedIds);
  await adapter.validate?.(input, current, desired);

  const semanticDomain = `semantic/${adapter.resourceType}/${adapter.adapterVersion}`;
  const writeDomain = `write-shape/${adapter.resourceType}/${adapter.adapterVersion}`;
  const currentSemanticHash = current === undefined
    ? undefined
    : canonicalHash(adapter.semantic(current), semanticDomain);
  const currentWriteShapeHash = current === undefined
    ? undefined
    : canonicalHash(adapter.writeShape(current), writeDomain);
  const desiredHash = canonicalHash(adapter.semantic(desired), semanticDomain);
  if (existingMapping?.desiredHash !== undefined && existingMapping.desiredHash !== desiredHash) {
    throw new Error('IDEMPOTENCY_KEY_CONFLICT: key already binds a different desired state');
  }

  const resourceId = adapter.resourceId(input) ?? Object.values(plannedIds)[0]?.[0];
  const affectedResources = adapter.affectedResources(input, desired);
  const invalidationTags = adapter.invalidationTags(input, desired);
  const beforeOutput = current === undefined ? undefined : adapter.output(current);
  const desiredOutput = adapter.output(desired);
  const diff = semanticDiff(
    current === undefined ? null : adapter.semantic(current),
    adapter.semantic(desired)
  );
  const entityTimestamp = adapter.timestamp(current);
  const sourceHashes = adapter.sourceHashes?.(input, current);
  const confirmationScope = adapter.requiresExplicitConfirmation
    ? buildConfirmationScope(runtime, adapter, input, {
        resourceId,
        currentSemanticHash,
        currentWriteShapeHash,
        entityTimestamp,
        sourceHashes,
        desiredHash,
      })
    : undefined;
  const confirmationHash = confirmationScope
    ? confirmationHashForScope(confirmationScope)
    : undefined;
  const issuedAt = new Date();
  const tokenPayload: PreviewTokenPayload = {
    schemaVersion: 'preview-token/v1',
    operationId,
    operation: adapter.operation,
    idempotencyKeyHash: idempotencyHash,
    tenantFingerprint: runtime.tenantFingerprint,
    baseHost: runtime.baseHost,
    apiVersion: runtime.apiVersion,
    resourceType: adapter.resourceType,
    resourceId,
    mode: adapter.mode(input),
    currentSemanticHash,
    currentWriteShapeHash,
    entityTimestamp,
    sourceHashes,
    desiredHash,
    plannedIds,
    adapterVersion: adapter.adapterVersion,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (runtime.previewTtlMs ?? 15 * 60_000)).toISOString(),
  };
  const previewToken = runtime.tokenService.issue(tokenPayload);
  const common = {
    schemaVersion: MUTATION_CONTRACT_VERSION as typeof MUTATION_CONTRACT_VERSION,
    operationId,
    idempotencyKey,
    resourceType: adapter.resourceType,
    resourceId,
    currentSemanticHash,
    currentWriteShapeHash,
    desiredHash,
    entityTimestamp,
    sourceHashes,
    confirmationScope,
    confirmationHash,
    before: beforeOutput,
    desired: desiredOutput,
    diff,
    affectedResources,
    invalidationTags,
    warnings: [] as string[],
  };

  const noOp = adapter.isNoOp?.(input, current, desired) ??
    (currentSemanticHash !== undefined && currentSemanticHash === desiredHash);
  if (dryRun) {
    return makeResult('preview', { ...common, previewToken });
  }
  const approved = runtime.tokenService.verify(input.previewToken!, {
    tenantFingerprint: runtime.tenantFingerprint,
    baseHost: runtime.baseHost,
    operation: adapter.operation,
    apiVersion: runtime.apiVersion,
    resourceType: adapter.resourceType,
    resourceId,
    adapterVersion: adapter.adapterVersion,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
  });
  const echoChecks: Array<[string, string | undefined, string | undefined, boolean]> = [
    ['semantic hash', input.expectedSemanticHash, approved.currentSemanticHash, approved.currentSemanticHash !== undefined],
    ['write-shape hash', input.expectedWriteShapeHash, approved.currentWriteShapeHash, approved.currentWriteShapeHash !== undefined],
    ['timestamp', input.expectedEntityTimestamp, approved.entityTimestamp, (adapter.requireTimestamp ?? true) && approved.entityTimestamp !== undefined],
    ['desired hash', input.expectedDesiredHash, approved.desiredHash, true],
  ];
  for (const [name, expected, tokenValue, required] of echoChecks) {
    if (required && !expected) throw new Error(`MUTATION_PRECONDITION_REQUIRED: missing ${name}`);
    if (expected !== undefined && expected !== tokenValue) {
      throw new Error(`MUTATION_CONFLICT: ${name} does not match preview`);
    }
  }
  if (
    approved.operationId !== operationId ||
    approved.mode !== adapter.mode(input) ||
    approved.desiredHash !== desiredHash ||
    approved.idempotencyKeyHash !== idempotencyHash ||
    stableStringify(approved.plannedIds ?? {}) !== stableStringify(plannedIds) ||
    stableStringify(approved.sourceHashes ?? {}) !== stableStringify(sourceHashes ?? {})
  ) {
    throw new Error('PREVIEW_TOKEN_SCOPE_MISMATCH: preview and apply inputs differ');
  }
  const priorRecord = await runtime.journal.get(operationId);
  if (
    priorRecord &&
    (
      priorRecord.desiredHash !== desiredHash ||
      priorRecord.resourceType !== adapter.resourceType ||
      priorRecord.adapterVersion !== adapter.adapterVersion ||
      priorRecord.resourceId !== resourceId
    )
  ) {
    throw new Error('IDEMPOTENCY_KEY_CONFLICT: prior operation journal scope differs');
  }
  if (adapter.requiresExplicitConfirmation) {
    if (priorRecord && !priorRecord.confirmation) {
      throw new Error('IDEMPOTENCY_KEY_CONFLICT: prior operation lacks required confirmation');
    }
    validateExplicitConfirmation(
      input.confirmation,
      priorRecord?.confirmation?.scope ?? confirmationScope!,
      priorRecord?.confirmation?.hash ?? confirmationHash!
    );
  }
  const confirmedCommon = adapter.requiresExplicitConfirmation
    ? {
        ...common,
        confirmationScope: priorRecord?.confirmation?.scope ?? confirmationScope,
        confirmationHash: priorRecord?.confirmation?.hash ?? confirmationHash,
        confirmationValidated: true,
      }
    : common;
  if (priorRecord && priorRecord.state !== 'prepared') {
    const reconcilable = [
      'dispatched',
      'unknown_after_write',
      'applied_unverified',
      'partial_applied',
    ].includes(priorRecord.state);
    let replayActual: TCurrent | undefined;
    try {
      // Read again after planned IDs have been recovered and buildDesired has
      // initialized adapter-specific readback state. This is required for
      // sagas whose first read cannot yet discover their planned child IDs.
      replayActual = await adapter.read(input);
    } catch (error) {
      const replayState = replayApplicationState(priorRecord.state);
      return makeResult(replayState, {
        ...confirmedCommon,
        warnings: ['Replay readback failed; the prior operation was not redispatched'],
        error: {
          code: 'IDEMPOTENT_REPLAY_READBACK_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      });
    }
    const readbackVerified = adapter.verifyReadback
      ? await adapter.verifyReadback(input, current, desired, replayActual)
      : replayActual !== undefined &&
        canonicalHash(adapter.semantic(replayActual), semanticDomain) === desiredHash;
    const actual = replayActual === undefined ? undefined : adapter.output(replayActual);
    if (reconcilable && readbackVerified) {
      await runtime.journal.update(operationId, (entry) => ({
        ...entry,
        state: 'applied_verified',
        updatedAt: new Date().toISOString(),
        steps: entry.steps.map((step) => step.kind === 'apply'
          ? { ...step, state: 'verified', updatedAt: new Date().toISOString() }
          : step),
      }));
      return makeResult('applied_verified', {
        ...confirmedCommon,
        actual,
        warnings: [
          'Idempotent replay performed readback only; desired state was verified without redispatch',
        ],
      });
    }
    if (priorRecord.state === 'applied_verified' && readbackVerified) {
      return makeResult('applied_verified', {
        ...confirmedCommon,
        actual,
        warnings: ['Idempotent replay confirmed the previously verified result without redispatch'],
      });
    }
    if (priorRecord.state === 'applied_verified' && !readbackVerified) {
      return makeResult('conflict', {
        ...confirmedCommon,
        actual,
        warnings: ['Recorded applied operation has since drifted; the write was not redispatched'],
        error: {
          code: 'IDEMPOTENT_REPLAY_STATE_DRIFT',
          message: 'Recorded applied operation no longer matches the desired state',
          retryable: false,
        },
      });
    }
    const replayState = replayApplicationState(priorRecord.state);
    return makeResult(replayState, {
      ...confirmedCommon,
      actual,
      warnings: [
        reconcilable
          ? 'Prior outcome remains inconclusive after readback; reconcile this operation without redispatch'
          : 'Prior operation state is terminal; the write was not redispatched',
      ],
      error: {
        code: reconcilable
          ? 'IDEMPOTENT_REPLAY_RECONCILIATION_REQUIRED'
          : 'IDEMPOTENT_REPLAY_TERMINAL',
        message: reconcilable
          ? 'Prior operation may have applied; readback did not prove the desired state'
          : `Prior operation is already ${priorRecord.state}`,
        retryable: false,
      },
    });
  }
  const concurrencyChecks: Array<[string, string | undefined, string | undefined]> = [
    ['semantic hash', approved.currentSemanticHash, currentSemanticHash],
    ['write-shape hash', approved.currentWriteShapeHash, currentWriteShapeHash],
  ];
  if (adapter.requireTimestamp ?? true) {
    concurrencyChecks.push(['timestamp', approved.entityTimestamp, entityTimestamp]);
  }
  for (const [name, expected, actual] of concurrencyChecks) {
    if (expected !== actual) throw new Error(`MUTATION_CONFLICT: stale ${name}; re-run preview`);
  }
  if (!adapter.writesEnabled) {
    throw new Error(
      `${adapter.disabledCode ?? 'WRITES_DISABLED'}: ${adapter.disabledMessage ?? `${adapter.resourceType} writes are disabled`}`
    );
  }
  await adapter.authorizeApply?.(input, current, desired);
  // No-op apply responses are still apply-path decisions. Requiring static
  // support and fresh gate authorization here ensures a closed gate
  // invalidates every existing preview, including exact-target deletes whose
  // target has already disappeared.
  if (noOp) {
    return makeResult('no_op', {
      ...confirmedCommon,
      resultCode: adapter.noOpResultCode?.(input, current, desired),
    });
  }
  if (idempotencyHash) {
    const winner = await runtime.journal.getOrCreateIdempotency(idempotencyHash, {
      operationId,
      desiredHash,
      plannedIds,
    });
    if (
      winner.operationId !== operationId ||
      winner.desiredHash !== desiredHash ||
      stableStringify(winner.plannedIds ?? {}) !== stableStringify(plannedIds)
    ) {
      throw new Error('IDEMPOTENCY_KEY_CONFLICT: mapping changed after confirmation; re-run preview');
    }
  }

  const dispatch = adapter.prepareDispatch
    ? await adapter.prepareDispatch(input, current, desired)
    : () => adapter.dispatch(input, current, desired);
  await adapter.validateBeforeDispatch?.(input, current, desired);

  const now = new Date().toISOString();
  const record: MutationJournalRecord = {
    schemaVersion: 'mutation-journal/v1',
    operationId,
    idempotencyKeyHash: idempotencyHash,
    tenantFingerprint: runtime.tenantFingerprint,
    resourceType: adapter.resourceType,
    resourceId,
    adapterVersion: adapter.adapterVersion,
    desiredHash,
    currentSemanticHash,
    currentWriteShapeHash,
    plannedIds,
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
    affectedResources,
    invalidationTags,
    confirmation: adapter.requiresExplicitConfirmation
      ? {
          hash: confirmationHash!,
          scope: confirmationScope!,
          receivedAt: new Date().toISOString(),
        }
      : undefined,
    steps: [],
  };
  await runtime.journal.put(record);
  await runtime.journal.appendStep(operationId, {
    stepId: 'write',
    kind: 'apply',
    intentHash: desiredHash,
    plannedIds: Object.values(plannedIds).flat(),
    state: 'prepared',
    updatedAt: now,
    invalidationTags,
  });
  await runtime.journal.update(operationId, (entry) => ({
    ...entry,
    state: 'dispatched',
    updatedAt: new Date().toISOString(),
    steps: entry.steps.map((step) => step.stepId === 'write'
      ? { ...step, state: 'dispatched', updatedAt: new Date().toISOString() }
      : step),
  }));

  const persistOutcome = async (
    state: ApplicationState,
    stepState: 'verified' | 'unknown' | 'failed',
    errorCode?: string
  ) => runtime.journal.update(operationId, (entry) => ({
    ...entry,
    state: journalState(state),
    updatedAt: new Date().toISOString(),
    steps: entry.steps.map((step) => step.stepId === 'write'
      ? { ...step, state: stepState, updatedAt: new Date().toISOString(), ...(errorCode ? { errorCode } : {}) }
      : step),
  }));

  try {
    if (!adapter.writesEnabled) {
      throw new Error(
        `${adapter.disabledCode ?? 'WRITES_DISABLED'}: ${adapter.disabledMessage ?? `${adapter.resourceType} writes are disabled`}`
      );
    }
    await adapter.authorizeApply?.(input, current, desired);
  } catch (error) {
    await persistOutcome('not_applied', 'failed', errorInfo(error).code);
    throw error;
  }

  const readbackMatches = async (actualCurrent: TCurrent | undefined): Promise<boolean> =>
    adapter.verifyReadback
      ? adapter.verifyReadback(input, current, desired, actualCurrent)
      : actualCurrent !== undefined &&
        canonicalHash(adapter.semantic(actualCurrent), semanticDomain) === desiredHash;

  try {
    await dispatch();
  } catch (error) {
    try {
      const actualCurrent = await adapter.read(input);
      if (await readbackMatches(actualCurrent)) {
        const actual = actualCurrent === undefined ? undefined : adapter.output(actualCurrent);
        const state: ApplicationState = 'applied_verified';
        await persistOutcome(state, 'verified');
        return makeResult(state, { ...confirmedCommon, actual, warnings: ['Write response failed, but readback proved the desired state'] });
      }
    } catch {
      // Preserve the original ambiguous write error below.
    }
    const state: ApplicationState = 'unknown_after_write';
    await persistOutcome(state, 'unknown', errorInfo(error).code);
    return makeResult(state, { ...confirmedCommon, error: errorInfo(error) });
  }

  try {
    const actualCurrent = await adapter.read(input);
    const verified = await readbackMatches(actualCurrent);
    if (!verified && actualCurrent === undefined) {
      const state: ApplicationState = 'applied_unverified';
      await persistOutcome(state, 'failed', 'VERIFICATION_MISSING');
      return makeResult(state, {
        ...confirmedCommon,
        error: { code: 'VERIFICATION_MISSING', message: 'Resource was not returned by readback', retryable: false },
      });
    }
    const actual = actualCurrent === undefined ? undefined : adapter.output(actualCurrent);
    if (verified) {
      const state: ApplicationState = 'applied_verified';
      await persistOutcome(state, 'verified');
      return makeResult(state, { ...confirmedCommon, actual });
    }
    const state: ApplicationState = adapter.isSaga ? 'partial_applied' : 'applied_unverified';
    await persistOutcome(state, 'failed', 'VERIFICATION_MISMATCH');
    return makeResult(state, {
      ...confirmedCommon,
      actual,
      error: { code: 'VERIFICATION_MISMATCH', message: 'Readback did not match the desired semantic state', retryable: false },
    });
  } catch (error) {
    const state: ApplicationState = 'applied_unverified';
    await persistOutcome(state, 'failed', errorInfo(error).code);
    return makeResult(state, { ...confirmedCommon, error: errorInfo(error) });
  }
}

export async function getMutationJournalStatus(
  journal: MutationJournal,
  operationId: string
): Promise<MutationJournalRecord> {
  const record = await journal.get(operationId);
  if (!record) throw new Error(`UNKNOWN_OPERATION: ${operationId}`);
  return record;
}
