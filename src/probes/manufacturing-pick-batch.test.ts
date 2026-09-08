import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InflowApiError } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { loadGateStatus } from '../core/attestation.js';
import { canonicalHash } from '../core/canonical-json.js';
import { MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION } from '../core/mutation.js';
import { tenantFingerprint } from '../core/preview-token.js';
import {
  planManufacturingRunBegin,
  type PlanManufacturingBatchInput,
} from '../services/manufacturing-run-planner.js';
import { flattenManufacturingLines } from '../services/manufacturing-order-trace.js';
import syntheticGolden from '../services/fixtures/manufacturing-order.synthetic-golden.json' with { type: 'json' };

const canaryModule = await import('./manufacturing-pick-batch.js').catch(() => ({}));
const paths: string[] = [];

afterEach(async () =>
  Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
);

function canary(name: string): (...args: any[]) => any {
  const value = (canaryModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value as (...args: any[]) => any;
}

function config(): InflowConfig {
  return {
    companyId: 'company',
    apiKey: 'secret',
    baseUrl: 'https://example.test',
    apiVersion: '2026-04-13',
    rateLimitPerMinute: 20,
    requestTimeoutMs: 1_000,
    maxRetries: 3,
    retryDelayMs: 1,
    readRetryBudgetMs: 1_000,
    debug: false,
    stateDir: '/tmp/not-used',
    adapterManifestHash: 'adapter-sha',
    probeBuild: 'probe-sha',
    enableLegacyWrites: false,
    safeWritesEnabled: false,
    stockWritesEnabled: false,
    writeGates: {
      manufacturing: true,
      'manufacturing-pick-batch-v1': false,
      prices: false,
      'product-groups': false,
      'mo-serials': false,
      standard: false,
    },
  };
}

function approval(value = config()) {
  const baseHost = new URL(value.baseUrl).host.toLowerCase();
  const scenarioManifestHash = scenarioHash();
  return {
    schemaVersion: 'manufacturing-pick-batch-canary-approval/v1',
    approved: true,
    approvalNonce: 'approval-123',
    tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, baseHost),
    baseHost,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    scenarioManifestHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedInertArtifactIds: [],
  };
}

const budget = {
  timeoutMs: 1_000,
  readRetryPolicy: { maxRetries: 3, baseDelayMs: 1 },
  mutationRetryPolicy: { maxRetries: 0 as const },
  rateLimiter: {
    capacity: 20,
    availableTokens: 20,
    queued: 0,
    refillPerSecond: 1 / 3,
    scope: 'process-local' as const,
  },
};

function batchInputs(): {
  complete: PlanManufacturingBatchInput;
  staging: PlanManufacturingBatchInput;
} {
  const begin = planManufacturingRunBegin({
    identity: {
      schemaVersion: 'manufacturing-run-identity/v2' as const,
      companyId: 'company',
      finishedProductId: 'finished-product',
      sourceSerial: 'SERIAL-001',
      finishedSerial: 'SERIAL-001',
    },
    locationId: 'location-main',
  });
  const current = structuredClone(syntheticGolden.document);
  current.manufacturingOrderId = begin.manufacturingOrderId;
  current.primaryFinishedProductId = begin.normalizedIdentity.finishedProductId;
  current.lines[0]!.manufacturingOrderLineId = begin.rootLineId;
  current.lines[0]!.manufacturingOrderLines.forEach((line) => {
    line.parentManufacturingOrderLineId = begin.rootLineId;
  });
  current.lines[0]!.manufacturingOrderOperations.forEach((operation) => {
    operation.manufacturingOrderLineId = begin.rootLineId;
  });
  current.remarks = begin.coordinatorMarker;
  const common = {
    begin,
    intents: [
      {
        rawLineId: 'component-line-a',
        productId: 'repeated-component',
        quantity: '2',
        locationId: 'location-main',
        serialized: true,
        serialNumbers: ['SERIAL-A', 'SERIAL-B'],
      },
      {
        rawLineId: 'component-line-b',
        productId: 'repeated-component',
        quantity: '1',
        locationId: 'location-main',
        serialized: false,
        serialNumbers: [],
      },
    ],
    output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
  };
  const completeCurrent = structuredClone(current);
  completeCurrent.lines[0]!.manufacturingOrderOperations = [];
  return {
    complete: { ...common, current: completeCurrent },
    staging: { ...common, current },
  };
}

function scenarioManifest() {
  const beginInput = {
    identity: {
      schemaVersion: 'manufacturing-run-identity/v2' as const,
      companyId: 'company',
      finishedProductId: 'finished-product',
      sourceSerial: 'SERIAL-001',
      finishedSerial: 'SERIAL-001',
    },
    locationId: 'location-main',
  };
  const begin = planManufacturingRunBegin(beginInput);
  const batches = batchInputs();
  const moPath = `/manufacturing-orders/${begin.manufacturingOrderId}`;
  const inventoryRequest = [
    { productId: 'finished-product' },
    { productId: 'repeated-component' },
  ];
  const inventoryBefore = { snapshot: 'inventory-before' };
  const inventoryAfter = { snapshot: 'inventory-after' };
  return {
    schemaVersion: 'manufacturing-pick-batch-canary-scenario/v1',
    scenarioId: 'approved-inert-scenario-1',
    beginInput,
    batches,
    phases: [
      {
        phase: 'deterministic-create-recovery',
        requestSource: 'begin-plan',
        expectedOutcome: 'response-loss-readback',
        reads: [
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: begin.createRequest.body,
          },
        ],
      },
      {
        phase: 'combined-atomic-write',
        requestSource: 'complete-plan',
        expectedOutcome: 'applied-verified',
        reads: [
          {
            role: 'inventory-before',
            timing: 'before',
            method: 'POST_READ',
            path: '/products/summary',
            body: inventoryRequest,
            expected: inventoryBefore,
          },
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: batches.complete.current,
          },
          {
            role: 'inventory-after',
            timing: 'after',
            method: 'POST_READ',
            path: '/products/summary',
            body: inventoryRequest,
            expected: inventoryAfter,
          },
        ],
      },
      {
        phase: 'operation-staging-atomic-write',
        requestSource: 'staging-plan',
        expectedOutcome: 'applied-verified',
        reads: [
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: batches.staging.current,
          },
        ],
      },
      {
        phase: 'stale-rowversion',
        requestSource: 'manifest',
        request: {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: {
            manufacturingOrderId: begin.manufacturingOrderId,
            __rejection: 'stale-rowversion',
          },
        },
        expectedOutcome: 'definitive-rejection',
        expectedRejection: { statusCode: 409, code: 'stale-rowversion' },
        reads: [
          {
            role: 'no-write-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: { unchanged: 'after-stale-rejection' },
          },
        ],
      },
      {
        phase: 'stable-replay',
        requestSource: 'none',
        expectedOutcome: 'readback-only',
        reads: [
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: { stable: true },
          },
        ],
      },
      {
        phase: 'serial-exclusion',
        requestSource: 'manifest',
        request: {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: {
            manufacturingOrderId: begin.manufacturingOrderId,
            __rejection: 'serial-exclusion',
          },
        },
        expectedOutcome: 'definitive-rejection',
        expectedRejection: { statusCode: 409, code: 'serial-exclusion' },
        reads: [
          {
            role: 'no-write-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: { unchanged: 'after-serial-rejection' },
          },
        ],
      },
      {
        phase: 'manual-completion',
        requestSource: 'manifest',
        request: {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: {
            manufacturingOrderId: begin.manufacturingOrderId,
            phase: 'manual-completion',
          },
        },
        expectedOutcome: 'applied-verified',
        reads: [
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: { phase: 'manual-completion' },
          },
        ],
      },
      {
        phase: 'cleanup',
        requestSource: 'manifest',
        request: {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: {
            manufacturingOrderId: begin.manufacturingOrderId,
            phase: 'cleanup',
          },
        },
        expectedOutcome: 'cleanup-verified',
        reads: [
          {
            role: 'mo-readback',
            timing: 'after',
            method: 'GET',
            path: moPath,
            expected: { phase: 'cleanup', inert: true },
          },
          {
            role: 'inventory-after-cleanup',
            timing: 'after',
            method: 'POST_READ',
            path: '/products/summary',
            body: inventoryRequest,
            expected: inventoryBefore,
          },
        ],
      },
    ],
    approvedInertArtifactIds: [],
  };
}

function scenarioHash(): string {
  return canary('manufacturingPickBatchCanaryScenarioHash')(
    scenarioManifest()
  );
}

function scenarioExecutionClient(options?: {
  rejectionSucceeds?: boolean;
  rejectionCode?: string;
}) {
  const manifest = scenarioManifest();
  const getReads = manifest.phases.flatMap((phase) =>
    phase.reads.filter((read) => read.method === 'GET')
  );
  const postReads = manifest.phases.flatMap((phase) =>
    phase.reads.filter((read) => read.method === 'POST_READ')
  );
  let getIndex = 0;
  let postIndex = 0;
  let mutationIndex = 0;
  return {
    telemetrySnapshot: () => budget,
    get: vi.fn(async (path: string) => {
      const read = getReads[getIndex++]!;
      expect(path).toBe(read.path);
      return structuredClone(read.expected);
    }),
    postRead: vi.fn(async (path: string, body: unknown) => {
      const read = postReads[postIndex++]!;
      expect(path).toBe(read.path);
      expect(body).toEqual((read as any).body);
      return structuredClone(read.expected);
    }),
    prepareMutation: vi.fn(async (_method, _path, requestOptions) => {
      const currentMutation = mutationIndex++;
      return {
        correlationId: `correlation-${currentMutation}`,
        dispatch: vi.fn(async () => {
          if (currentMutation === 0) {
            throw new TypeError('response lost');
          }
          if (requestOptions.body?.__rejection) {
            if (options?.rejectionSucceeds) {
              return { incorrectlyApplied: true };
            }
            const code =
              options?.rejectionCode ??
              String(requestOptions.body.__rejection);
            throw new InflowApiError('Definitive rejection', 409, {
              code,
              message: 'Provider rejected the controlled canary mutation',
            });
          }
          return structuredClone(requestOptions.body);
        }),
      };
    }),
  };
}

const observations = {
  deterministicCreateRecovery: true,
  serverExpandedBom: true,
  expandedSubassemblyLeafOnly: true,
  operationsPreserved: true,
  serializedMatchingShape: true,
  nonSerializedMatchingShape: true,
  existingIdentityPreserved: true,
  unknownFieldsPreserved: true,
  combinedAtomicWrite: true,
  operationStagingAtomicWrite: true,
  staleRowversionNoWrite: true,
  stableReplay: true,
  serialExclusion: true,
  serialContentionNoWrite: true,
  inventoryMovement: true,
  exactReadback: true,
  manualCompletion: true,
  cleanup: true,
};

function liveTrace() {
  const records = Object.keys(observations).map((observation) => ({
    recordId: `proof:${observation}`,
    kind: 'provider-read',
    path: `/evidence/${observation}`,
    value: { path: `/evidence/${observation}` },
  }));
  const proofs = Object.fromEntries(
    Object.keys(observations).map((observation) => [
      observation,
      {
        sourceRecordIds: [`proof:${observation}`],
        expected: { path: `/evidence/${observation}` },
        actualRecordId: `proof:${observation}`,
      },
    ])
  );
  return {
    schemaVersion: 'manufacturing-pick-batch-canary-trace/v1',
    proofs,
    attempts: [
      {
        phase: 'deterministic-create-recovery',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'response-loss-readback',
      },
      {
        phase: 'combined-atomic-write',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'applied-verified',
      },
      {
        phase: 'operation-staging-atomic-write',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'applied-verified',
      },
      {
        phase: 'stale-rowversion',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'definitive-rejection',
      },
      {
        phase: 'stable-replay',
        method: 'READ',
        path: '/manufacturing-orders/mo-stable',
        dispatchCount: 0,
        outcome: 'readback-only',
      },
      {
        phase: 'serial-exclusion',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'definitive-rejection',
      },
      {
        phase: 'manual-completion',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'applied-verified',
      },
      {
        phase: 'cleanup',
        method: 'PUT',
        path: '/manufacturing-orders',
        dispatchCount: 1,
        outcome: 'cleanup-verified',
      },
    ],
    records,
    optimisticConcurrency: 'enforced',
    confirmedResidualIds: [],
    possibleResidualIds: [],
    approvedInertArtifactIds: [],
    beforeSnapshot: { inventory: 'before' },
    afterCleanupSnapshot: { inventory: 'before' },
  };
}

function liveDriver(trace = liveTrace()) {
  return {
    run: vi.fn(async (context: any) => {
      const begin = context.prepareBegin({
        identity: {
          schemaVersion: 'manufacturing-run-identity/v2',
          companyId: 'company',
          finishedProductId: 'finished-product',
          sourceSerial: 'SERIAL-001',
          finishedSerial: 'SERIAL-001',
        },
        locationId: 'location-main',
      });
      const plans = context.preparePlans(batchInputs());
      await context.dispatchMutationOnce(
        'deterministic-create-recovery',
        begin.primary.createRequest,
        {
          recordId: 'deterministic-create-readback',
          path: `/manufacturing-orders/${begin.primary.manufacturingOrderId}`,
          verify: () => true,
        }
      );
      await context.dispatchMutationOnce(
        'combined-atomic-write',
        plans.complete.request,
        {
          recordId: 'combined-readback',
          path: `/manufacturing-orders/${begin.primary.manufacturingOrderId}`,
          verify: context.readbackVerifier(plans.complete),
        }
      );
      await context.dispatchMutationOnce(
        'operation-staging-atomic-write',
        plans.staging.request
      );
      await context.dispatchExpectedRejectionOnce(
        'stale-rowversion',
        {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: { __rejection: 'stale-rowversion' },
        },
        (error: unknown) =>
          error instanceof InflowApiError && error.statusCode === 409
      );
      await context.readProvider(
        'stable-replay-readback',
        '/manufacturing-orders/mo-stable',
        undefined,
        'stable-replay'
      );
      await context.dispatchExpectedRejectionOnce(
        'serial-exclusion',
        {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: { __rejection: 'serial-exclusion' },
        },
        (error: unknown) =>
          error instanceof InflowApiError && error.statusCode === 409
      );
      await context.dispatchMutationOnce('manual-completion', {
        method: 'PUT',
        path: '/manufacturing-orders',
        body: { phase: 'manual-completion' },
      });
      await context.dispatchMutationOnce('cleanup', {
        method: 'PUT',
        path: '/manufacturing-orders',
        body: { phase: 'cleanup' },
      });
      const proofs: Record<string, unknown> = {};
      for (const observation of Object.keys(observations)) {
        const recordId = `proof:${observation}`;
        const actual = await context.readProvider(
          recordId,
          `/evidence/${observation}`
        );
        proofs[observation] = {
          sourceRecordIds: [recordId],
          expected: actual,
          actualRecordId: recordId,
        };
      }
      const { attempts: _attempts, records: _records, ...driverEvidence } =
        trace;
      return { ...driverEvidence, proofs };
    }),
  };
}

function liveClient() {
  let mutationCount = 0;
  return {
    telemetrySnapshot: () => budget,
    get: vi.fn(async (path: string) => ({ path })),
    prepareMutation: vi.fn(async (_method, _path, options) => ({
      correlationId: 'correlation-live',
      dispatch: vi.fn(async () => {
        mutationCount += 1;
        if (mutationCount === 1) throw new TypeError('response lost');
        if (options.body?.__rejection) {
          throw new InflowApiError('Definitive rejection', 409, {
            code: String(options.body.__rejection),
            message: 'Provider rejected the controlled canary mutation',
          });
        }
        return options.body;
      }),
    })),
  };
}

describe('manufacturing pick-batch canary preflight', () => {
  it('requires dedicated structured approval material for the standalone command', () => {
    const parseApproval = canary(
      'parseManufacturingPickBatchCanaryApproval'
    );
    expect(() => parseApproval(undefined)).toThrow(
      'CANARY_APPROVAL_MATERIAL_REQUIRED'
    );
    expect(() => parseApproval('not-json')).toThrow(
      'CANARY_APPROVAL_MATERIAL_INVALID'
    );
    const value = approval();
    expect(parseApproval(JSON.stringify(value))).toEqual(value);
  });

  it('requires the safe, stock, and coordinator gates closed and exact explicit approval identities before mutation preparation', () => {
    const assertReady = canary('assertManufacturingPickBatchCanaryReady');
    expect(assertReady(config(), approval(), budget, scenarioHash())).toBe(
      'approval-123'
    );
    expect(() =>
      assertReady(
        {
          ...config(),
          writeGates: {
            ...config().writeGates,
            'manufacturing-pick-batch-v1': true,
          },
        },
        approval(),
        budget,
        scenarioHash()
      )
    ).toThrow('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');
    expect(() =>
      assertReady(
        { ...config(), safeWritesEnabled: true },
        approval(),
        budget,
        scenarioHash()
      )
    ).toThrow('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');
    expect(() =>
      assertReady(
        { ...config(), stockWritesEnabled: true },
        approval(),
        budget,
        scenarioHash()
      )
    ).toThrow('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');
    const omittedGateConfig = config();
    delete omittedGateConfig.writeGates['manufacturing-pick-batch-v1'];
    expect(() =>
      assertReady(omittedGateConfig, approval(), budget, scenarioHash())
    ).toThrow('COORDINATOR_WRITE_GATE_MUST_BE_CLOSED');

    for (const field of [
      'tenantFingerprint',
      'baseHost',
      'apiVersion',
      'probeBuild',
      'adapterManifestHash',
      'serializerVersion',
      'contractVersion',
    ]) {
      expect(() =>
        assertReady(
          config(),
          { ...approval(), [field]: 'drift' },
          budget,
          scenarioHash()
        )
      ).toThrow('CANARY_APPROVAL_IDENTITY_MISMATCH');
    }
  });

  it('requires explicit unexpired approval and a dedicated zero-retry rate budget', () => {
    const assertReady = canary('assertManufacturingPickBatchCanaryReady');
    expect(() =>
      assertReady(
        config(),
        { ...approval(), approved: false },
        budget,
        scenarioHash()
      )
    ).toThrow('CANARY_EXPLICIT_APPROVAL_REQUIRED');
    expect(() =>
      assertReady(
        config(),
        { ...approval(), expiresAt: new Date(Date.now() - 1).toISOString() },
        budget,
        scenarioHash()
      )
    ).toThrow('CANARY_APPROVAL_EXPIRED');
    expect(() =>
      assertReady(
        config(),
        approval(),
        {
          ...budget,
          mutationRetryPolicy: { maxRetries: 1 },
        },
        scenarioHash()
      )
    ).toThrow('CANARY_ZERO_RETRY_CLIENT_REQUIRED');
    expect(() =>
      assertReady(
        config(),
        approval(),
        {
          ...budget,
          rateLimiter: { ...budget.rateLimiter, capacity: 60 },
        },
        scenarioHash()
      )
    ).toThrow('CANARY_DEDICATED_RATE_BUDGET_REQUIRED');
  });
});

describe('manufacturing pick-batch mutation dispatch', () => {
  it('prepares and dispatches exactly once, then uses only readback after response loss', async () => {
    const dispatchOnce = canary('dispatchManufacturingPickBatchMutationOnce');
    const dispatch = vi.fn(async () => {
      throw new TypeError('response lost');
    });
    const prepareMutation = vi.fn(async () => ({
      correlationId: 'correlation-1',
      dispatch,
    }));
    const readback = vi.fn(async () => ({ manufacturingOrderId: 'mo-1' }));
    const verifyReadback = vi.fn(() => true);

    await expect(
      dispatchOnce(
        { prepareMutation },
        {
          method: 'PUT',
          path: '/manufacturing-orders',
          query: { fillDefaultBom: true },
          body: { manufacturingOrderId: 'mo-1' },
        },
        readback,
        verifyReadback
      )
    ).resolves.toMatchObject({
      outcome: 'response-loss-readback',
      value: { manufacturingOrderId: 'mo-1' },
    });
    expect(prepareMutation).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(readback).toHaveBeenCalledOnce();
    expect(verifyReadback).toHaveBeenCalledOnce();
  });

  it('fails closed when response-loss readback does not exactly match the expected post-state', async () => {
    const dispatchOnce = canary('dispatchManufacturingPickBatchMutationOnce');
    const prepareMutation = vi.fn(async () => ({
      correlationId: 'correlation-1',
      dispatch: vi.fn(async () => {
        throw new TypeError('response lost');
      }),
    }));
    await expect(
      dispatchOnce(
        { prepareMutation },
        {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: { manufacturingOrderId: 'mo-1' },
        },
        async () => ({ manufacturingOrderId: 'different' }),
        () => false
      )
    ).rejects.toThrow('CANARY_RESPONSE_LOSS_READBACK_MISMATCH');
  });

  it('surfaces confirmed API rejections without response-loss readback', async () => {
    const dispatchOnce = canary('dispatchManufacturingPickBatchMutationOnce');
    const readback = vi.fn();
    const rejection = new InflowApiError('Timestamp conflict', 409, {
      code: 'timestamp_conflict',
      message: 'The row version has changed',
    });
    await expect(
      dispatchOnce(
        {
          prepareMutation: vi.fn(async () => ({
            correlationId: 'correlation-1',
            dispatch: vi.fn(async () => {
              throw rejection;
            }),
          })),
        },
        {
          method: 'PUT',
          path: '/manufacturing-orders',
          body: { manufacturingOrderId: 'mo-1' },
        },
        readback,
        () => true
      )
    ).rejects.toBe(rejection);
    expect(readback).not.toHaveBeenCalled();
  });
});

describe('manufacturing pick-batch production plans', () => {
  it('uses the production begin planner twice to prove deterministic MO/root IDs and fillDefaultBom create shape', () => {
    const prepareBegin = canary(
      'prepareManufacturingPickBatchCanaryBegin'
    );
    const result = prepareBegin({
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company',
        finishedProductId: 'finished-product',
        sourceSerial: 'SERIAL-001',
        finishedSerial: 'SERIAL-001',
      },
      locationId: 'location-main',
    });
    expect(result.primary).toEqual(result.replay);
    expect(result.primary.createRequest.query).toEqual({
      fillDefaultBom: true,
    });
    expect(result.primary.manufacturingOrderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.primary.rootLineId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the production planner to create distinct single-request complete and operation-staging shapes', () => {
    const preparePlans = canary('prepareManufacturingPickBatchCanaryPlans');
    const result = preparePlans(batchInputs());
    expect(result.complete.mode).toBe('complete');
    expect(result.complete.request).toMatchObject({
      method: 'PUT',
      path: '/manufacturing-orders',
      body: {
        isCompleted: true,
        unknownProviderHeader: { keep: true },
      },
    });
    expect(result.complete.request.body.pickMatchings).toHaveLength(3);
    expect(result.complete.request.body.putLines).toHaveLength(1);
    expect(result.staging.mode).toBe('operation-staging');
    expect(result.staging.request.body).toMatchObject({
      isCompleted: false,
      putLines: [],
      unknownProviderHeader: { keep: true },
    });
    expect(
      result.staging.request.body.lines[0].manufacturingOrderOperations
    ).toHaveLength(2);
    expect(Object.keys(result.complete).filter((key) => key === 'request'))
      .toHaveLength(1);
    expect(Object.keys(result.staging).filter((key) => key === 'request'))
      .toHaveLength(1);

    const verifyReadback = canary(
      'manufacturingBatchPlanReadbackVerifier'
    )(result.complete);
    expect(verifyReadback(result.complete.request.body)).toBe(true);
    expect(
      verifyReadback({
        ...result.complete.request.body,
        unknownProviderHeader: { keep: false },
      })
    ).toBe(false);
  });
});

describe('manufacturing pick-batch evidence and attestation', () => {
  it('requires the approved and confirmed v2 residuals to equal both subject IDs', () => {
    const assertEvidence = canary('assertManufacturingPickBatchCanaryV2AttestationEvidence');
    expect(() => assertEvidence({
      observations,
      optimisticConcurrency: 'enforced',
      cleanupVerified: true,
      confirmedResidualIds: [],
      possibleResidualIds: [],
      approvedInertArtifactIds: [],
      beforeSnapshot: {
        schemaVersion: 'manufacturing-pick-batch-canary-attestation-evidence/v2',
        scenarioManifestHash: 'a'.repeat(64),
        checkpointChainHead: 'b'.repeat(64),
        subjects: { complete: 'complete-mo', staging: 'staging-mo' },
      },
      afterCleanupSnapshot: {},
    })).toThrow('CANARY_V2_RESIDUAL_SET_REQUIRED');
  });

  it('enforces every observation, concurrency, cleanup and residual ambiguity', () => {
    const evaluate = canary('evaluateManufacturingPickBatchCanaryEvidence');
    const passing = {
      observations,
      optimisticConcurrency: 'enforced',
      cleanupVerified: true,
      confirmedResidualIds: [],
      possibleResidualIds: [],
      approvedInertArtifactIds: [],
      beforeSnapshot: {},
      afterCleanupSnapshot: {},
    };
    expect(evaluate(passing)).toMatchObject({ passed: true, failedChecks: [] });
    for (const observation of Object.keys(observations)) {
      expect(
        evaluate({
          ...passing,
          observations: { ...observations, [observation]: false },
        })
      ).toMatchObject({ passed: false, failedChecks: [observation] });
    }
    expect(
      evaluate({ ...passing, optimisticConcurrency: 'unknown' })
    ).toMatchObject({
      passed: false,
      failedChecks: ['optimisticConcurrency'],
    });
    expect(
      evaluate({ ...passing, possibleResidualIds: ['possible-mo'] })
    ).toMatchObject({
      passed: false,
      failedChecks: ['possibleResidualIds'],
    });
    expect(
      evaluate({ ...passing, confirmedResidualIds: ['unapproved-mo'] })
    ).toMatchObject({
      passed: false,
      failedChecks: ['confirmedResidualApproval'],
    });
    expect(evaluate({ ...passing, cleanupVerified: false })).toMatchObject({
      passed: false,
      failedChecks: ['cleanupVerified'],
    });
  });

  it('refuses legacy evidence instead of issuing a production attestation', async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), 'inflow-pick-batch-canary-')
    );
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const issue = canary('issueManufacturingPickBatchCanaryAttestation');
    await expect(issue(
      value,
      approval(value),
      budget,
      {
        observations,
        optimisticConcurrency: 'enforced',
        cleanupVerified: true,
        confirmedResidualIds: [],
        possibleResidualIds: [],
        approvedInertArtifactIds: [],
        beforeSnapshot: { inventory: 'before' },
        afterCleanupSnapshot: { inventory: 'before' },
      },
      scenarioHash()
    )).rejects.toThrow('CANARY_V2_ATTESTATION_EVIDENCE_REQUIRED');
    const baseHost = new URL(value.baseUrl).host.toLowerCase();
    const common = {
      stateDir,
      domain: 'manufacturing-pick-batch-v1' as const,
      environmentEnabled: true,
      apiKey: value.apiKey,
      tenantFingerprint: tenantFingerprint(
        value.companyId,
        value.apiKey,
        baseHost
      ),
      baseHost,
      apiVersion: value.apiVersion,
      probeBuild: value.probeBuild,
      adapterManifestHash: value.adapterManifestHash,
      serializerVersion: SERIALIZER_VERSION,
      contractVersion: MUTATION_CONTRACT_VERSION,
    };
    await expect(loadGateStatus(common)).resolves.toMatchObject({
      attestationState: 'missing',
      enabled: false,
    });
  });
});

describe('manufacturing pick-batch core-owned scenario execution', () => {
  function scenarioClient(options?: {
    rejectionSucceeds?: boolean;
    rejectionCode?: string;
  }) {
    return scenarioExecutionClient(options);
  }

  it('disables the legacy v1 live command before any provider operation', async () => {
    const client = scenarioClient();
    const runCommand = canary('runManufacturingPickBatchCanaryCommand');
    await expect(runCommand({
      config: config(),
      approval: approval(),
      client,
      scenario: scenarioManifest(),
    })).rejects.toThrow('CANARY_V1_LIVE_COMMAND_DISABLED');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.postRead).not.toHaveBeenCalled();
    expect(client.prepareMutation).not.toHaveBeenCalled();
  });
});

function v2Fixture() {
  const scenario = {
    schemaVersion: 'manufacturing-pick-batch-canary-scenario/v2',
    scenarioId: 'manufacturing-canary-v2-fixture',
    subjects: {
      complete: {
        beginInput: {
          identity: {
            schemaVersion: 'manufacturing-run-identity/v2',
            companyId: 'company',
            finishedProductId: 'complete-finished',
            sourceSerial: 'COMPLETE-SERIAL',
            finishedSerial: 'COMPLETE-SERIAL',
          },
          locationId: 'canary-location',
        },
        requiredExpandedShape: 'no-operations',
        output: { serialNumber: 'COMPLETE-SERIAL', locationId: 'canary-location' },
      },
      staging: {
        beginInput: {
          identity: {
            schemaVersion: 'manufacturing-run-identity/v2',
            companyId: 'company',
            finishedProductId: 'staging-finished',
            sourceSerial: 'STAGING-SERIAL',
            finishedSerial: 'STAGING-SERIAL',
          },
          locationId: 'canary-location',
        },
        requiredExpandedShape: 'operations-present',
        output: { serialNumber: 'STAGING-SERIAL', locationId: 'canary-location' },
      },
    },
    approvedInertArtifactIds: [] as string[],
  } as const;
  const completeBegin = planManufacturingRunBegin(scenario.subjects.complete.beginInput);
  const stagingBegin = planManufacturingRunBegin(scenario.subjects.staging.beginInput);
  scenario.approvedInertArtifactIds.push(
    completeBegin.manufacturingOrderId,
    stagingBegin.manufacturingOrderId
  );
  const expanded = (kind: 'complete' | 'staging') => {
    const begin = kind === 'complete' ? completeBegin : stagingBegin;
    const current = structuredClone(syntheticGolden.document);
    current.manufacturingOrderId = begin.manufacturingOrderId;
    current.primaryFinishedProductId = begin.normalizedIdentity.finishedProductId;
    current.timestamp = kind === 'complete' ? '10' : '20';
    current.status = 'open';
    current.isCompleted = false;
    current.isCancelled = false;
    current.pickLines = [];
    current.pickMatchings = [];
    current.putLines = [];
    current.remarks = begin.coordinatorMarker;
    current.lines[0]!.manufacturingOrderLineId = begin.rootLineId;
    current.lines[0]!.productId = begin.normalizedIdentity.finishedProductId;
    current.lines[0]!.quantity.serialNumbers = [];
    current.lines[0]!.manufacturingOrderLines.forEach((line) => {
      line.parentManufacturingOrderLineId = begin.rootLineId;
      (line as any).manufacturingOrderLines = [];
      (line as any).manufacturingOrderOperations = [];
    });
    const componentA = current.lines[0]!.manufacturingOrderLines.find(
      (line) => line.manufacturingOrderLineId === 'component-line-a'
    )!;
    componentA.parentManufacturingOrderLineId = 'expanded-subassembly-line';
    current.lines[0]!.manufacturingOrderLines = [
      {
        manufacturingOrderLineId: 'expanded-subassembly-line',
        parentManufacturingOrderLineId: begin.rootLineId,
        productId: 'expanded-subassembly-product',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: [],
        },
        manufacturingOrderLines: [componentA],
        manufacturingOrderOperations: [],
      } as any,
      ...current.lines[0]!.manufacturingOrderLines.filter(
        (line) => line.manufacturingOrderLineId !== 'component-line-a'
      ),
    ];
    current.lines[0]!.manufacturingOrderOperations.forEach((operation) => {
      operation.manufacturingOrderLineId = begin.rootLineId;
    });
    if (kind === 'complete') current.lines[0]!.manufacturingOrderOperations = [];
    return current;
  };
  const complete = expanded('complete');
  const staging = expanded('staging');
  const intents = (current: typeof complete) => flattenManufacturingLines(
    current.lines[0]!.manufacturingOrderLines
  ).filter((line) => (line.manufacturingOrderLines?.length ?? 0) === 0).map(
    (line) => ({
      rawLineId: line.manufacturingOrderLineId!,
      productId: line.productId!,
      quantity: line.quantity!.standardQuantity!,
      locationId: 'canary-location',
      serialized: line.manufacturingOrderLineId === 'component-line-a',
      serialNumbers: line.manufacturingOrderLineId === 'component-line-a'
        ? ['COMPONENT-A', 'COMPONENT-B']
        : [],
    })
  );
  return {
    scenario,
    completeBegin,
    stagingBegin,
    complete,
    staging,
    completeIntents: intents(complete),
    stagingIntents: intents(staging),
  };
}

function stageApprovalV2(
  value: InflowConfig,
  checkpoint: any,
  stage: string,
  stagePlanHash: string,
  approvedInertArtifactIds: string[]
) {
  const baseHost = new URL(value.baseUrl).host.toLowerCase();
  return {
    schemaVersion: 'manufacturing-pick-batch-canary-stage-approval/v1',
    approved: true,
    approvalNonce: `${stage}-approval-${checkpoint.checkpointHash.slice(0, 8)}`,
    stage,
    tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, baseHost),
    baseHost,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    scenarioManifestHash: checkpoint.scenarioManifestHash,
    checkpointHash: checkpoint.checkpointHash,
    stagePlanHash,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    approvedInertArtifactIds,
  };
}

function fullV2ProviderHarness(options: {
  serialApiRejection?: { statusCode: number; code?: string };
  staleApiRejection?: { statusCode: number; code?: string };
  omitLocationSummaries?: boolean;
  omitInventoryLinesFor?: string;
  retainZeroOutputInventoryLines?: boolean;
  allowSerialContentionWrite?: boolean;
} = {}) {
  const providerOptions = options;
  const fixture = v2Fixture();
  const scenario: any = structuredClone(fixture.scenario);
  scenario.approvedInertArtifactIds = [
    fixture.completeBegin.manufacturingOrderId,
    fixture.stagingBegin.manufacturingOrderId,
  ];
  const expanded = {
    complete: structuredClone(fixture.complete) as any,
    staging: structuredClone(fixture.staging) as any,
  };
  expanded.complete.manufacturingOrderNumber = 'MO-CANARY-C';
  expanded.staging.manufacturingOrderNumber = 'MO-CANARY-S';
  for (const order of Object.values(expanded) as any[]) {
    const lines = flattenManufacturingLines(order.lines[0].manufacturingOrderLines);
    lines.find((line: any) => line.manufacturingOrderLineId === 'component-line-a')!.productId = 'serial-component';
    lines.find((line: any) => line.manufacturingOrderLineId === 'component-line-b')!.productId = 'bulk-component';
  }
  const intents = {
    complete: [
      {
        rawLineId: 'component-line-a', productId: 'serial-component', quantity: '2',
        locationId: 'canary-location', serialized: true, serialNumbers: ['COMP-A', 'COMP-B'],
      },
      {
        rawLineId: 'component-line-b', productId: 'bulk-component', quantity: '1',
        locationId: 'canary-location', serialized: false, serialNumbers: [],
      },
    ],
    staging: [
      {
        rawLineId: 'component-line-a', productId: 'serial-component', quantity: '2',
        locationId: 'canary-location', serialized: true, serialNumbers: ['STAGE-A', 'STAGE-B'],
      },
      {
        rawLineId: 'component-line-b', productId: 'bulk-component', quantity: '1',
        locationId: 'canary-location', serialized: false, serialNumbers: [],
      },
    ],
  };
  const runtimeMaterial = {
    stockMove: { intents },
    negativeProbes: {
      staleExpectedRejection: { statusCode: 409, code: 'STALE_ROWVERSION' },
      serialExclusion: {
        subject: 'staging',
        productId: 'serial-component',
        serial: 'COMP-A',
        rawLineId: 'component-line-a',
        reason: 'COMP-A was consumed by the complete canary MO and must be rejected for staging',
        approvedComponentSerials: ['STAGE-A', 'STAGE-B'],
        expectedRejection: { statusCode: 400, code: 'NegativeSerialNumberInventory' },
      },
    },
  };
  const orders = new Map<string, any>();
  let externalBulkDrift = 0;
  let bulkInventoryLocation = 'canary-location';
  let externalStructuralDrift = 0;
  let driftStructuralAfterStockDispatches = false;
  let stockDispatches = 0;
  const allComponentSerials = ['COMP-A', 'COMP-B', 'STAGE-A', 'STAGE-B'];
  const clone = <T>(value: T): T => structuredClone(value);
  const pickedSerials = () => new Set(
    [...orders.values()].flatMap((order) =>
      (order.pickLines ?? []).flatMap((line: any) => line.quantity?.serialNumbers ?? [])
    )
  );
  const pickedBulk = () => [...orders.values()].reduce((total, order) =>
    total + (order.pickLines ?? [])
      .filter((line: any) => line.productId === 'bulk-component')
      .reduce((sum: number, line: any) => sum + Number(line.quantity?.standardQuantity ?? 0), 0), 0);
  const outputHolding = (productId: string) => [...orders.values()].flatMap((order) =>
    (order.putLines ?? []).filter((line: any) => line.productId === productId)
  );
  const seenOutputInventoryLines = new Map<string, Set<string>>();
  const quantityFor = (productId: string) => {
    if (productId === 'serial-component') return allComponentSerials.length - pickedSerials().size;
    if (productId === 'bulk-component') return 2 - pickedBulk() + externalBulkDrift;
    if (productId === 'expanded-subassembly-product') return externalStructuralDrift;
    return outputHolding(productId).length;
  };
  const summaryFor = (productId: string) => {
    const quantity = String(quantityFor(productId));
    return {
      productId,
      quantityOnHand: quantity,
      quantityAvailable: quantity,
      quantityOnOrder: '0',
      quantityAllocated: '0',
      locationSummaries: options.omitLocationSummaries ? [] : [{
        locationId: 'canary-location',
        locationName: 'Canary',
        quantityOnHand: quantity,
        quantityAvailable: quantity,
        sublocationSummaries: [],
      }],
    };
  };
  const productFor = (productId: string) => {
    if (productId === options.omitInventoryLinesFor) return { productId };
    const inventoryLines: any[] = [];
    if (productId === 'serial-component') {
      for (const serial of allComponentSerials.filter((value) => !pickedSerials().has(value))) {
        inventoryLines.push({ serial, locationId: 'canary-location', sublocation: '', quantityOnHand: '1' });
      }
    }
    if (productId === 'bulk-component') {
      inventoryLines.push({ locationId: bulkInventoryLocation, sublocation: '', quantityOnHand: String(quantityFor(productId)) });
    }
    for (const line of outputHolding(productId)) {
      for (const serial of line.quantity?.serialNumbers ?? []) {
        const seen = seenOutputInventoryLines.get(productId) ?? new Set<string>();
        seen.add(serial);
        seenOutputInventoryLines.set(productId, seen);
        inventoryLines.push({ serial, locationId: line.locationId, sublocation: line.sublocation ?? '', quantityOnHand: '1' });
      }
    }
    if (options.retainZeroOutputInventoryLines && outputHolding(productId).length === 0) {
      for (const serial of seenOutputInventoryLines.get(productId) ?? []) {
        inventoryLines.push({ serial, locationId: 'canary-location', sublocation: '', quantityOnHand: '0' });
      }
    }
    return { productId, inventoryLines };
  };
  const nextTimestamp = (value: string) => (BigInt(`0x${value}`) + 1n).toString(16).toUpperCase();
  const get = vi.fn(async (path: string) => {
    if (path.startsWith('/manufacturing-orders/')) {
      const id = path.split('/').at(-1)!;
      const order = orders.get(id);
      if (!order) throw new InflowApiError('not found', 404);
      return clone(order);
    }
    if (path.endsWith('/summary')) return summaryFor(path.split('/').at(-2)!);
    if (path.startsWith('/products/')) return productFor(path.split('/').at(-1)!);
    throw new Error(`unexpected GET ${path}`);
  });
  const getList = vi.fn(async (_path: string, options: any) => {
    const values = [...orders.values()].filter((order) => {
      if (options.filters?.manufacturingOrderNumber) {
        return order.manufacturingOrderNumber === options.filters.manufacturingOrderNumber;
      }
      return true;
    });
    const skip = options.pagination?.skip ?? 0;
    const count = options.pagination?.count ?? values.length;
    return { data: clone(values.slice(skip, skip + count)), totalCount: values.length };
  });
  const prepareMutation = vi.fn(async (_method: string, _path: string, options: any) => {
    const body = clone(options.body) as any;
    return {
      correlationId: `corr-${prepareMutation.mock.calls.length}`,
      dispatch: vi.fn(async () => {
        if (options.params?.fillDefaultBom === true) {
          const kind = body.manufacturingOrderId === fixture.completeBegin.manufacturingOrderId ? 'complete' : 'staging';
          orders.set(body.manufacturingOrderId, clone(expanded[kind]));
          return { created: body.manufacturingOrderId };
        }
        if ((body.remarks ?? '').includes('manufacturing-pick-batch-canary-stale')) {
          const rejection = providerOptions.staleApiRejection ?? {
            statusCode: 409,
            code: 'STALE_ROWVERSION',
          };
          throw new InflowApiError('stale', rejection.statusCode, {
            ...(rejection.code ? { code: rejection.code } : {}),
            message: 'stale',
          });
        }
        const incomingSerials = new Set(
          (body.pickLines ?? []).flatMap(
            (line: any) => line.quantity?.serialNumbers ?? []
          )
        );
        const serialsPickedByOtherOrders = new Set(
          [...orders.entries()]
            .filter(([manufacturingOrderId]) =>
              manufacturingOrderId !== body.manufacturingOrderId
            )
            .flatMap(([, order]) =>
              (order.pickLines ?? []).flatMap(
                (line: any) => line.quantity?.serialNumbers ?? []
              )
            )
        );
        if (
          [...incomingSerials].some((serial) =>
            serialsPickedByOtherOrders.has(serial)
          ) && !providerOptions.allowSerialContentionWrite
        ) {
          const rejection = providerOptions.serialApiRejection ?? {
            statusCode: 400,
            code: 'NegativeSerialNumberInventory',
          };
          throw new InflowApiError('serial excluded', rejection.statusCode, {
            code: rejection.code,
            message: 'serial excluded',
          });
        }
        body.timestamp = nextTimestamp(orders.get(body.manufacturingOrderId).timestamp);
        orders.set(body.manufacturingOrderId, body);
        if ((body.pickLines ?? []).length > 0) {
          stockDispatches += 1;
          if (driftStructuralAfterStockDispatches && stockDispatches >= 2) {
            externalStructuralDrift = 1;
          }
        }
        return { applied: body.manufacturingOrderId };
      }),
    };
  });
  const client = { telemetrySnapshot: () => budget, get, getList, prepareMutation };
  const completeManualStaging = () => {
    const order = clone(orders.get(fixture.stagingBegin.manufacturingOrderId));
    order.isCompleted = true;
    order.status = 'completed';
    order.completedDate = '2026-07-31T20:00:00Z';
    order.timestamp = nextTimestamp(order.timestamp);
    order.lines[0].quantity.serialNumbers = ['STAGING-SERIAL'];
    order.lines[0].manufacturingOrderOperations.forEach((operation: any) => {
      operation.completedDate = '2026-07-31T20:00:00Z';
    });
    order.putLines = [{
      manufacturingOrderPutLineId: 'manual-staging-put',
      manufacturingOrderId: order.manufacturingOrderId,
      manufacturingOrderLineId: fixture.stagingBegin.rootLineId,
      productId: 'staging-finished',
      locationId: 'canary-location',
      sublocation: '',
      quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['STAGING-SERIAL'] },
    }];
    orders.set(order.manufacturingOrderId, order);
  };
  return {
    fixture, scenario, runtimeMaterial, client, orders, completeManualStaging,
    setExternalBulkDrift: (value: number) => { externalBulkDrift = value; },
    moveBulkInventoryLocation: (locationId: string) => { bulkInventoryLocation = locationId; },
    setExternalStructuralDrift: (value: number) => { externalStructuralDrift = value; },
    driftStructuralAfterStockDispatches: () => {
      driftStructuralAfterStockDispatches = true;
    },
  };
}

async function advanceFullV2HarnessToNegativeStage(
  harness: ReturnType<typeof fullV2ProviderHarness>,
  stateDir: string
) {
  const value = { ...config(), stateDir };
  const run = (approvals: any[]) => canary('runManufacturingPickBatchCanaryStateMachine')({
    config: value,
    client: harness.client,
    scenario: harness.scenario,
    approvals,
    runtimeMaterial: harness.runtimeMaterial,
  });
  let result = await run([]);
  result = await run([stageApprovalV2(
    value,
    result.checkpoint,
    'create',
    result.stagePlan.stagePlanHash,
    harness.scenario.approvedInertArtifactIds
  )]);
  result = await run([stageApprovalV2(
    value,
    result.checkpoint,
    'stock-move',
    result.stagePlan.stagePlanHash,
    harness.scenario.approvedInertArtifactIds
  )]);
  expect(result.stage).toBe('negative-probes');
  return { value, run, result };
}

describe('manufacturing pick-batch live canary v2 protocol', () => {
  it('accepts only strict two-subject v2 manifests and refuses v1/raw response expectations', () => {
    const parse = canary('parseManufacturingPickBatchCanaryScenarioV2');
    const fixture = v2Fixture();
    const parsed = parse(JSON.stringify(fixture.scenario));
    expect(parsed.subjects.complete.beginInput.identity.finishedProductId).toBe('complete-finished');
    expect(parsed.subjects.staging.beginInput.identity.finishedProductId).toBe('staging-finished');
    expect(() => parse(JSON.stringify(scenarioManifest()))).toThrow('CANARY_V1_SCENARIO_NOT_LIVE_EXECUTABLE');
    expect(() => parse(JSON.stringify({ ...fixture.scenario, read: { expected: {} } }))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_V2_INVALID'
    );
    const reused = structuredClone(fixture.scenario) as any;
    reused.subjects.staging.beginInput = reused.subjects.complete.beginInput;
    expect(() => parse(JSON.stringify(reused))).toThrow('CANARY_SUBJECT_IDENTITIES_MUST_BE_DISTINCT');
    const wrongAllowlist = structuredClone(fixture.scenario) as any;
    wrongAllowlist.approvedInertArtifactIds = ['wrong-complete', 'wrong-staging'];
    expect(() => parse(JSON.stringify(wrongAllowlist))).toThrow(
      'approvedInertArtifactIds must exactly equal the two deterministic manufacturing order IDs'
    );
  });

  it('builds independent create and stock plans from full expanded shapes and binds planner/baseline hashes', () => {
    const fixture = v2Fixture();
    const buildCreate = canary('buildCreateStagePlan');
    const create = buildCreate(fixture.scenario);
    expect(create.subjects.complete.manufacturingOrderId).not.toBe(create.subjects.staging.manufacturingOrderId);
    expect(create.subjects.complete.requestHash).toMatch(/^[a-f0-9]{64}$/);
    const buildStock = canary('buildStockMoveStagePlan');
    const stock = buildStock({
      scenario: fixture.scenario,
      expanded: { complete: fixture.complete, staging: fixture.staging },
      intents: { complete: fixture.completeIntents, staging: fixture.stagingIntents },
      inventorySummaryProjection: [{ productId: 'component', quantityOnHand: '4' }],
      serialInventoryProjection: [{ productId: 'component', serial: 'COMPONENT-A', holdings: [] }],
    });
    expect(stock.subjects.complete.mode).toBe('complete');
    expect(stock.subjects.staging.mode).toBe('operation-staging');
    expect(stock.subjects.complete.expectedPostHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stock.inventoryBaselineHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stock.serialBaselineHash).toMatch(/^[a-f0-9]{64}$/);
    const wrongShape = structuredClone(fixture.complete);
    wrongShape.lines[0]!.manufacturingOrderOperations = structuredClone(
      fixture.staging.lines[0]!.manufacturingOrderOperations
    );
    wrongShape.lines[0]!.manufacturingOrderOperations.forEach((operation) => {
      operation.manufacturingOrderLineId = fixture.completeBegin.rootLineId;
    });
    expect(() => buildStock({
      scenario: fixture.scenario,
      expanded: { complete: wrongShape, staging: fixture.staging },
      intents: { complete: fixture.completeIntents, staging: fixture.stagingIntents },
      inventorySummaryProjection: [],
      serialInventoryProjection: [],
    })).toThrow('CANARY_COMPLETE_SUBJECT_OPERATIONS_PRESENT');
  });

  it('verifies planner-derived canonical post-state and a separately advanced rowversion', () => {
    const fixture = v2Fixture();
    const stock = canary('buildStockMoveStagePlan')({
      scenario: fixture.scenario,
      expanded: { complete: fixture.complete, staging: fixture.staging },
      intents: { complete: fixture.completeIntents, staging: fixture.stagingIntents },
      inventorySummaryProjection: [],
      serialInventoryProjection: [],
    });
    const verify = canary('verifyManufacturingPickBatchPostWrite');
    const completeActual = structuredClone(stock.subjects.complete.request.body);
    completeActual.timestamp = '11';
    completeActual.modifiedDate = 'provider-volatile';
    expect(verify('complete', completeActual, stock.subjects.complete)).toBe(true);
    expect(() => verify('complete', { ...completeActual, timestamp: '10' }, stock.subjects.complete)).toThrow(
      'CANARY_ROWVERSION_DID_NOT_ADVANCE'
    );
    const stagingActual = structuredClone(stock.subjects.staging.request.body);
    stagingActual.timestamp = '21';
    expect(verify('staging', stagingActual, stock.subjects.staging)).toBe(true);
    stagingActual.putLines = [{ manufacturingOrderPutLineId: 'unexpected' }];
    expect(() => verify('staging', stagingActual, stock.subjects.staging)).toThrow(
      'CANARY_EXPECTED_POST_STATE_MISMATCH'
    );
  });

  it('binds stale and serial-exclusion requests and requires unchanged no-write projections', () => {
    const fixture = v2Fixture();
    const stale = canary('buildStaleRowversionProbeRequest')(
      fixture.complete,
      '9',
      'approved-nonce'
    );
    expect(stale.body.timestamp).toBe('9');
    expect(stale.body.remarks).toContain('approved-nonce');
    const unchanged = canary('verifyDefinitiveNoWrite');
    expect(unchanged(fixture.complete, { ...fixture.complete, modifiedDate: 'volatile' })).toBe(true);
    expect(() => unchanged(fixture.complete, { ...fixture.complete, status: 'changed' })).toThrow(
      'CANARY_REJECTION_CHANGED_STATE'
    );

    const stock = canary('buildStockMoveStagePlan')({
      scenario: fixture.scenario,
      expanded: { complete: fixture.complete, staging: fixture.staging },
      intents: { complete: fixture.completeIntents, staging: fixture.stagingIntents },
      inventorySummaryProjection: [],
      serialInventoryProjection: [],
    });
    const staged = structuredClone(stock.subjects.staging.request.body);
    const rawLineId = fixture.stagingIntents[0]!.rawLineId;
    const exclusion = canary('buildSerialExclusionProbeRequest');
    expect(() => exclusion(staged, {
      productId: fixture.stagingIntents[0]!.productId,
      serial: 'COMPONENT-A',
      rawLineId,
      reason: 'already allocated',
      approvedComponentSerials: ['COMPONENT-A', 'COMPONENT-B'],
    })).toThrow('CANARY_SERIAL_EXCLUSION_USES_APPROVED_COMPONENT_SERIAL');
    const request = exclusion(staged, {
      productId: fixture.stagingIntents[0]!.productId,
      serial: 'CANARY-SENTINEL',
      rawLineId,
      reason: 'wrong product ownership',
      approvedComponentSerials: ['COMPONENT-A', 'COMPONENT-B'],
    });
    expect(JSON.stringify(request.body)).toContain('CANARY-SENTINEL');
  });

  it('keeps stable replay/manual verification read-only and validates manual completion semantics', async () => {
    const fixture = v2Fixture();
    const client = { get: vi.fn(async () => fixture.staging) };
    const read = canary('readCanaryManufacturingOrder');
    await read(client, fixture.stagingBegin.manufacturingOrderId);
    expect(client.get).toHaveBeenCalledWith(
      `/manufacturing-orders/${fixture.stagingBegin.manufacturingOrderId}`,
      { include: [
        'lines',
        'lines.manufacturingOrderOperations',
        'pickLines',
        'pickMatchings',
        'putLines',
      ] }
    );
    expect((client as any).prepareMutation).toBeUndefined();

    const stock = canary('buildStockMoveStagePlan')({
      scenario: fixture.scenario,
      expanded: { complete: fixture.complete, staging: fixture.staging },
      intents: { complete: fixture.completeIntents, staging: fixture.stagingIntents },
      inventorySummaryProjection: [],
      serialInventoryProjection: [],
    });
    const manual = structuredClone(stock.subjects.staging.request.body);
    manual.isCompleted = true;
    manual.status = 'completed';
    manual.completedDate = '2026-07-31T00:00:00Z';
    manual.lines[0]!.manufacturingOrderOperations.forEach((operation: any) => {
      operation.completedDate = '2026-07-31T00:00:00Z';
    });
    manual.lines[0]!.quantity.serialNumbers = ['STAGING-SERIAL'];
    manual.putLines = [{
      manufacturingOrderPutLineId: 'manual-put',
      manufacturingOrderLineId: fixture.stagingBegin.rootLineId,
      productId: 'staging-finished',
      locationId: 'canary-location',
      sublocation: '',
      quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['STAGING-SERIAL'] },
    }];
    expect(canary('verifyManualCompletionRead')(manual, stock.subjects.staging, fixture.scenario.subjects.staging.output)).toBe(true);
    expect(() => canary('verifyManualCompletionRead')(
      { ...manual, putLines: [] },
      stock.subjects.staging,
      fixture.scenario.subjects.staging.output
    )).toThrow('CANARY_MANUAL_COMPLETION_PUT_MISMATCH');
  });

  it('refuses partial manufacturing-order traces even when the full include was requested', async () => {
    const fixture = v2Fixture();
    const read = canary('readCanaryManufacturingOrder');
    const partial = structuredClone(fixture.complete) as any;
    delete partial.pickMatchings;
    const client = { get: vi.fn(async () => partial) };
    await expect(read(client, fixture.completeBegin.manufacturingOrderId)).rejects.toThrow(
      'CANARY_FULL_MO_TRACE_INCOMPLETE'
    );

    const missingNested = structuredClone(fixture.staging) as any;
    delete missingNested.lines[0].manufacturingOrderOperations;
    client.get.mockResolvedValueOnce(missingNested);
    await expect(read(client, fixture.stagingBegin.manufacturingOrderId)).rejects.toThrow(
      'CANARY_FULL_MO_TRACE_INCOMPLETE'
    );

    const providerLeafShape = structuredClone(fixture.complete) as any;
    for (const leaf of providerLeafShape.lines[0].manufacturingOrderLines) {
      delete leaf.manufacturingOrderLines;
      delete leaf.manufacturingOrderOperations;
    }
    client.get.mockResolvedValueOnce(providerLeafShape);
    await expect(read(client, fixture.completeBegin.manufacturingOrderId)).resolves.toEqual(
      providerLeafShape
    );

    const providerNullLeafShape = structuredClone(fixture.complete) as any;
    for (const leaf of providerNullLeafShape.lines[0].manufacturingOrderLines) {
      leaf.manufacturingOrderLines = null;
      leaf.manufacturingOrderOperations = null;
    }
    client.get.mockResolvedValueOnce(providerNullLeafShape);
    await expect(read(client, fixture.completeBegin.manufacturingOrderId)).resolves.toEqual(
      providerNullLeafShape
    );
  });

  it('generates cleanup from the latest rowversion and requires exact stock/serial restoration', () => {
    const fixture = v2Fixture();
    const latest: any = structuredClone(fixture.complete);
    latest.timestamp = 'latest-rowversion';
    latest.status = 'completed';
    latest.isCompleted = true;
    latest.pickLines = [{ manufacturingOrderPickLineId: 'pick' }];
    latest.pickMatchings = [{ manufacturingOrderPickMatchingId: 'matching' }];
    latest.putLines = [{ manufacturingOrderPutLineId: 'put' }];
    latest.lines[0]!.quantity.serialNumbers = ['COMPLETE-SERIAL'];
    const cleanup = canary('planManufacturingPickBatchCanaryCleanup')(
      'complete', latest, fixture.complete
    );
    expect(cleanup.request.body.timestamp).toBe('latest-rowversion');
    expect(cleanup.request.body.pickLines).toEqual([]);
    expect(cleanup.request.body.pickMatchings).toEqual([]);
    expect(cleanup.request.body.putLines).toEqual([]);
    expect(cleanup.request.body.lines[0]!.quantity.serialNumbers).toEqual([]);
    const restore = canary('assertManufacturingPickBatchCanaryRestoration');
    expect(restore({ inventory: [{ quantity: '1' }], serials: [] }, { inventory: [{ quantity: '1' }], serials: [] })).toMatch(/^[a-f0-9]{64}$/);
    expect(() => restore({ inventory: [{ quantity: '1' }], serials: [] }, { inventory: [{ quantity: '0' }], serials: [] })).toThrow(
      'CANARY_BASELINE_RESTORATION_MISMATCH'
    );
  });

  it('persists an owner-only atomic dispatch fence and refuses redispatch after resume', async () => {
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-');
    paths.push(stateDir);
    const fixture = v2Fixture();
    const createInitial = canary('createManufacturingPickBatchCanaryCheckpoint');
    const record = canary('recordCanaryCheckpoint');
    const load = canary('loadManufacturingPickBatchCanaryCheckpoint');
    const reserve = canary('reserveCanaryDispatch');
    let checkpoint = createInitial(fixture.scenario);
    checkpoint = reserve(checkpoint, 'complete', 'create', 'a'.repeat(64), 'correlation-1');
    await record(stateDir, checkpoint);
    const resumed = await load(stateDir, fixture.scenario.scenarioId);
    expect(resumed.mutations['complete:create'].dispatchCount).toBe(1);
    expect(() => reserve(resumed, 'complete', 'create', 'a'.repeat(64), 'correlation-2')).toThrow(
      'CANARY_TWO_WRITE_FALLBACK_REFUSED'
    );
    const checkpointPath = join(
      stateDir, 'canaries', 'manufacturing-pick-batch', `${fixture.scenario.scenarioId}.json`
    );
    expect((await lstat(checkpointPath)).mode & 0o077).toBe(0);
  });

  it('fails closed on a pre-existing lock instead of unlinking a possibly replaced owner', async () => {
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-lock-');
    paths.push(stateDir);
    const fixture = v2Fixture();
    const lockDirectory = join(
      stateDir,
      'canaries',
      'manufacturing-pick-batch'
    );
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(
      lockDirectory,
      `${fixture.scenario.scenarioId}.json.lock`
    );
    await writeFile(lockPath, '{possibly-replaced', { mode: 0o600 });

    await expect(canary('withManufacturingPickBatchCanaryLock')(
      stateDir,
      fixture.scenario.scenarioId,
      async () => 'should-not-run'
    )).rejects.toThrow('CANARY_CHECKPOINT_LOCKED');
    expect(await lstat(lockPath)).toBeDefined();
  });

  it('discovers deterministic inert residuals and blocks mismatches or unreadable candidates', async () => {
    const fixture = v2Fixture();
    (fixture.complete as any).manufacturingOrderNumber = 'MO-CANARY-C';
    (fixture.staging as any).manufacturingOrderNumber = 'MO-CANARY-S';
    const expected = {
      complete: canary('planManufacturingPickBatchCanaryCleanup')('complete', fixture.complete, fixture.complete),
      staging: canary('planManufacturingPickBatchCanaryCleanup')('staging', fixture.staging, fixture.staging),
    };
    const baseGet = async (path: string) => {
        if (path.endsWith(fixture.completeBegin.manufacturingOrderId)) return fixture.complete;
        if (path.endsWith(fixture.stagingBegin.manufacturingOrderId)) return fixture.staging;
        if (path.endsWith('/summary')) {
          const productId = path.split('/').at(-2)!;
          return { productId, quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locationSummaries: [] };
        }
        if (path.startsWith('/products/')) return { productId: path.split('/').at(-1)!, inventoryLines: [] };
        throw new Error('unexpected read');
      };
    const getList = vi.fn(async (_path: string, options: any) => ({
      data: options.filters?.manufacturingOrderNumber
        ? [structuredClone(options.filters.manufacturingOrderNumber === 'MO-CANARY-C'
          ? fixture.complete
          : fixture.staging)]
        : [structuredClone(fixture.complete), structuredClone(fixture.staging)],
      totalCount: options.filters?.manufacturingOrderNumber ? 1 : 2,
    }));
    const client = {
      get: vi.fn(baseGet),
      getList,
    };
    const subjects = {
      complete: {
        manufacturingOrderId: fixture.completeBegin.manufacturingOrderId,
        expectedInertProjectionHash: expected.complete.expectedInertProjectionHash,
        coordinatorMarker: fixture.completeBegin.coordinatorMarker,
        finishedProductId: 'complete-finished',
      },
      staging: {
        manufacturingOrderId: fixture.stagingBegin.manufacturingOrderId,
        expectedInertProjectionHash: expected.staging.expectedInertProjectionHash,
        coordinatorMarker: fixture.stagingBegin.coordinatorMarker,
        finishedProductId: 'staging-finished',
      },
    };
    const inventoryScope = {
      productIds: ['complete-finished', 'staging-finished'],
      watchedSerials: [],
      expected: {
        inventory: [
          { productId: 'complete-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
          { productId: 'staging-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
        ],
        serials: [],
      },
    };
    const result = await canary('discoverManufacturingPickBatchResiduals')({
      client,
      subjects,
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope,
    });
    expect(result.possibleResidualIds).toEqual([]);
    expect(result.confirmedResidualIds).toEqual([
      fixture.completeBegin.manufacturingOrderId,
      fixture.stagingBegin.manufacturingOrderId,
    ].sort());
    const truncatedGetList = vi.fn(async (_path: string, options: any) => ({
      data: options.filters?.manufacturingOrderNumber
        ? [structuredClone(options.filters.manufacturingOrderNumber === 'MO-CANARY-C'
          ? fixture.complete
          : fixture.staging)]
        : [structuredClone(fixture.complete)],
      totalCount: options.filters?.manufacturingOrderNumber ? 1 : 2,
    }));
    const truncated = await canary('discoverManufacturingPickBatchResiduals')({
      client: { get: vi.fn(baseGet), getList: truncatedGetList },
      subjects,
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope,
    });
    expect(truncated.possibleResidualIds).toContain(
      `${fixture.completeBegin.manufacturingOrderId}:marker-query-unavailable`
    );
    expect(truncated.possibleResidualIds).toContain(
      `${fixture.stagingBegin.manufacturingOrderId}:marker-query-unavailable`
    );
    const mismatchClient = {
      get: vi.fn(async (path: string) => path.endsWith(fixture.completeBegin.manufacturingOrderId)
        ? { ...fixture.complete, status: 'unexpected' }
        : baseGet(path)),
      getList,
    };
    const mismatch = await canary('discoverManufacturingPickBatchResiduals')({
      client: mismatchClient,
      subjects,
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope,
    });
    expect(mismatch.possibleResidualIds).toContain(`${fixture.completeBegin.manufacturingOrderId}:semantic-mismatch`);
  });

  it('requires order-number, marker/product, and product inventory residual scans', async () => {
    const fixture = v2Fixture();
    (fixture.complete as any).manufacturingOrderNumber = 'MO-CANARY-C';
    (fixture.staging as any).manufacturingOrderNumber = 'MO-CANARY-S';
    const expected = {
      complete: canary('planManufacturingPickBatchCanaryCleanup')('complete', fixture.complete, fixture.complete),
      staging: canary('planManufacturingPickBatchCanaryCleanup')('staging', fixture.staging, fixture.staging),
    };
    const getList = vi.fn(async (_path: string, options: any) => {
      if (!options.filters?.manufacturingOrderNumber) {
        return { data: [structuredClone(fixture.complete), structuredClone(fixture.staging)], totalCount: 2 };
      }
      const order = options.filters.manufacturingOrderNumber === 'MO-CANARY-C'
        ? fixture.complete
        : fixture.staging;
      return { data: [structuredClone(order)], totalCount: 1 };
    });
    const get = vi.fn(async (path: string) => {
      if (path === `/manufacturing-orders/${fixture.completeBegin.manufacturingOrderId}`) return structuredClone(fixture.complete);
      if (path === `/manufacturing-orders/${fixture.stagingBegin.manufacturingOrderId}`) return structuredClone(fixture.staging);
      if (path.endsWith('/summary')) {
        const productId = path.split('/').at(-2)!;
        return {
          productId,
          quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0',
          locationSummaries: [],
        };
      }
      if (path.startsWith('/products/')) {
        return { productId: path.split('/').at(-1)!, inventoryLines: [] };
      }
      throw new Error(`unexpected ${path}`);
    });
    const result = await canary('discoverManufacturingPickBatchResiduals')({
      client: { get, getList },
      subjects: {
        complete: {
          manufacturingOrderId: fixture.completeBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.complete.expectedInertProjectionHash,
          coordinatorMarker: fixture.completeBegin.coordinatorMarker,
          finishedProductId: 'complete-finished',
        },
        staging: {
          manufacturingOrderId: fixture.stagingBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.staging.expectedInertProjectionHash,
          coordinatorMarker: fixture.stagingBegin.coordinatorMarker,
          finishedProductId: 'staging-finished',
        },
      },
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope: {
        productIds: ['complete-finished', 'staging-finished'],
        watchedSerials: [],
        expected: {
          inventory: [
            { productId: 'complete-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
            { productId: 'staging-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
          ],
          serials: [],
        },
      },
    });
    expect(result.possibleResidualIds).toEqual([]);
    expect(getList).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledWith('/products/complete-finished', { include: ['inventoryLines'] });

    const unsupported = await canary('discoverManufacturingPickBatchResiduals')({
      client: { get },
      subjects: {
        complete: {
          manufacturingOrderId: fixture.completeBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.complete.expectedInertProjectionHash,
          coordinatorMarker: fixture.completeBegin.coordinatorMarker,
          finishedProductId: 'complete-finished',
        },
        staging: {
          manufacturingOrderId: fixture.stagingBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.staging.expectedInertProjectionHash,
          coordinatorMarker: fixture.stagingBegin.coordinatorMarker,
          finishedProductId: 'staging-finished',
        },
      },
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope: {
        productIds: [], watchedSerials: [], expected: { inventory: [], serials: [] },
      },
    });
    expect(unsupported.possibleResidualIds).toContain('residual-query:manufacturing-order-list-unsupported');
  });

  it('treats provider MO list filters as candidates and requires exact client-side matches', async () => {
    const fixture = v2Fixture();
    (fixture.complete as any).manufacturingOrderNumber = 'MO-CANARY-C';
    (fixture.staging as any).manufacturingOrderNumber = 'MO-CANARY-S';
    const expected = {
      complete: canary('planManufacturingPickBatchCanaryCleanup')('complete', fixture.complete, fixture.complete),
      staging: canary('planManufacturingPickBatchCanaryCleanup')('staging', fixture.staging, fixture.staging),
    };
    const get = vi.fn(async (path: string) => {
      if (path === `/manufacturing-orders/${fixture.completeBegin.manufacturingOrderId}`) return structuredClone(fixture.complete);
      if (path === `/manufacturing-orders/${fixture.stagingBegin.manufacturingOrderId}`) return structuredClone(fixture.staging);
      if (path.endsWith('/summary')) {
        const productId = path.split('/').at(-2)!;
        return {
          productId,
          quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0',
          locationSummaries: [],
        };
      }
      if (path.startsWith('/products/')) return { productId: path.split('/').at(-1)!, inventoryLines: [] };
      throw new Error(`unexpected ${path}`);
    });
    const makeCandidates = (exact: any) => {
      const candidate = structuredClone(exact);
      candidate.manufacturingOrderId = `candidate-${exact.manufacturingOrderId}`;
      candidate.manufacturingOrderNumber = `${exact.manufacturingOrderNumber}-PREFIX`;
      candidate.remarks = `prefix-${exact.remarks}-suffix`;
      const wrongProductCandidate = structuredClone(exact);
      wrongProductCandidate.manufacturingOrderId = `wrong-product-${exact.manufacturingOrderId}`;
      wrongProductCandidate.primaryFinishedProductId = `wrong-${exact.primaryFinishedProductId}`;
      return { candidate, wrongProductCandidate };
    };
    const getList = vi.fn(async (_path: string, options: any) => {
      if (!options.filters?.manufacturingOrderNumber) {
        const complete = makeCandidates(fixture.complete);
        const staging = makeCandidates(fixture.staging);
        const data = [
          complete.candidate,
          complete.wrongProductCandidate,
          structuredClone(fixture.complete),
          staging.candidate,
          staging.wrongProductCandidate,
          structuredClone(fixture.staging),
        ];
        return { data, totalCount: data.length };
      }
      const exact = (options.filters.manufacturingOrderNumber === 'MO-CANARY-C'
        ? fixture.complete
        : fixture.staging) as any;
      const { candidate } = makeCandidates(exact);
      return {
        data: [candidate, structuredClone(exact)],
        totalCount: 2,
      };
    });
    const result = await canary('discoverManufacturingPickBatchResiduals')({
      client: { get, getList },
      subjects: {
        complete: {
          manufacturingOrderId: fixture.completeBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.complete.expectedInertProjectionHash,
          coordinatorMarker: fixture.completeBegin.coordinatorMarker,
          finishedProductId: 'complete-finished',
        },
        staging: {
          manufacturingOrderId: fixture.stagingBegin.manufacturingOrderId,
          expectedInertProjectionHash: expected.staging.expectedInertProjectionHash,
          coordinatorMarker: fixture.stagingBegin.coordinatorMarker,
          finishedProductId: 'staging-finished',
        },
      },
      approvedInertArtifactIds: [fixture.completeBegin.manufacturingOrderId, fixture.stagingBegin.manufacturingOrderId],
      inventoryScope: {
        productIds: ['complete-finished', 'staging-finished'],
        watchedSerials: [],
        expected: {
          inventory: [
            { productId: 'complete-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
            { productId: 'staging-finished', quantityOnHand: '0', quantityAvailable: '0', quantityOnOrder: '0', quantityAllocated: '0', locations: [] },
          ],
          serials: [],
        },
      },
    });
    expect(result.possibleResidualIds).toEqual([]);
  });

  it('parses the env-driven v2 CLI boundary without provider calls before create approval', async () => {
    const fixture = v2Fixture();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-env-');
    paths.push(stateDir);
    const client = {
      telemetrySnapshot: () => budget,
      get: vi.fn(),
      getList: vi.fn(),
      prepareMutation: vi.fn(),
    };
    const result = await canary('runManufacturingPickBatchCanaryCliFromEnvironment')({
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_SCENARIO_JSON: JSON.stringify(fixture.scenario),
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_APPROVALS_JSON: '[]',
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_RUNTIME_MATERIAL_JSON: '{}',
    }, {
      loadConfig: () => ({ ...config(), stateDir }),
      createClient: () => client,
    });
    expect(result.status).toBe('approval-required');
    expect(result.stage).toBe('create');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.prepareMutation).not.toHaveBeenCalled();
  });

  it('accepts only an exact predeclared 400 serial rejection and proves state remains unchanged', async () => {
    const harness = fullV2ProviderHarness();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-serial-400-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(harness, stateDir);
    const stagingId = harness.fixture.stagingBegin.manufacturingOrderId;
    const before = structuredClone(harness.orders.get(stagingId));
    const result = await run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.status).toBe('waiting-manual-completion');
    expect(harness.orders.get(stagingId)).toEqual(before);
    expect(result.checkpoint.mutations['staging:serial-exclusion']!.rawResponseEvidence).toEqual({
      name: 'InflowApiError',
      statusCode: 400,
      code: 'NegativeSerialNumberInventory',
    });
  });

  it('accepts an exact predeclared 400 serial rejection with no provider code', async () => {
    const harness = fullV2ProviderHarness({
      serialApiRejection: { statusCode: 400 },
    });
    harness.runtimeMaterial.negativeProbes.serialExclusion.expectedRejection = {
      statusCode: 400,
      code: null,
    } as any;
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-serial-400-null-code-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(harness, stateDir);
    const stagingId = harness.fixture.stagingBegin.manufacturingOrderId;
    const before = structuredClone(harness.orders.get(stagingId));
    const result = await run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.status).toBe('waiting-manual-completion');
    expect(harness.orders.get(stagingId)).toEqual(before);
    expect(result.checkpoint.mutations['staging:serial-exclusion']!.rawResponseEvidence).toEqual({
      name: 'InflowApiError',
      statusCode: 400,
      code: null,
    });
  });

  it('accepts an exact stale-rowversion rejection with no provider code', async () => {
    const harness = fullV2ProviderHarness({
      staleApiRejection: { statusCode: 409 },
    });
    harness.runtimeMaterial.negativeProbes.staleExpectedRejection = {
      statusCode: 409,
      code: null,
    } as any;
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-stale-null-code-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(harness, stateDir);
    expect(pending.stagePlan.stale.expectedRejection.code).toBeNull();
    const result = await run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.checkpoint.mutations['complete:stale-rowversion']!.rawResponseEvidence).toEqual({
      name: 'InflowApiError',
      statusCode: 409,
      code: null,
    });
  });

  it('uses authoritative inventory lines when provider summaries omit location buckets', async () => {
    const harness = fullV2ProviderHarness({ omitLocationSummaries: true });
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-inventory-lines-');
    paths.push(stateDir);
    const { result } = await advanceFullV2HarnessToNegativeStage(harness, stateDir);
    expect(result.stage).toBe('negative-probes');
    expect(result.checkpoint.state).toBe('stock_verified');
  });

  it('fails closed when provider inventory lines are absent', async () => {
    const harness = fullV2ProviderHarness({
      omitLocationSummaries: true,
      omitInventoryLinesFor: 'bulk-component',
    });
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-missing-inventory-lines-');
    paths.push(stateDir);
    await expect(
      advanceFullV2HarnessToNegativeStage(harness, stateDir)
    ).rejects.toThrow('CANARY_INVENTORY_LINES_MISSING: bulk-component');
  });

  it('refuses pre-dispatch bulk location drift when summaries omit location buckets', async () => {
    const harness = fullV2ProviderHarness({ omitLocationSummaries: true });
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-inventory-line-drift-');
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const run = (approvals: any[]) => canary('runManufacturingPickBatchCanaryStateMachine')({
      config: value,
      client: harness.client,
      scenario: harness.scenario,
      approvals,
      runtimeMaterial: harness.runtimeMaterial,
    });
    let result = await run([]);
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'create',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    harness.moveBulkInventoryLocation('different-location');
    const preparesBeforeStock = harness.client.prepareMutation.mock.calls.length;
    await expect(run([stageApprovalV2(
      value,
      result.checkpoint,
      'stock-move',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )])).rejects.toThrow('CANARY_STOCK_BASELINE_DRIFT');
    expect(harness.client.prepareMutation.mock.calls.length).toBe(preparesBeforeStock);
  });

  it.each([
    ['status', { statusCode: 409, code: 'NegativeSerialNumberInventory' }],
    ['code', { statusCode: 400, code: 'WrongSerialCode' }],
  ])('rejects a serial exclusion with the wrong exact %s', async (_label, expectedRejection) => {
    const harness = fullV2ProviderHarness();
    harness.runtimeMaterial.negativeProbes.serialExclusion.expectedRejection = expectedRejection;
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-serial-mismatch-');
    paths.push(stateDir);
    await expect(
      advanceFullV2HarnessToNegativeStage(harness, stateDir)
    ).rejects.toThrow('CANARY_SERIAL_CONTENTION_REJECTION_REQUIRED');
  });

  it('persists exact observed rejection evidence when the predeclared serial rejection differs', async () => {
    const harness = fullV2ProviderHarness({
      serialApiRejection: { statusCode: 422, code: 'ActualProviderSerialCode' },
    });
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-rejection-evidence-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(
      harness,
      stateDir
    );
    await expect(run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )])).rejects.toThrow(
      'CANARY_REJECTION_EVIDENCE_MISMATCH: staging:serial-exclusion:status'
    );
    const checkpoint = await canary('loadManufacturingPickBatchCanaryCheckpoint')(
      stateDir,
      harness.scenario.scenarioId
    );
    expect(checkpoint.mutations['staging:serial-exclusion']).toMatchObject({
      outcome: 'failed_uncertain',
      rawResponseEvidence: {
        name: 'InflowApiError',
        statusCode: 422,
        code: 'ActualProviderSerialCode',
      },
      rawResponseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('does not fabricate provider rejection evidence when a rejection probe unexpectedly writes', async () => {
    const harness = fullV2ProviderHarness({ allowSerialContentionWrite: true });
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-rejection-unexpected-write-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(
      harness,
      stateDir
    );
    await expect(run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )])).rejects.toThrow(
      'CANARY_EXPECTED_REJECTION_NOT_OBSERVED: staging:serial-exclusion'
    );
    const checkpoint = await canary('loadManufacturingPickBatchCanaryCheckpoint')(
      stateDir,
      harness.scenario.scenarioId
    );
    expect(checkpoint.mutations['staging:serial-exclusion']).toMatchObject({
      outcome: 'failed_uncertain',
      dispatchCount: 1,
    });
    expect(checkpoint.mutations['staging:serial-exclusion'].rawResponseEvidence).toBeUndefined();
    expect(checkpoint.mutations['staging:serial-exclusion'].rawResponseHash).toBeUndefined();
  });

  it('fails closed on resume when persisted definitive-rejection evidence has a different status/code', async () => {
    const harness = fullV2ProviderHarness();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-serial-resume-');
    paths.push(stateDir);
    const { value, run, result: pending } = await advanceFullV2HarnessToNegativeStage(harness, stateDir);
    const completed = await run([stageApprovalV2(
      value,
      pending.checkpoint,
      'negative-probes',
      pending.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    const resumed = structuredClone(completed.checkpoint);
    resumed.state = 'stock_verified';
    const record = resumed.mutations['staging:serial-exclusion']!;
    record.rawResponseEvidence = {
      name: 'InflowApiError',
      statusCode: 409,
      code: 'WrongPersistedCode',
    };
    record.rawResponseHash = canonicalHash(
      record.rawResponseEvidence,
      'manufacturing-pick-batch-canary/raw-rejection-response/v2'
    );
    const { checkpointHash: _discarded, ...payload } = resumed;
    resumed.checkpointHash = canonicalHash(payload, 'manufacturing-pick-batch-canary/checkpoint/v2');
    await canary('recordCanaryCheckpoint')(stateDir, resumed);
    const preparesBeforeResume = harness.client.prepareMutation.mock.calls.length;
    await expect(run([])).rejects.toThrow('CANARY_REJECTION_RESUME_AMBIGUOUS');
    expect(harness.client.prepareMutation.mock.calls.length).toBe(preparesBeforeResume);
  });

  it('persists sanitized provider error evidence for failed applied mutations', async () => {
    const harness = fullV2ProviderHarness();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-applied-error-');
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const run = (approvals: any[]) => canary('runManufacturingPickBatchCanaryStateMachine')({
      config: value,
      client: harness.client,
      scenario: harness.scenario,
      approvals,
      runtimeMaterial: harness.runtimeMaterial,
    });
    let result = await run([]);
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'create',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    const originalPrepare = harness.client.prepareMutation.getMockImplementation()!;
    const rejection = new InflowApiError('provider rejected stock move', 422, {
      code: 'ProviderRejectedStockMove',
      message: 'provider rejected stock move',
    });
    harness.client.prepareMutation.mockImplementationOnce(async (
      method: string,
      path: string,
      options: any
    ) => {
      const prepared = await originalPrepare(method, path, options);
      return {
        ...prepared,
        dispatch: vi.fn(async () => {
          throw rejection;
        }),
      };
    });
    await expect(run([stageApprovalV2(
      value,
      result.checkpoint,
      'stock-move',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )])).rejects.toBe(rejection);
    const checkpoint = await canary('loadManufacturingPickBatchCanaryCheckpoint')(
      stateDir,
      harness.scenario.scenarioId
    );
    expect(checkpoint.mutations['complete:stock-move']).toMatchObject({
      outcome: 'failed_uncertain',
      rawResponseEvidence: {
        name: 'InflowApiError',
        message: 'provider rejected stock move',
        statusCode: 422,
        code: 'ProviderRejectedStockMove',
        apiMessage: 'provider rejected stock move',
      },
      rawResponseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const completePlan = checkpoint.stagePlans['stock-move'].subjects.complete;
    const externallyApplied = structuredClone(completePlan.request.body);
    externallyApplied.timestamp = (
      BigInt(`0x${completePlan.beginTimestamp}`) + 1n
    ).toString(16).toUpperCase();
    harness.orders.set(
      harness.fixture.completeBegin.manufacturingOrderId,
      externallyApplied
    );
    const preparesBeforeRecovery = harness.client.prepareMutation.mock.calls.length;
    const recovered = await run([]);
    expect(recovered.checkpoint.mutations['complete:stock-move']?.outcome).toBe('recovered');
    expect(recovered.checkpoint.mutations['staging:stock-move']?.outcome).toBe('applied');
    expect(harness.client.prepareMutation.mock.calls.length).toBe(preparesBeforeRecovery + 1);
  });

  it('rejects unsupported negative-probe statuses in runtime material', () => {
    const harness = fullV2ProviderHarness();
    const parse = canary('parseManufacturingPickBatchCanaryRuntimeMaterialV2');
    expect(parse(JSON.stringify(harness.runtimeMaterial)).negativeProbes.serialExclusion.expectedRejection).toEqual({
      statusCode: 400,
      code: 'NegativeSerialNumberInventory',
    });
    const unsupported = structuredClone(harness.runtimeMaterial);
    unsupported.negativeProbes.serialExclusion.expectedRejection.statusCode = 418;
    expect(() => parse(JSON.stringify(unsupported))).toThrow('CANARY_RUNTIME_MATERIAL_INVALID');
    const emptyCode = structuredClone(harness.runtimeMaterial);
    emptyCode.negativeProbes.staleExpectedRejection.code = '   ';
    expect(() => parse(JSON.stringify(emptyCode))).toThrow('CANARY_RUNTIME_MATERIAL_INVALID');
    for (const statusCode of [400, 409, 412, 422]) {
      const allowed = structuredClone(harness.runtimeMaterial);
      allowed.negativeProbes.serialExclusion.expectedRejection.statusCode = statusCode;
      expect(parse(JSON.stringify(allowed)).negativeProbes.serialExclusion.expectedRejection.statusCode).toBe(statusCode);
    }
  });

  it('runs stock through attest and refuses post-approval MO/inventory drift before issuance', async () => {
    const harness = fullV2ProviderHarness({
      retainZeroOutputInventoryLines: true,
      serialApiRejection: { statusCode: 400 },
    });
    harness.runtimeMaterial.negativeProbes.serialExclusion.expectedRejection = {
      statusCode: 400,
      code: null,
    } as any;
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-full-');
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const run = (approvals: any[]) => canary('runManufacturingPickBatchCanaryStateMachine')({
      config: value,
      client: harness.client,
      scenario: harness.scenario,
      approvals,
      runtimeMaterial: harness.runtimeMaterial,
    });
    let result = await run([]);
    expect(result.stage).toBe('create');
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'create',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.stage).toBe('stock-move');
    expect(result.checkpoint.evidence.stockScope.productIds).toContain(
      'expanded-subassembly-product'
    );
    expect(result.checkpoint.evidence.structuralInventory).toMatchObject({
      productIds: ['expanded-subassembly-product'],
      baselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'stock-move',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.stage).toBe('negative-probes');
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'negative-probes',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.status).toBe('waiting-manual-completion');
    harness.completeManualStaging();
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'manual-completion-read',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.stage).toBe('cleanup');
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'cleanup',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    expect(result.stage).toBe('attest');
    const attestApproval = stageApprovalV2(
      value,
      result.checkpoint,
      'attest',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    );
    const readsBeforeAttest = harness.client.get.mock.calls.length;
    const completeId = harness.fixture.completeBegin.manufacturingOrderId;
    const inertComplete = structuredClone(harness.orders.get(completeId));
    harness.orders.set(completeId, { ...inertComplete, status: 'external-drift' });
    await expect(run([attestApproval])).rejects.toThrow('CANARY_ATTEST_RESIDUAL_DRIFT');
    harness.orders.set(completeId, inertComplete);
    harness.setExternalBulkDrift(1);
    await expect(run([attestApproval])).rejects.toThrow('CANARY_BASELINE_RESTORATION_MISMATCH');
    expect(harness.client.get.mock.calls.length).toBeGreaterThan(readsBeforeAttest);
    harness.setExternalBulkDrift(0);
    harness.client.get.mockClear();
    harness.client.getList.mockClear();
    harness.client.telemetrySnapshot = () => ({
      ...budget,
      rateLimiter: {
        ...budget.rateLimiter,
        availableTokens:
          harness.client.get.mock.calls.length + harness.client.getList.mock.calls.length > 0
            ? 0
            : 20,
      },
    });
    result = await run([attestApproval]);
    expect(result.status).toBe('attested');
    expect(result.attestationIssued).toBe(true);

    const freshCheckpoint = await canary('loadManufacturingPickBatchCanaryCheckpoint')(
      stateDir,
      harness.scenario.scenarioId
    );
    expect(freshCheckpoint.state).toBe('attested');
  });

  it('fails closed when structural subassembly inventory moves during stock dispatch', async () => {
    const harness = fullV2ProviderHarness();
    harness.driftStructuralAfterStockDispatches();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-structural-drift-');
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const run = (approvals: any[]) => canary('runManufacturingPickBatchCanaryStateMachine')({
      config: value,
      client: harness.client,
      scenario: harness.scenario,
      approvals,
      runtimeMaterial: harness.runtimeMaterial,
    });
    let result = await run([]);
    result = await run([stageApprovalV2(
      value,
      result.checkpoint,
      'create',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )]);
    await expect(run([stageApprovalV2(
      value,
      result.checkpoint,
      'stock-move',
      result.stagePlan.stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    )])).rejects.toThrow('CANARY_STRUCTURAL_INVENTORY_CHANGED: stock-move');
  });

  it('revalidates persisted stage authorization against the current build identity', async () => {
    const harness = fullV2ProviderHarness();
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-authorization-');
    paths.push(stateDir);
    const value = { ...config(), stateDir };
    const checkpoint = canary('createManufacturingPickBatchCanaryCheckpoint')(
      harness.scenario
    );
    const stagePlanHash = checkpoint.stagePlans.create.stagePlanHash;
    const approval = stageApprovalV2(
      value,
      checkpoint,
      'create',
      stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    );
    const authorized = await canary('authorizeStage')({
      config: value,
      client: harness.client,
      approvals: [approval],
      checkpoint,
      scenario: harness.scenario,
      stage: 'create',
      stagePlanHash,
    });

    await expect(canary('authorizeStage')({
      config: { ...value, probeBuild: 'different-probe-build' },
      client: harness.client,
      approvals: [],
      checkpoint: authorized,
      scenario: harness.scenario,
      stage: 'create',
      stagePlanHash,
    })).rejects.toThrow('CANARY_STAGE_APPROVAL_IDENTITY_MISMATCH: probeBuild');

    const currentBuild = { ...value, probeBuild: 'different-probe-build' };
    const currentApproval = stageApprovalV2(
      currentBuild,
      authorized,
      'create',
      stagePlanHash,
      harness.scenario.approvedInertArtifactIds
    );
    const rebound = await canary('authorizeStage')({
      config: currentBuild,
      client: harness.client,
      approvals: [currentApproval],
      checkpoint: authorized,
      scenario: harness.scenario,
      stage: 'create',
      stagePlanHash,
    });
    expect((rebound.evidence.stageAuthorizations as any).create.approval.probeBuild)
      .toBe('different-probe-build');
  });

  it('rejects any mutation dispatch count above one and classifies transport ambiguity as terminal', () => {
    const assertCounts = canary('assertManufacturingPickBatchCanaryDispatchCounts');
    expect(assertCounts({
      'complete:create': { dispatchCount: 1 },
      'staging:stable-replay': { dispatchCount: 0 },
    })).toBe(true);
    expect(() => assertCounts({ 'complete:create': { dispatchCount: 2 } })).toThrow(
      'CANARY_TWO_WRITE_FALLBACK_REFUSED'
    );
    expect(canary('isManufacturingPickBatchTransportAmbiguous')(new TypeError('lost'))).toBe(true);
    expect(canary('isManufacturingPickBatchTransportAmbiguous')(new InflowApiError('timeout', 408))).toBe(true);
    expect(canary('isManufacturingPickBatchTransportAmbiguous')(new InflowApiError('conflict', 409))).toBe(false);
  });

  it('executes normal deterministic creates with durable pre-dispatch fences and no response-loss requirement', async () => {
    const stateDir = await mkdtemp('/tmp/inflow-canary-v2-state-machine-');
    paths.push(stateDir);
    const fixture = v2Fixture();
    const value = { ...config(), stateDir };
    const initial = canary('createManufacturingPickBatchCanaryCheckpoint')(fixture.scenario);
    const createPlan = initial.stagePlans.create;
    const baseHost = new URL(value.baseUrl).host.toLowerCase();
    const createApproval = {
      schemaVersion: 'manufacturing-pick-batch-canary-stage-approval/v1',
      approved: true,
      approvalNonce: 'create-stage-approval',
      stage: 'create',
      tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, baseHost),
      baseHost,
      apiVersion: value.apiVersion,
      probeBuild: value.probeBuild,
      adapterManifestHash: value.adapterManifestHash,
      serializerVersion: SERIALIZER_VERSION,
      contractVersion: MUTATION_CONTRACT_VERSION,
      scenarioManifestHash: initial.scenarioManifestHash,
      checkpointHash: initial.checkpointHash,
      stagePlanHash: createPlan.stagePlanHash,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      approvedInertArtifactIds: fixture.scenario.approvedInertArtifactIds,
    };
    const available = new Set<string>();
    const byId = new Map([
      [fixture.completeBegin.manufacturingOrderId, fixture.complete],
      [fixture.stagingBegin.manufacturingOrderId, fixture.staging],
    ]);
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: any) => {
      const id = options.body.manufacturingOrderId as string;
      return {
        correlationId: `correlation-${id}`,
        dispatch: vi.fn(async () => {
          const fenced = await canary('loadManufacturingPickBatchCanaryCheckpoint')(
            stateDir,
            fixture.scenario.scenarioId
          );
          const kind = id === fixture.completeBegin.manufacturingOrderId ? 'complete' : 'staging';
          expect(fenced.mutations[`${kind}:create`].outcome).toBe('dispatch-barrier');
          available.add(id);
          return { provider: 'normal-success-with-volatile-response' };
        }),
      };
    });
    const client = {
      telemetrySnapshot: () => budget,
      prepareMutation,
      get: vi.fn(async (path: string) => {
        const id = path.split('/').at(-1)!;
        if (!available.has(id)) throw new InflowApiError('not found', 404);
        return structuredClone(byId.get(id)!);
      }),
    };
    const result = await canary('runManufacturingPickBatchCanaryStateMachine')({
      config: value,
      client,
      scenario: fixture.scenario,
      approvals: [createApproval],
      runtimeMaterial: {},
    });
    expect(result.status).toBe('stage-input-required');
    expect(result.checkpoint.state).toBe('expanded_verified');
    expect(prepareMutation).toHaveBeenCalledTimes(2);
    expect(result.checkpoint.mutations['complete:create'].dispatchCount).toBe(1);
    expect(result.checkpoint.mutations['staging:create'].dispatchCount).toBe(1);
    expect(result.checkpoint.mutations['complete:create'].outcome).toBe('applied');
    expect(result.checkpoint.mutations['staging:create'].outcome).toBe('applied');
    expect(client.get).toHaveBeenCalledWith(
      `/manufacturing-orders/${fixture.completeBegin.manufacturingOrderId}`,
      { include: expect.arrayContaining(['pickLines', 'putLines']) }
    );
  });
});

describe('manufacturing pick-batch data-only scenario boundary', () => {
  it('parses only strict JSON data and binds its canonical hash into approval', () => {
    const parseScenario = canary(
      'parseManufacturingPickBatchCanaryScenario'
    );
    const scenarioHash = canary(
      'manufacturingPickBatchCanaryScenarioHash'
    );
    const assertReady = canary('assertManufacturingPickBatchCanaryReady');
    const scenario = parseScenario(JSON.stringify(scenarioManifest()));
    const hash = scenarioHash(scenario);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(scenario).toEqual(scenarioManifest());
    expect(scenario).not.toHaveProperty('config');
    expect(scenario).not.toHaveProperty('driverModule');
    expect(() =>
      assertReady(
        config(),
        { ...approval(), scenarioManifestHash: 'different' },
        budget,
        hash
      )
    ).toThrow('CANARY_APPROVAL_IDENTITY_MISMATCH');
    expect(
      assertReady(
        config(),
        { ...approval(), scenarioManifestHash: hash },
        budget,
        hash
      )
    ).toBe('approval-123');
  });

  it('rejects executable/extra fields and any extra cleanup dispatch plan', () => {
    const parseScenario = canary(
      'parseManufacturingPickBatchCanaryScenario'
    );
    expect(() =>
      parseScenario(
        JSON.stringify({
          ...scenarioManifest(),
          driverModule: './escape.js',
        })
      )
    ).toThrow('MANUFACTURING_PICK_BATCH_SCENARIO_INVALID');
    expect(() =>
      parseScenario(
        JSON.stringify({
          ...scenarioManifest(),
          config: config(),
        })
      )
    ).toThrow('MANUFACTURING_PICK_BATCH_SCENARIO_INVALID');
    expect(
      (canaryModule as Record<string, unknown>)
        .loadManufacturingPickBatchCanaryDriverModule
    ).toBeUndefined();

    const extraCleanup = structuredClone(scenarioManifest());
    extraCleanup.phases.push(
      structuredClone(
        extraCleanup.phases.find((phase) => phase.phase === 'cleanup')!
      )
    );
    expect(() => parseScenario(JSON.stringify(extraCleanup))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID'
    );

    const cleanupQuery = structuredClone(scenarioManifest());
    (
      cleanupQuery.phases.find(
        (phase) => phase.phase === 'cleanup'
      )!.request as any
    ).query = { force: true };
    expect(() => parseScenario(JSON.stringify(cleanupQuery))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID'
    );

    const unrelatedMo = structuredClone(scenarioManifest());
    unrelatedMo.phases[0]!.reads[0]!.path =
      '/manufacturing-orders/unrelated';
    expect(() => parseScenario(JSON.stringify(unrelatedMo))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID'
    );

    const unrelatedInventory = structuredClone(scenarioManifest());
    (
      unrelatedInventory.phases[1]!.reads.find(
        (read) => read.role === 'inventory-before'
      )! as any
    ).body = [{ productId: 'unrelated-product' }];
    expect(() => parseScenario(JSON.stringify(unrelatedInventory))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID'
    );

    const noMovement = structuredClone(scenarioManifest());
    noMovement.phases[1]!.reads.find(
      (read) => read.role === 'inventory-after'
    )!.expected = noMovement.phases[1]!.reads.find(
      (read) => read.role === 'inventory-before'
    )!.expected;
    expect(() => parseScenario(JSON.stringify(noMovement))).toThrow(
      'MANUFACTURING_PICK_BATCH_SCENARIO_INVALID'
    );

    const unrelatedCleanupWrite = structuredClone(scenarioManifest());
    (
      unrelatedCleanupWrite.phases.find(
        (phase) => phase.phase === 'cleanup'
      )!.request!.body as any
    ).manufacturingOrderId = 'unrelated';
    expect(() =>
      parseScenario(JSON.stringify(unrelatedCleanupWrite))
    ).toThrow('MANUFACTURING_PICK_BATCH_SCENARIO_INVALID');
  });

});
