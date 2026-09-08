import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InflowApiError } from '../client/inflow.js';
import { canonicalHash } from '../core/canonical-json.js';
import syntheticGolden from './fixtures/manufacturing-order.synthetic-golden.json' with { type: 'json' };
import {
  planManufacturingRunBegin,
  type ManufacturingComponentIntent,
} from './manufacturing-run-planner.js';

const coordinatorModule = await import('./manufacturing-run-coordinator.js').catch(() => ({}));

function exported(name: string): any {
  const value = (coordinatorModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value;
}

const baseIdentity = {
  schemaVersion: 'manufacturing-run-identity/v2' as const,
  companyId: 'company-fixture',
  finishedProductId: 'finished-product',
  sourceSerial: 'SERIAL-001',
  finishedSerial: 'SERIAL-001',
  parentRunHash: null,
  parentRawLineId: null,
};

function beginInput(suffix = 'root'): {
  idempotencyKeyHash: string;
  identity: {
    schemaVersion: 'manufacturing-run-identity/v2';
    companyId: string;
    finishedProductId: string;
    sourceSerial: string;
    finishedSerial: string;
    parentRunHash: string | null;
    parentRawLineId: string | null;
  };
  locationId: string;
  remarks: string;
} {
  return {
    idempotencyKeyHash: `idempotency-${suffix}`.padEnd(64, '0').slice(0, 64),
    identity: {
      ...baseIdentity,
      sourceSerial: suffix === 'root' ? 'SERIAL-001' : `SERIAL-${suffix.toUpperCase()}`,
      finishedSerial: suffix === 'root' ? 'SERIAL-001' : `SERIAL-${suffix.toUpperCase()}`,
    },
    locationId: 'location-main',
    remarks: 'operator note',
  };
}

function expandedOrder(
  input = beginInput(),
  options: { operations?: boolean; timestamp?: string } = {}
) {
  const begin = planManufacturingRunBegin(input);
  const order = structuredClone(syntheticGolden.document) as any;
  order.manufacturingOrderId = begin.manufacturingOrderId;
  order.primaryFinishedProductId = begin.normalizedIdentity.finishedProductId;
  order.locationId = input.locationId;
  order.timestamp = options.timestamp ?? '0000000000000010';
  order.lines[0].manufacturingOrderLineId = begin.rootLineId;
  order.lines[0].productId = begin.normalizedIdentity.finishedProductId;
  order.lines[0].quantity.serialNumbers = [];
  order.lines[0].manufacturingOrderLines.forEach((line: any) => {
    line.parentManufacturingOrderLineId = begin.rootLineId;
    if (line.manufacturingOrderLineId === 'component-line-b') {
      line.productId = 'bulk-component';
    }
  });
  order.lines[0].manufacturingOrderLines.push({
    manufacturingOrderLineId: 'source-donor-line',
    parentManufacturingOrderLineId: begin.rootLineId,
    productId: 'source-donor-product',
    quantity: {
      standardQuantity: '1',
      uomQuantity: '1',
      serialNumbers: [],
    },
    manufacturingOrderLines: [],
    manufacturingOrderOperations: [],
  });
  if (!options.operations) {
    order.lines[0].manufacturingOrderOperations = [];
  } else {
    order.lines[0].manufacturingOrderOperations.forEach((operation: any) => {
      operation.manufacturingOrderLineId = begin.rootLineId;
    });
  }
  order.pickLines = [];
  order.pickMatchings = [];
  order.putLines = [];
  order.isCompleted = false;
  order.status = 'inProgress';
  order.remarks = `operator note\n${begin.coordinatorMarker}`;
  return { begin, order };
}

const componentIntents: ManufacturingComponentIntent[] = [
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
    productId: 'bulk-component',
    quantity: '1',
    locationId: 'location-main',
    serialized: false,
    serialNumbers: [],
  },
  {
    rawLineId: 'source-donor-line',
    productId: 'source-donor-product',
    quantity: '1',
    locationId: 'location-main',
    serialized: true,
    serialNumbers: ['SERIAL-001'],
  },
];

function componentIntentsForSource(
  sourceSerial: string
): ManufacturingComponentIntent[] {
  return componentIntents.map((intent) =>
    intent.rawLineId === 'source-donor-line'
      ? { ...intent, serialNumbers: [sourceSerial] }
      : { ...intent }
  );
}

function applyStagedComponentConsumption(
  harness: ReturnType<typeof createHarness>
): void {
  harness.client.products.get('repeated-component').inventoryLines = [];
  harness.client.products.get('bulk-component').inventoryLines = [];
  harness.client.products.get('source-donor-product').inventoryLines =
    harness.client.products.get('source-donor-product').inventoryLines
      .filter((line: any) => line.serial !== 'SERIAL-001');
}

class FakeClock {
  milliseconds = Date.parse('2026-01-01T00:00:00.000Z');

  now = (): Date => new Date(this.milliseconds);

  sleep = async (delayMs: number): Promise<void> => {
    this.milliseconds += delayMs;
  };

  advance(delayMs = 1_000): void {
    this.milliseconds += delayMs;
  }
}

type FakeRun = {
  operationId: string;
  idempotencyKeyHash: string;
  runHash: string;
  canonicalIdentity: any;
  immutableIntentHash: string;
  completePreWriteHash: string | null;
  expectedPostStateHash: string | null;
  preparedRequestHash: string | null;
  manufacturingOrderId: string;
  rootLineId: string;
  coordinatorMarker: string;
  parentOperationId: string | null;
  parentRawLineId: string | null;
  state: string;
  stateRevision: number;
  createdAt: string;
  updatedAt: string;
  deploymentEpoch: number;
  restoreEpoch: number | null;
};

class FakeStore {
  runs = new Map<string, FakeRun>();
  receipts = new Map<string, string>();
  artifacts = new Map<string, Map<string, any>>();
  intents = new Map<string, Map<string, any>>();
  dependencies: any[] = [];
  queue: Array<{
    queueId: number;
    operationId: string;
    availableAt: number;
    claimedBy: string | null;
    claimEpoch: number | null;
    claimExpiresAt: number | null;
  }> = [];
  transitions: any[] = [];
  rateCalls = 0;
  rateLimitAfter = Number.POSITIVE_INFINITY;
  epoch = 1;
  leaseWorkerIds: string[] = [];
  leaseOwner: string | null = null;
  leaseExpiresAt = 0;

  createRun(input: any): { created: boolean; run: FakeRun } {
    const priorOperationId = this.receipts.get(input.idempotencyKeyHash);
    if (priorOperationId) {
      const prior = this.runs.get(priorOperationId)!;
      if (prior.immutableIntentHash !== input.immutableIntentHash) {
        throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      }
      return { created: false, run: prior };
    }
    const byHash = [...this.runs.values()].find((run) => run.runHash === input.runHash);
    if (byHash) {
      if (
        byHash.immutableIntentHash !== input.immutableIntentHash ||
        byHash.manufacturingOrderId !== input.manufacturingOrderId ||
        byHash.rootLineId !== input.rootLineId ||
        JSON.stringify(byHash.canonicalIdentity) !==
          JSON.stringify(input.canonicalIdentity)
      ) {
        throw new Error('RUN_IDENTITY_CONFLICT');
      }
      this.receipts.set(input.idempotencyKeyHash, byHash.operationId);
      return { created: false, run: byHash };
    }
    const createdAt = new Date(input.createdAt).toISOString();
    const run: FakeRun = {
      ...input,
      parentOperationId: input.parentOperationId ?? null,
      parentRawLineId: input.parentRawLineId ?? null,
      completePreWriteHash: null,
      expectedPostStateHash: null,
      preparedRequestHash: null,
      state: 'creating',
      stateRevision: 0,
      createdAt,
      updatedAt: createdAt,
      deploymentEpoch: this.epoch,
      restoreEpoch: null,
    };
    this.runs.set(run.operationId, run);
    this.receipts.set(run.idempotencyKeyHash, run.operationId);
    return { created: true, run };
  }

  beginQueuedRun(input: any): { created: boolean; run: FakeRun } {
    const result = this.createRun(input.run);
    if (result.created) {
      this.bindRunArtifact({
        operationId: result.run.operationId,
        ...input.artifact,
      });
    }
    if (result.run.state === 'creating') {
      this.enqueueRun({
        operationId: result.run.operationId,
        enqueuedAt: input.artifact.at,
      });
    }
    return result;
  }

  beginDependentQueuedRun(input: any): {
    created: boolean;
    run: FakeRun;
    dependency: any;
  } {
    const parent = this.runs.get(input.parentOperationId)!;
    if (!['collecting', 'waiting_dependencies'].includes(parent.state)) {
      throw new Error(`RUN_NOT_COLLECTING_DEPENDENCIES: ${parent.state}`);
    }
    if (parent.stateRevision !== input.expectedParentStateRevision) {
      throw new Error('RUN_STATE_REVISION_CONFLICT');
    }
    const existing = this.dependencies.find(
      (row) =>
        row.parentOperationId === input.parentOperationId &&
        row.parentRawLineId === input.parentRawLineId &&
        row.parentChildIndex === (input.parentChildIndex ?? 0)
    );
    if (existing && existing.childOperationId !== input.run.operationId) {
      throw new Error('MANUFACTURING_DEPENDENCY_CONFLICT');
    }
    if (this.intents.get(input.parentOperationId)?.has(input.parentRawLineId)) {
      throw new Error('PARENT_COMPONENT_DISPOSITION_CONFLICT');
    }
    const identity = input.run.canonicalIdentity;
    if (
      input.run.parentOperationId !== parent.operationId ||
      input.run.parentRawLineId !== input.parentRawLineId ||
      identity.finishedProductId !== input.expectedParentProductId ||
      identity.parentRunHash !== parent.runHash ||
      identity.parentRawLineId !== input.parentRawLineId
    ) {
      throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
    }
    const child = this.beginQueuedRun({
      run: input.run,
      artifact: input.artifact,
    });
    this.addDependency({
      parentOperationId: parent.operationId,
      childOperationId: child.run.operationId,
      parentRawLineId: input.parentRawLineId,
      parentChildIndex: input.parentChildIndex ?? 0,
      createdAt: input.artifact.at,
    });
    if (parent.state === 'collecting') {
      this.transitionRun({
        operationId: parent.operationId,
        expectedRevision: parent.stateRevision,
        toState: 'waiting_dependencies',
        reason: 'recursive child dependency registered',
        at: input.artifact.at,
      });
    }
    return {
      ...child,
      dependency: this.dependencies.find(
        (row) =>
          row.parentOperationId === parent.operationId &&
          row.parentRawLineId === input.parentRawLineId &&
          row.parentChildIndex === (input.parentChildIndex ?? 0)
      ),
    };
  }

  getRun(operationId: string): FakeRun | undefined {
    return this.runs.get(operationId);
  }

  getRunByHash(runHash: string): FakeRun | undefined {
    return [...this.runs.values()].find((run) => run.runHash === runHash);
  }

  listDependencyRunsForReconciliation(limit = 100): FakeRun[] {
    const terminalOrManual = new Set([
      'applied_verified',
      'staged_awaiting_operations',
      'resolved_manual',
      'failed_no_write',
      'conflict',
      'blocked',
      'restore_quarantine',
      'abandoned',
    ]);
    const failure = new Set([
      'resolved_manual',
      'failed_no_write',
      'conflict',
      'blocked',
      'restore_quarantine',
      'abandoned',
    ]);
    return [...this.runs.values()]
      .filter((child) => {
        if (!child.parentOperationId || !child.parentRawLineId) return false;
        const dependency = this.dependencies.find(
          (row) => row.childOperationId === child.operationId
        );
        if (!dependency) return false;
        if (failure.has(child.state)) {
          return [...this.ancestors(child.operationId)].some(
            (operationId) =>
              !terminalOrManual.has(this.runs.get(operationId)?.state ?? '')
          );
        }
        if (child.state !== 'applied_verified') return false;
        const parent = this.runs.get(child.parentOperationId);
        if (!parent || !['collecting', 'waiting_dependencies'].includes(parent.state)) {
          return false;
        }
        return dependency.satisfiedAt === null ||
          !this.intents.get(parent.operationId)?.has(child.parentRawLineId) ||
          !this.getRunArtifact(child.operationId, 'parent_verified_put');
      })
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.operationId.localeCompare(right.operationId)
      )
      .slice(0, limit);
  }

  listComponentCollectionRunsForReconciliation(): FakeRun[] {
    return [...this.runs.values()]
      .filter((run) =>
        ['collecting', 'waiting_dependencies'].includes(run.state) &&
        (
          (this.intents.get(run.operationId)?.size ?? 0) > 0 ||
          this.dependencies.some(
            (dependency) => dependency.parentOperationId === run.operationId
          )
        )
      )
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.operationId.localeCompare(right.operationId)
      );
  }

  bindRunArtifact(input: any): any {
    const byType = this.artifacts.get(input.operationId) ?? new Map<string, any>();
    const prior = byType.get(input.artifactType);
    if (prior) {
      if (
        prior.artifactHash !== input.artifactHash ||
        JSON.stringify(prior.artifact) !== JSON.stringify(input.artifact)
      ) {
        throw new Error('RUN_ARTIFACT_CONFLICT');
      }
      return { created: false, artifact: prior };
    }
    const artifact = {
      artifactType: input.artifactType,
      artifactHash: input.artifactHash,
      artifact: structuredClone(input.artifact),
      at: new Date(input.at).toISOString(),
    };
    byType.set(input.artifactType, artifact);
    this.artifacts.set(input.operationId, byType);
    return { created: true, artifact };
  }

  getRunArtifact(operationId: string, artifactType: string): any {
    return this.artifacts.get(operationId)?.get(artifactType);
  }

  getLatestRunArtifactByPrefix(
    operationId: string,
    artifactTypePrefix: string
  ): any {
    return [...(this.artifacts.get(operationId)?.values() ?? [])]
      .reverse()
      .find((artifact) => artifact.artifactType.startsWith(artifactTypePrefix));
  }

  registerComponentIntent(input: any): any {
    const byLine = this.intents.get(input.operationId) ?? new Map<string, any>();
    const prior = byLine.get(input.rawLineId);
    if (prior) {
      if (prior.intentHash !== input.intentHash) throw new Error('COMPONENT_INTENT_CONFLICT');
      return { created: false, intent: prior };
    }
    const intent = { ...input, createdAt: new Date(input.createdAt).toISOString() };
    byLine.set(input.rawLineId, intent);
    this.intents.set(input.operationId, byLine);
    return { created: true, intent };
  }

  listComponentIntents(operationId: string): any[] {
    return [...(this.intents.get(operationId)?.values() ?? [])]
      .sort((left, right) => left.rawLineId.localeCompare(right.rawLineId));
  }

  addDependency(input: any): { created: boolean } {
    if (input.parentOperationId === input.childOperationId) {
      throw new Error('MANUFACTURING_DEPENDENCY_CYCLE');
    }
    const childAncestors = this.ancestors(input.parentOperationId);
    if (childAncestors.has(input.childOperationId)) {
      throw new Error('MANUFACTURING_DEPENDENCY_CYCLE');
    }
    const prior = this.dependencies.find(
      (row) =>
        row.parentOperationId === input.parentOperationId &&
        row.parentRawLineId === input.parentRawLineId &&
        row.parentChildIndex === (input.parentChildIndex ?? 0)
    );
    if (prior) {
      if (prior.childOperationId !== input.childOperationId) {
        throw new Error('MANUFACTURING_DEPENDENCY_CONFLICT');
      }
      return { created: false };
    }
    this.dependencies.push({
      ...input,
      parentChildIndex: input.parentChildIndex ?? 0,
      createdAt: new Date(input.createdAt).toISOString(),
      satisfiedAt: null,
    });
    return { created: true };
  }

  private ancestors(operationId: string, found = new Set<string>()): Set<string> {
    for (const row of this.dependencies.filter(
      (candidate) => candidate.childOperationId === operationId
    )) {
      if (!found.has(row.parentOperationId)) {
        found.add(row.parentOperationId);
        this.ancestors(row.parentOperationId, found);
      }
    }
    return found;
  }

  listDependencies(parentOperationId: string): any[] {
    return this.dependencies
      .filter((row) => row.parentOperationId === parentOperationId)
      .sort((left, right) =>
        left.parentRawLineId.localeCompare(right.parentRawLineId) ||
        left.parentChildIndex - right.parentChildIndex
      );
  }

  satisfyDependency(input: any): { changed: boolean; allSatisfied: boolean } {
    const row = this.dependencies.find(
      (candidate) =>
        candidate.parentOperationId === input.parentOperationId &&
        candidate.parentRawLineId === input.parentRawLineId &&
        candidate.parentChildIndex === (input.parentChildIndex ?? 0)
    );
    if (!row || row.childOperationId !== input.childOperationId) {
      throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
    }
    const changed = row.satisfiedAt === null;
    if (changed) row.satisfiedAt = new Date(input.satisfiedAt).toISOString();
    return {
      changed,
      allSatisfied: this.listDependencies(input.parentOperationId)
        .every((candidate) => candidate.satisfiedAt !== null),
    };
  }

  completeDependencyWithArtifact(input: any): {
    changed: boolean;
    allSatisfied: boolean;
  } {
    this.bindRunArtifact({
      operationId: input.childOperationId,
      ...input.artifact,
    });
    return this.satisfyDependency(input);
  }

  transitionAppliedVerifiedChildWithArtifact(input: any): {
    run: FakeRun;
    changed: boolean;
    allSatisfied: boolean;
  } {
    const run = this.transitionRun({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      toState: 'applied_verified',
      reason: input.reason,
      at: input.at,
    });
    const dependency = this.completeDependencyWithArtifact({
      parentOperationId: input.parentOperationId,
      childOperationId: input.operationId,
      parentRawLineId: input.parentRawLineId,
      parentChildIndex: input.parentChildIndex,
      artifact: input.artifact,
      satisfiedAt: input.at,
    });
    return { run, ...dependency };
  }

  resolveRunManualWithArtifact(input: any): FakeRun {
    const run = this.runs.get(input.operationId)!;
    const existing = this.getRunArtifact(
      input.operationId,
      input.artifact.artifactType
    );
    if (existing) {
      this.bindRunArtifact({
        operationId: input.operationId,
        ...input.artifact,
      });
      if (run.state === 'resolved_manual') return run;
    }
    if (!['staged_awaiting_operations', 'blocked', 'restore_quarantine'].includes(run.state)) {
      throw new Error(`RUN_NOT_MANUALLY_RESOLVABLE: ${run.state}`);
    }
    if (run.stateRevision !== input.expectedRevision) {
      throw new Error('RUN_STATE_REVISION_CONFLICT');
    }
    this.bindRunArtifact({
      operationId: input.operationId,
      ...input.artifact,
    });
    return this.transitionRun({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      toState: 'resolved_manual',
      reason: input.reason,
      at: input.at,
    });
  }

  transitionRun(input: any): FakeRun {
    const run = this.runs.get(input.operationId)!;
    if (run.stateRevision !== input.expectedRevision) {
      throw new Error('RUN_STATE_REVISION_CONFLICT');
    }
    const fromState = run.state;
    run.state = input.toState;
    run.stateRevision += 1;
    run.updatedAt = new Date(input.at).toISOString();
    this.transitions.push({ ...input, fromState, stateRevision: run.stateRevision });
    if (['creating', 'ready', 'prepared'].includes(input.toState)) {
      this.enqueueRun({ operationId: input.operationId, enqueuedAt: input.at });
    } else {
      this.queue = this.queue.filter((row) => row.operationId !== input.operationId);
    }
    return run;
  }

  markDispatchUncertain(input: any): FakeRun {
    return this.transitionRun({ ...input, toState: 'dispatch_uncertain' });
  }

  rearmDispatchAfterProvenNoWrite(input: any): FakeRun {
    const run = this.runs.get(input.operationId)!;
    if (run.state !== 'dispatch_uncertain') {
      throw new Error(
        `PROVEN_NO_WRITE_REARM_REQUIRES_DISPATCH_UNCERTAIN: ${run.state}`
      );
    }
    if (run.stateRevision !== input.expectedRevision) {
      throw new Error('RUN_STATE_REVISION_CONFLICT');
    }
    const expectedArtifactType =
      `dispatch_no_write_proof/v1:revision:${input.expectedRevision}`;
    const proof = this.getRunArtifact(input.operationId, input.proofArtifactType);
    if (
      input.proofArtifactType !== expectedArtifactType ||
      !proof ||
      proof.artifactHash !== input.evidenceHash
    ) {
      throw new Error('PROVEN_NO_WRITE_ARTIFACT_MISSING_OR_MISMATCHED');
    }
    return this.transitionRun({ ...input, toState: 'prepared' });
  }

  markOperationCompletionPrepared(input: any): FakeRun {
    for (const artifactType of [
      'operation_completion_intent/v1',
      'operation_completion_plan/v1',
    ]) {
      if (!this.getRunArtifact(input.operationId, artifactType)) {
        throw new Error(`RUN_ARTIFACT_MISSING: ${artifactType}`);
      }
    }
    return this.transitionRun({ ...input, toState: 'prepared' });
  }

  fenceOperationCompletionDispatch(input: any): FakeRun {
    const run = this.runs.get(input.operationId)!;
    if (
      run.state !== 'prepared' ||
      run.stateRevision !== input.expectedRevision
    ) {
      throw new Error('OPERATION_COMPLETION_DISPATCH_REQUIRES_PREPARED');
    }
    this.bindRunArtifact({
      operationId: input.operationId,
      ...input.artifact,
    });
    return this.transitionRun({ ...input, toState: 'dispatch_uncertain' });
  }

  markFailedNoWriteAttested(input: any): FakeRun {
    if (this.runs.get(input.operationId)?.state !== 'dispatch_uncertain') {
      throw new Error('ATTESTED_NO_WRITE_REQUIRES_DISPATCH_UNCERTAIN');
    }
    return this.transitionRun({ ...input, toState: 'failed_no_write' });
  }

  bindPlanHashes(input: any): FakeRun {
    const run = this.runs.get(input.operationId)!;
    run.completePreWriteHash = input.completePreWriteHash;
    run.expectedPostStateHash = input.expectedPostStateHash;
    run.preparedRequestHash = input.preparedRequestHash;
    return run;
  }

  enqueueRun(input: any): any {
    const prior = this.queue.find((row) => row.operationId === input.operationId);
    if (prior) return prior;
    const row = {
      queueId: this.queue.length + 1,
      operationId: input.operationId,
      availableAt: new Date(input.availableAt ?? input.enqueuedAt).getTime(),
      claimedBy: null,
      claimEpoch: null,
      claimExpiresAt: null,
    };
    this.queue.push(row);
    return row;
  }

  acquireWorkerLease(input: any): any {
    this.leaseWorkerIds.push(input.workerId);
    const now = new Date(input.now).getTime();
    if (
      this.leaseOwner !== null &&
      this.leaseOwner !== input.workerId &&
      this.leaseExpiresAt > now
    ) {
      throw new Error('WORKER_LEASE_HELD');
    }
    this.leaseOwner = input.workerId;
    this.leaseExpiresAt = now + input.leaseMs;
    return {
      workerId: input.workerId,
      epoch: this.epoch,
      leaseExpiresAt: new Date(this.leaseExpiresAt).toISOString(),
    };
  }

  claimNextRun(input: any): any {
    const now = new Date(input.now).getTime();
    if (
      this.leaseOwner !== input.workerId ||
      this.leaseExpiresAt <= now ||
      input.epoch !== this.epoch
    ) {
      throw new Error('WORKER_LEASE_NOT_HELD');
    }
    const row = this.queue.find(
      (candidate) =>
        candidate.availableAt <= now &&
        (
          candidate.claimedBy === null ||
          (candidate.claimExpiresAt !== null && candidate.claimExpiresAt <= now)
        )
    );
    if (!row) return undefined;
    row.claimedBy = input.workerId;
    row.claimEpoch = input.epoch;
    row.claimExpiresAt = now + input.leaseMs;
    return { ...row, epoch: this.epoch };
  }

  completeQueueItem(input: any): void {
    this.queue = this.queue.filter((row) => row.operationId !== input.operationId);
  }

  renewWorkerOwnership(input: any): any {
    const now = new Date(input.now).getTime();
    if (
      this.leaseOwner !== input.workerId ||
      this.leaseExpiresAt <= now ||
      input.epoch !== this.epoch
    ) {
      throw new Error('WORKER_LEASE_NOT_HELD');
    }
    if (input.operationId !== undefined) {
      const row = this.queue.find(
        (candidate) => candidate.operationId === input.operationId
      );
      if (
        !row ||
        row.claimedBy !== input.workerId ||
        row.claimEpoch !== input.epoch ||
        row.claimExpiresAt === null ||
        row.claimExpiresAt <= now
      ) {
        throw new Error('QUEUE_OWNERSHIP_CONFLICT');
      }
      row.claimExpiresAt = now + input.leaseMs;
    }
    this.leaseExpiresAt = now + input.leaseMs;
    return {
      workerId: input.workerId,
      epoch: input.epoch,
      leaseExpiresAt: new Date(this.leaseExpiresAt).toISOString(),
    };
  }

  releaseQueueClaim(input: any): void {
    this.renewWorkerOwnership(input);
    const row = this.queue.find(
      (candidate) => candidate.operationId === input.operationId
    )!;
    row.claimedBy = null;
    row.claimEpoch = null;
    row.claimExpiresAt = null;
    if (input.availableAt !== undefined) {
      row.availableAt = new Date(input.availableAt).getTime();
    }
  }

  consumeRateBudget(): any {
    const allowed = this.rateCalls < this.rateLimitAfter;
    this.rateCalls += 1;
    return { allowed, remaining: allowed ? 19 : 0, retryAfterMs: allowed ? 0 : 60_000 };
  }
}

class FakeClient {
  orders = new Map<string, any>();
  summaryOverrides = new Map<string, any>();
  products = new Map<string, any>([
    ['repeated-component', {
      productId: 'repeated-component',
      inventoryLines: [
        {
          serial: 'SERIAL-A',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        },
        {
          serial: 'SERIAL-B',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        },
      ],
      trackSerials: true,
    }],
    ['bulk-component', {
      productId: 'bulk-component',
      trackSerials: false,
      inventoryLines: [{
        locationId: 'location-main',
        sublocation: '',
        quantityOnHand: '10',
      }],
    }],
    ['source-donor-product', {
      productId: 'source-donor-product',
      sku: 'DONOR-SKU',
      trackSerials: true,
      inventoryLines: [
        'SERIAL-001',
        'SERIAL-CHILD',
        'SERIAL-CHILD-SUCCESS',
        'SERIAL-AGGREGATION-CRASH-CHILD',
        'SERIAL-MANUAL-CHILD',
        'SERIAL-MANUAL-GRANDCHILD',
        'SERIAL-MISSING-PARENT-EVIDENCE-CHILD',
        'SERIAL-QTY-CHILD-0',
        'SERIAL-QTY-CHILD-1',
        'SERIAL-ROOT-BYPASS',
        'SERIAL-SECOND',
        'SERIAL-SECOND-INSTANCE',
        'SERIAL-SYNTHETIC-003',
      ].map((serial) => ({
        serial,
        locationId: 'location-main',
        sublocation: '',
        quantityOnHand: '1',
      })),
    }],
  ]);
  getCalls: string[] = [];
  prepareCalls: Array<{ method: string; path: string; options: any }> = [];
  dispatchCalls = 0;
  getScript: Array<any | Error | ((path: string) => any)> = [];
  dispatchBehavior?: (request: { method: string; path: string; options: any }) => any;

  async get(path: string): Promise<any> {
    this.getCalls.push(path);
    const scripted = this.getScript.shift();
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted === 'function') {
      return structuredClone(await scripted(path));
    }
    if (scripted !== undefined) return structuredClone(scripted);
    if (path.startsWith('/manufacturing-orders/')) {
      const id = path.slice('/manufacturing-orders/'.length);
      const order = this.orders.get(id);
      if (!order) throw apiError(404, 'not found');
      return structuredClone(order);
    }
    if (path.startsWith('/products/') && path.endsWith('/summary')) {
      const id = path.slice('/products/'.length, -'/summary'.length);
      const override = this.summaryOverrides.get(id);
      if (override) return structuredClone(override);
      const product = this.products.get(id);
      if (!product) throw apiError(404, 'product not found');
      const available = (product.inventoryLines ?? []).filter(
        (line: any) => Number(line.quantityOnHand ?? 0) > 0
      ).length;
      return {
        productId: id,
        quantityOnHand: String(available),
        quantityAvailable: String(available),
        quantityAllocated: '0',
        quantityOnOrder: '0',
        locationSummaries: [{
          locationId: 'location-main',
          locationName: 'Main',
          quantityOnHand: String(available),
          quantityAvailable: String(available),
          sublocationSummaries: [{
            sublocation: '',
            quantityOnHand: String(available),
            quantityAvailable: String(available),
          }],
        }],
      };
    }
    if (path.startsWith('/products/')) {
      const id = path.slice('/products/'.length);
      const product = this.products.get(id);
      if (!product) throw apiError(404, 'product not found');
      return structuredClone(product);
    }
    throw new Error(`UNEXPECTED_GET: ${path}`);
  }

  async prepareMutation(method: string, path: string, options: any): Promise<any> {
    const request = { method, path, options: structuredClone(options) };
    this.prepareCalls.push(request);
    let dispatched = false;
    return {
      correlationId: `prepared-${this.prepareCalls.length}`,
      dispatch: async () => {
        if (dispatched) throw new Error('MUTATION_ALREADY_DISPATCHED');
        dispatched = true;
        this.dispatchCalls += 1;
        if (this.dispatchBehavior) return this.dispatchBehavior(request);
        if (path === '/manufacturing-orders') {
          const body = structuredClone(options.body);
          this.orders.set(body.manufacturingOrderId, body);
          return body;
        }
        throw new Error(`UNEXPECTED_MUTATION: ${path}`);
      },
    };
  }
}

function apiError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function createHarness(options: {
  input?: ReturnType<typeof beginInput>;
  order?: any;
  operations?: boolean;
  testHooks?: Record<string, () => void>;
  verifyDefinitiveNoWrite?: (
    error: unknown
  ) => boolean | Promise<boolean>;
  operationCompletionGate?: () => boolean | Promise<boolean>;
} = {}) {
  const input = options.input ?? beginInput();
  const fixture = expandedOrder(input, { operations: options.operations });
  const store = new FakeStore();
  const client = new FakeClient();
  if (options.order) client.orders.set(fixture.begin.manufacturingOrderId, options.order);
  const clock = new FakeClock();
  const Coordinator = exported('ManufacturingRunCoordinator');
  const coordinator = new Coordinator({
    store,
    client,
    clock,
    workerId: 'worker-a',
    leaseMs: 30_000,
    readback: { attempts: 3, delayMs: 10 },
    testHooks: options.testHooks,
    verifyDefinitiveNoWrite: options.verifyDefinitiveNoWrite,
    operationCompletionGate: options.operationCompletionGate,
  });
  return { coordinator, store, client, clock, input, ...fixture };
}

async function createAndCollect(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.client.orders.set(harness.begin.manufacturingOrderId, structuredClone(harness.order));
  const accepted = harness.coordinator.begin(harness.input);
  expect(accepted.state).toBe('creating');
  await harness.coordinator.runOne();
  expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('collecting');
}

async function makeReady(harness: ReturnType<typeof createHarness>): Promise<void> {
  await createAndCollect(harness);
  for (const intent of componentIntentsForSource(
    harness.begin.normalizedIdentity.sourceSerial
  )) {
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...intent,
    });
  }
  expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
}

describe('manufacturing coordinator persistence-only handlers', () => {
  it('idempotently persists and schedules begin even if the request disconnects', () => {
    const { coordinator, client, store, input, begin } = createHarness();
    const first = coordinator.begin(input);
    const second = coordinator.begin(input);
    expect(first).toMatchObject({
      operationId: begin.operationId,
      manufacturingOrderId: begin.manufacturingOrderId,
      state: 'creating',
    });
    expect(second).toMatchObject({ operationId: begin.operationId, state: 'creating' });
    expect(store.runs).toHaveLength(1);
    expect(store.queue).toHaveLength(1);
    expect(client.getCalls).toEqual([]);
    expect(client.prepareCalls).toEqual([]);
  });

  it('treats changed notification context as replay metadata, not manufacturing intent', () => {
    const { coordinator, store, input, begin } = createHarness();
    const firstInput = {
      ...input,
      remarks: '[manufacturing-run-context:v1:Zmlyc3Q]\noperator note',
    };
    const replayInput = {
      ...input,
      remarks: '[manufacturing-run-context:v1:c2Vjb25k]\noperator note',
    };

    const first = coordinator.begin(firstInput);
    const replay = coordinator.begin(replayInput);

    expect(replay).toMatchObject({
      operationId: first.operationId,
      manufacturingOrderId: first.manufacturingOrderId,
      state: 'creating',
    });
    expect(store.getRunArtifact(begin.operationId, 'begin_plan')?.artifact)
      .toMatchObject({ remarks: firstInput.remarks });
    expect(store.getLatestRunArtifactByPrefix(
      begin.operationId,
      'notification_context/v1:'
    )?.artifact).toEqual({ remarks: replayInput.remarks });
    expect(store.runs).toHaveLength(1);
  });

  it('preserves conflict detection for changed business remarks', () => {
    const { coordinator, input } = createHarness();
    coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:Zmlyc3Q]\noperator note',
    });

    expect(() => coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:c2Vjb25k]\ndifferent note',
    })).toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
  });

  it('accepts a new idempotency key for the same semantic run identity', () => {
    const { coordinator, store, input, begin } = createHarness();
    coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:Zmlyc3Q]\noperator note',
    });

    const replay = coordinator.begin({
      ...input,
      idempotencyKeyHash: 'new-retry-key'.padEnd(64, '0').slice(0, 64),
      remarks: '[manufacturing-run-context:v1:c2Vjb25k]\noperator note',
    });

    expect(replay.operationId).toBe(begin.operationId);
    expect(store.runs).toHaveLength(1);
  });

  it('replays legacy context-bearing immutable hashes without migrating the run', () => {
    const { coordinator, store, input, begin } = createHarness();
    const firstInput = {
      ...input,
      remarks: '[manufacturing-run-context:v1:Zmlyc3Q]\noperator note',
    };
    coordinator.begin(firstInput);
    const storedPlan = store.getRunArtifact(
      begin.operationId,
      'begin_plan'
    )!.artifact;
    const run = store.getRun(begin.operationId)!;
    run.immutableIntentHash = canonicalHash(
      {
        identity: storedPlan.begin.normalizedIdentity,
        locationId: storedPlan.locationId,
        remarks: storedPlan.remarks,
      },
      'manufacturing-run/begin-intent/v1'
    );

    expect(() => coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:c2Vjb25k]\noperator note',
    })).not.toThrow();
    expect(store.getRun(begin.operationId)?.immutableIntentHash)
      .toBe(run.immutableIntentHash);
  });

  it('resumes a component-inventory blocker on a fresh begin replay', () => {
    const { coordinator, store, input, begin } = createHarness();
    coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:Zmlyc3Q]\noperator note',
    });
    const run = store.getRun(begin.operationId)!;
    run.state = 'blocked';
    run.stateRevision = 2;
    store.bindRunArtifact({
      operationId: begin.operationId,
      artifactType: 'blocker_evidence/v1',
      artifactHash: 'component-shortage',
      artifact: { code: 'COMPONENT_INVENTORY_SHORTAGE' },
      at: new Date('2026-01-01T00:00:01.000Z'),
    });

    const replay = coordinator.begin({
      ...input,
      remarks: '[manufacturing-run-context:v1:c2Vjb25k]\noperator note',
    });

    expect(replay).toMatchObject({ state: 'collecting', stateRevision: 3 });
    expect(store.transitions.at(-1)).toMatchObject({
      fromState: 'blocked',
      toState: 'collecting',
    });
  });

  it('resumes a source-serial availability blocker only with a durable binding', () => {
    const { coordinator, store, input, begin } = createHarness();
    coordinator.begin(input);
    const run = store.getRun(begin.operationId)!;
    run.state = 'blocked';
    run.stateRevision = 2;
    store.bindRunArtifact({
      operationId: begin.operationId,
      artifactType: 'source_serial_binding/v1',
      artifactHash: 'source-binding',
      artifact: { sourceSerial: 'SERIAL-001' },
      at: new Date('2026-01-01T00:00:01.000Z'),
    });
    store.bindRunArtifact({
      operationId: begin.operationId,
      artifactType: 'blocker_evidence/v1',
      artifactHash: 'source-unavailable',
      artifact: { code: 'SOURCE_SERIAL_UNAVAILABLE' },
      at: new Date('2026-01-01T00:00:02.000Z'),
    });

    expect(coordinator.begin(input)).toMatchObject({
      state: 'collecting',
      stateRevision: 3,
    });

    const withoutBinding = createHarness({ input: beginInput('unbound') });
    withoutBinding.coordinator.begin(withoutBinding.input);
    const unboundRun = withoutBinding.store.getRun(
      withoutBinding.begin.operationId
    )!;
    unboundRun.state = 'blocked';
    unboundRun.stateRevision = 1;
    withoutBinding.store.bindRunArtifact({
      operationId: withoutBinding.begin.operationId,
      artifactType: 'blocker_evidence/v1',
      artifactHash: 'source-unavailable',
      artifact: { code: 'SOURCE_SERIAL_UNAVAILABLE' },
      at: new Date('2026-01-01T00:00:01.000Z'),
    });
    expect(withoutBinding.coordinator.begin(withoutBinding.input))
      .toMatchObject({ state: 'blocked', stateRevision: 1 });
  });

  it('quarantines a stored legacy v1 active run while keeping status readable', async () => {
    const harness = createHarness();
    harness.coordinator.begin(harness.input);
    const stored = harness.store.getRun(harness.begin.operationId)!;
    stored.canonicalIdentity = {
      companyId: harness.begin.normalizedIdentity.companyId,
      finishedProductId: harness.begin.normalizedIdentity.finishedProductId,
      finishedSerial: harness.begin.normalizedIdentity.finishedSerial,
      parentRunHash: null,
      parentRawLineId: null,
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'blocked',
    });
    await expect(harness.coordinator.status(harness.begin.operationId)).resolves
      .toMatchObject({ state: 'blocked', retryMode: 'manual' });
    expect(harness.client.getCalls).toEqual([]);
    expect(harness.client.prepareCalls).toEqual([]);
    expect(() => harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
    })).toThrow('LEGACY_MANUFACTURING_RUN_RECONCILE_ONLY');
  });

  it('keeps coordinator root begin separate from recursive child creation', () => {
    const harness = createHarness();
    const childInput = beginInput('root-bypass');
    childInput.identity = {
      ...childInput.identity,
      parentRunHash: harness.begin.runHash,
      parentRawLineId: 'component-line-a',
    };

    expect(() => harness.coordinator.begin(childInput))
      .toThrow(/ROOT_BEGIN_PARENT_FIELDS_FORBIDDEN/);
    expect(harness.store.runs.size).toBe(0);
    expect(harness.store.queue).toEqual([]);
  });

  it('registers exact raw-line intents and queues only after the complete set exists', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('collecting');
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('collecting');
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[2],
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
    expect(harness.store.queue).toHaveLength(1);
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('exposes a durable envelope snapshot without scheduling or provider access', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
    });
    const getCallsBefore = [...harness.client.getCalls];
    const queueBefore = structuredClone(harness.store.queue);

    expect(harness.coordinator.snapshot(harness.begin.operationId)).toEqual({
      operationId: harness.begin.operationId,
      runHash: harness.begin.runHash,
      manufacturingOrderId: harness.begin.manufacturingOrderId,
      rootLineId: harness.begin.rootLineId,
      state: 'collecting',
      stateRevision: 1,
      retryMode: 'none',
      expectedComponents: [
        {
          rawLineId: 'source-donor-line',
          productId: 'source-donor-product',
          quantity: '1',
          disposition: 'missing',
        },
        {
          rawLineId: 'component-line-a',
          productId: 'repeated-component',
          quantity: '2',
          disposition: 'registered',
        },
        {
          rawLineId: 'component-line-b',
          productId: 'bulk-component',
          quantity: '1',
          disposition: 'missing',
        },
      ],
    });
    expect(harness.client.getCalls).toEqual(getCallsBefore);
    expect(harness.store.queue).toEqual(queueBefore);
  });

  it('orders the bound donor first, then shallow components, then raw-line ID', async () => {
    const harness = createHarness();
    const root = harness.order.lines[0];
    const structural = root.manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'component-line-a'
    );
    const sourceDonor = root.manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'source-donor-line'
    );
    sourceDonor.parentManufacturingOrderLineId = 'component-line-a';
    structural.manufacturingOrderLines = [
      sourceDonor,
      {
        manufacturingOrderLineId: 'zz-depth-two',
        parentManufacturingOrderLineId: 'component-line-a',
        productId: 'repeated-component',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: [],
        },
        manufacturingOrderLines: [],
        manufacturingOrderOperations: [],
      },
      {
        manufacturingOrderLineId: 'aa-depth-two',
        parentManufacturingOrderLineId: 'component-line-a',
        productId: 'repeated-component',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: [],
        },
        manufacturingOrderLines: [],
        manufacturingOrderOperations: [],
      },
    ];
    root.manufacturingOrderLines = root.manufacturingOrderLines.filter(
      (line: any) => line.manufacturingOrderLineId !== 'source-donor-line'
    );

    await createAndCollect(harness);

    expect(
      harness.coordinator.snapshot(harness.begin.operationId)
        .expectedComponents.map((component: any) => component.rawLineId)
    ).toEqual([
      'source-donor-line',
      'component-line-b',
      'aa-depth-two',
      'zz-depth-two',
    ]);
  });

  it.each([
    ['cancelled', { isCancelled: true }],
    ['completed', { isCompleted: true }],
    ['closed', { status: 'Closed' }],
  ])('fails closed before snapshotting an existing %s deterministic order', async (
    _variant,
    orderState
  ) => {
    const harness = createHarness();
    Object.assign(harness.order, orderState);
    harness.client.orders.set(
      harness.begin.manufacturingOrderId,
      structuredClone(harness.order)
    );
    harness.coordinator.begin(harness.input);

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });

    expect(harness.store.getRun(harness.begin.operationId)).toMatchObject({
      state: 'conflict',
    });
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'begin_snapshot'
    )).toBeUndefined();
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'source_serial_binding/v1'
    )).toBeUndefined();
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('durably blocks an exact component line with no manufacturable resolution', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    const status = harness.coordinator.blockComponent({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
      reason: 'authoritative inventory shortage and no manufacturable BOM',
      evidenceHash: 'inventory-evidence-hash',
    });
    expect(status.state).toBe('blocked');
    expect(harness.store.getLatestRunArtifactByPrefix(
      harness.begin.operationId,
      'component_block:component-line-a'
    )).toMatchObject({
      artifact: {
        rawLineId: 'component-line-a',
        reason: 'authoritative inventory shortage and no manufacturable BOM',
        evidenceHash: 'inventory-evidence-hash',
      },
    });
    expect(harness.client.getCalls).toHaveLength(4);
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('can block again with fresh evidence after an availability retry', async () => {
    const harness = createHarness();
    const blockerEvidence = exported('createManufacturingRunBlockerEvidence');
    await createAndCollect(harness);
    const evidence = (availableQuantity: string) => blockerEvidence({
      code: 'COMPONENT_INVENTORY_SHORTAGE',
      sku: 'COMPONENT-A',
      productId: 'repeated-component',
      rawLineId: 'component-line-a',
      requiredQuantity: '2',
      availableQuantity,
      locationId: 'location-main',
      sourceSerial: null,
      detail: 'authoritative inventory shortage',
    });
    harness.coordinator.blockComponent({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
      reason: 'first shortage',
      evidenceHash: 'first-shortage-hash',
      blockerEvidence: evidence('0'),
    });

    expect(harness.coordinator.begin(harness.input).state).toBe('collecting');
    expect(() => harness.coordinator.blockComponent({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
      reason: 'second shortage',
      evidenceHash: 'second-shortage-hash',
      blockerEvidence: evidence('1'),
    })).not.toThrow();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
    expect(harness.store.getLatestRunArtifactByPrefix(
      harness.begin.operationId,
      'blocker_evidence/v1'
    )?.artifact).toMatchObject({ availableQuantity: '1' });
  });

  it('does not resume a later non-availability block from stale evidence', async () => {
    const harness = createHarness();
    const blockerEvidence = exported('createManufacturingRunBlockerEvidence');
    await createAndCollect(harness);
    harness.coordinator.blockComponent({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
      reason: 'inventory shortage',
      evidenceHash: 'inventory-shortage-hash',
      blockerEvidence: blockerEvidence({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
        sku: 'COMPONENT-A',
        productId: 'repeated-component',
        rawLineId: 'component-line-a',
        requiredQuantity: '2',
        availableQuantity: '0',
        locationId: 'location-main',
        sourceSerial: null,
        detail: 'authoritative inventory shortage',
      }),
    });
    expect(harness.coordinator.begin(harness.input).state).toBe('collecting');
    harness.coordinator.blockComponent({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
      reason: 'later dependency integrity block',
      evidenceHash: 'dependency-integrity-hash',
    });

    expect(harness.coordinator.begin(harness.input)).toMatchObject({
      state: 'blocked',
      stateRevision: 4,
    });
  });

  it('rejects incomplete or contradictory inventory evidence at registration', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    expect(() => harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
      serialNumbers: ['serial-a'],
    })).toThrow(/SERIAL_COUNT_MISMATCH/);
    expect(() => harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
      serialized: false,
      serialNumbers: ['IMPOSSIBLE-SERIAL'],
    })).toThrow(/NON_SERIALIZED_SERIALS/);
    expect(() => harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
      locationId: ' ',
    })).toThrow(/COMPONENT_LOCATION/);
    expect(harness.store.listComponentIntents(harness.begin.operationId)).toEqual([]);
  });

  it('creates explicit recursive dependencies, rejects cycles, and blocks the parent on child failure', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    const childInput = beginInput('child');
    const child = harness.coordinator.beginChildWithDependency({
      parentOperationId: harness.begin.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: childInput.idempotencyKeyHash,
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: childInput.identity.companyId,
        finishedProductId: 'repeated-component',
        sourceSerial: childInput.identity.sourceSerial,
        finishedSerial: childInput.identity.finishedSerial,
      },
      locationId: childInput.locationId,
      remarks: childInput.remarks,
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('waiting_dependencies');
    expect(harness.store.listDependencies(harness.begin.operationId)).toEqual([
      expect.objectContaining({
        childOperationId: child.operationId,
        parentRawLineId: 'component-line-a',
      }),
    ]);
    expect(() => harness.coordinator.registerDependency({
      parentOperationId: child.operationId,
      childOperationId: harness.begin.operationId,
      parentRawLineId: 'cycle-line',
    })).toThrow(/MANUFACTURING_DEPENDENCY_CYCLE/);
    harness.store.transitionRun({
      operationId: child.operationId,
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'child inventory could not be resolved',
      at: harness.clock.now(),
    });
    harness.coordinator.propagateDependencyOutcome(child.operationId);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
  });
});

describe('deterministic create recovery', () => {
  it('recovers an exact MO after create response loss and never creates it twice', async () => {
    const harness = createHarness();
    harness.coordinator.begin(harness.input);
    harness.client.dispatchBehavior = (request) => {
      harness.client.orders.set(
        request.options.body.manufacturingOrderId,
        structuredClone(harness.order)
      );
      throw apiError(408, 'response lost');
    };
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('collecting');
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);
    harness.store.enqueueRun({ operationId: harness.begin.operationId });
    await harness.coordinator.runOne();
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('strands safely after the pre-socket barrier and will only read on restart', async () => {
    let crash = true;
    const harness = createHarness({
      testHooks: {
        afterCreateFenced: () => {
          if (crash) throw new Error('SIMULATED_PRE_SOCKET_CRASH');
        },
      },
    });
    harness.coordinator.begin(harness.input);
    await expect(harness.coordinator.runOne()).rejects.toThrow(/SIMULATED_PRE_SOCKET_CRASH/);
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(0);
    crash = false;
    harness.clock.advance(31_000);
    harness.store.queue[0]!.claimedBy = null;
    await harness.coordinator.runOne();
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('creating');
  });

  it('quarantines a deterministic ID with the wrong marker/product/root and never creates over it', async () => {
    const harness = createHarness();
    const conflicting = structuredClone(harness.order);
    conflicting.remarks = 'someone else owns this deterministic ID';
    harness.client.orders.set(harness.begin.manufacturingOrderId, conflicting);
    harness.coordinator.begin(harness.input);
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('conflict');
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('runs only one FIFO claim at a time inside a process', async () => {
    const harness = createHarness();
    const secondInput = beginInput('second');
    const secondFixture = expandedOrder(secondInput);
    harness.client.orders.set(harness.begin.manufacturingOrderId, harness.order);
    harness.client.orders.set(
      secondFixture.begin.manufacturingOrderId,
      secondFixture.order
    );
    harness.coordinator.begin(harness.input);
    harness.coordinator.begin(secondInput);
    await Promise.all([
      harness.coordinator.runOne(),
      harness.coordinator.runOne(),
    ]);
    expect([...harness.store.runs.values()].filter(
      (run) => run.state === 'collecting'
    )).toHaveLength(1);
    expect(harness.store.queue).toHaveLength(1);
  });

  it('uses a distinct default lease owner identity for every coordinator instance', async () => {
    const firstInput = beginInput();
    const secondInput = beginInput('second-instance');
    const firstFixture = expandedOrder(firstInput);
    const secondFixture = expandedOrder(secondInput);
    const store = new FakeStore();
    const client = new FakeClient();
    const clock = new FakeClock();
    client.orders.set(firstFixture.begin.manufacturingOrderId, firstFixture.order);
    client.orders.set(secondFixture.begin.manufacturingOrderId, secondFixture.order);
    const Coordinator = exported('ManufacturingRunCoordinator');
    const first = new Coordinator({ store, client, clock });
    const second = new Coordinator({ store, client, clock });
    first.begin(firstInput);
    first.begin(secondInput);
    await first.runOne();
    clock.advance(30_001);
    await second.runOne();
    expect(new Set(store.leaseWorkerIds).size).toBe(2);
  });
});

describe('single-dispatch worker and readback reconciliation', () => {
  it('pins the exact incident SERIAL to raw line 3473e2e1 and accepts 27 on hand / 24 available without substituting', async () => {
    const input = beginInput('exact-incident');
    input.identity.sourceSerial = 'SERIAL-SYNTHETIC-003';
    input.identity.finishedSerial = 'OUTPUT-SERIAL-SYNTHETIC-003';
    const harness = createHarness({ input });
    const donor = harness.order.lines[0].manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'source-donor-line'
    );
    donor.manufacturingOrderLineId =
      '3473e2e1-f027-454f-a60f-cb6717d707fd';
    const donorProduct = harness.client.products.get('source-donor-product');
    donorProduct.inventoryLines.find(
      (line: any) => line.serial === 'SERIAL-SYNTHETIC-003'
    ).quantityOnHand = '27';
    harness.client.summaryOverrides.set('source-donor-product', {
      productId: 'source-donor-product',
      quantityOnHand: '27',
      quantityAvailable: '24',
      quantityAllocated: '3',
      quantityOnOrder: '0',
      locationSummaries: [{
        locationId: 'location-main',
        locationName: 'Main',
        quantityOnHand: '27',
        quantityAvailable: '24',
        sublocationSummaries: [{
          sublocation: '',
          quantityOnHand: '27',
          quantityAvailable: '24',
        }],
      }],
    });
    await createAndCollect(harness);
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'source_serial_binding/v1'
    )).toMatchObject({
      artifact: {
        rawLineId: '3473e2e1-f027-454f-a60f-cb6717d707fd',
        productId: 'source-donor-product',
        sourceSerial: 'SERIAL-SYNTHETIC-003',
        locationId: 'location-main',
      },
    });
    for (const intent of [
      componentIntents[0],
      componentIntents[1],
      {
        ...componentIntents[2],
        rawLineId: '3473e2e1-f027-454f-a60f-cb6717d707fd',
        serialNumbers: ['SERIAL-SYNTHETIC-003'],
      },
    ]) {
      harness.coordinator.registerComponent({
        operationId: harness.begin.operationId,
        ...intent,
      });
    }
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    const body = harness.client.prepareCalls.at(-1)!.options.body;
    expect(body.pickLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'source-donor-product',
        quantity: expect.objectContaining({
          serialNumbers: ['SERIAL-SYNTHETIC-003'],
        }),
      }),
    ]));
    expect(body.pickMatchings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        manufacturingOrderLineId:
          '3473e2e1-f027-454f-a60f-cb6717d707fd',
        serial: 'SERIAL-SYNTHETIC-003',
      }),
    ]));
    expect(body.putLines[0].quantity.serialNumbers).toEqual([
      'OUTPUT-SERIAL-SYNTHETIC-003',
    ]);
  });

  it.each([
    ['missing', 'SOURCE_SERIAL_OWNER_MISSING'],
    ['cross-location', 'SOURCE_SERIAL_CROSS_LOCATION'],
    ['multiple-owners', 'SOURCE_SERIAL_MULTIPLE_OWNERS'],
    ['structural-owner', 'SOURCE_SERIAL_STRUCTURAL_OWNER'],
  ])('blocks %s source serial ownership before component collection', async (variant, code) => {
    const input = beginInput(`binding-${variant}`);
    input.identity.sourceSerial = variant === 'structural-owner'
      ? 'SERIAL-A'
      : variant === 'missing'
        ? 'MISSING-SOURCE-SERIAL'
        : 'SERIAL-001';
    const harness = createHarness({ input });
    if (variant === 'cross-location') {
      harness.client.products.get('source-donor-product').inventoryLines.find(
        (line: any) => line.serial === 'SERIAL-001'
      ).locationId = 'location-other';
    }
    if (variant === 'multiple-owners') {
      harness.client.products.get('repeated-component').inventoryLines.push({
        serial: 'SERIAL-001',
        locationId: 'location-main',
        sublocation: '',
        quantityOnHand: '1',
      });
    }
    if (variant === 'structural-owner') {
      const component = harness.order.lines[0].manufacturingOrderLines.find(
        (line: any) => line.manufacturingOrderLineId === 'component-line-a'
      );
      component.manufacturingOrderLines = [{
        manufacturingOrderLineId: 'nested-consumable-line',
        parentManufacturingOrderLineId: 'component-line-a',
        productId: 'bulk-component',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: [],
        },
        manufacturingOrderLines: [],
        manufacturingOrderOperations: [],
      }];
    }
    harness.client.orders.set(
      harness.begin.manufacturingOrderId,
      structuredClone(harness.order)
    );
    harness.coordinator.begin(harness.input);
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
    expect(harness.store.getLatestRunArtifactByPrefix(
      harness.begin.operationId,
      'blocker_evidence/v1'
    )).toMatchObject({ artifact: { code } });
    expect(harness.store.listComponentIntents(harness.begin.operationId)).toEqual([]);
    expect(harness.client.prepareCalls).toEqual([]);
  });

  const transientReadFailures = [
    ['408', () => apiError(408, 'request timeout')],
    ['429', () => apiError(429, 'provider rate limit')],
    ['5xx', () => apiError(503, 'provider unavailable')],
    ['transport', () => new TypeError('fetch failed: socket closed')],
    ['malformed JSON', () => new SyntaxError('Unexpected token in JSON')],
  ] as const;

  it.each(transientReadFailures)(
    'leaves ready queueable after a transient %s pre-dispatch read failure',
    async (_name, failure) => {
      const harness = createHarness();
      await makeReady(harness);
      harness.client.getScript = [failure()];
      await expect(harness.coordinator.runOne()).resolves.toMatchObject({
        outcome: 'retryable_read',
      });
      expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
      expect(harness.store.queue).toEqual([
        expect.objectContaining({
          operationId: harness.begin.operationId,
          claimedBy: null,
        }),
      ]);
      expect(harness.client.prepareCalls).toEqual([]);
    }
  );

  it.each(transientReadFailures)(
    'leaves prepared queueable after a transient %s restart read failure',
    async (_name, failure) => {
      let crash = true;
      const harness = createHarness({
        testHooks: {
          afterPrepared: () => {
            if (crash) throw new Error('SIMULATED_PRE_PREPARE_CRASH');
          },
        },
      });
      await makeReady(harness);
      await expect(harness.coordinator.runOne())
        .rejects.toThrow(/SIMULATED_PRE_PREPARE_CRASH/);
      expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('prepared');
      crash = false;
      harness.clock.advance(30_001);
      harness.client.getScript = [failure()];
      await expect(harness.coordinator.runOne()).resolves.toMatchObject({
        outcome: 'retryable_read',
      });
      expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('prepared');
      expect(harness.store.queue).toEqual([
        expect.objectContaining({
          operationId: harness.begin.operationId,
          claimedBy: null,
        }),
      ]);
      expect(harness.client.prepareCalls).toHaveLength(1);
    }
  );

  it('prevents a stale worker from transitioning or dispatching after takeover during a long read', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const oldRead = deferred<any>();
    harness.client.getScript = [() => oldRead.promise];

    const newRead = deferred<any>();
    const replacementClient = new FakeClient();
    replacementClient.orders.set(
      harness.begin.manufacturingOrderId,
      structuredClone(harness.order)
    );
    replacementClient.getScript = [() => newRead.promise];
    const Coordinator = exported('ManufacturingRunCoordinator');
    const replacement = new Coordinator({
      store: harness.store,
      client: replacementClient,
      clock: harness.clock,
      workerId: 'worker-b',
      leaseMs: 30_000,
      readback: { attempts: 1, delayMs: 0 },
    });

    const staleTick = harness.coordinator.runOne();
    await Promise.resolve();
    expect(harness.client.getCalls).toHaveLength(5);
    harness.clock.advance(30_001);
    const replacementTick = replacement.runOne();
    await Promise.resolve();
    expect(replacementClient.getCalls).toHaveLength(1);

    oldRead.resolve(structuredClone(harness.order));
    await expect(staleTick).resolves.toMatchObject({ outcome: 'lease_lost' });
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');

    newRead.resolve(structuredClone(harness.order));
    await replacementTick;
  });

  it('rechecks ownership after the deterministic-create barrier before socket dispatch', async () => {
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      testHooks: {
        afterCreateFenced: () => {
          harness.clock.advance(30_001);
          harness.store.acquireWorkerLease({
            workerId: 'worker-b',
            leaseMs: 30_000,
            now: harness.clock.now(),
          });
        },
      },
    });
    harness.coordinator.begin(harness.input);
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'lease_lost',
    });
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('creating');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'create_dispatch_barrier'
    )).toBeDefined();
  });

  it('rechecks ownership after dispatch_uncertain before final socket dispatch', async () => {
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness({
      testHooks: {
        afterDispatchFenced: () => {
          harness.clock.advance(30_001);
          harness.store.acquireWorkerLease({
            workerId: 'worker-b',
            leaseMs: 30_000,
            now: harness.clock.now(),
          });
        },
      },
    });
    await makeReady(harness);
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'lease_lost',
    });
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it('does not terminalize an attested response after lease takeover during dispatch', async () => {
    const dispatch = deferred<any>();
    const harness = createHarness({
      verifyDefinitiveNoWrite: async () => true,
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => dispatch.promise;
    const staleTick = harness.coordinator.runOne();
    while (harness.client.dispatchCalls === 0) await Promise.resolve();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    harness.clock.advance(30_001);
    harness.store.acquireWorkerLease({
      workerId: 'worker-b',
      leaseMs: 30_000,
      now: harness.clock.now(),
    });
    dispatch.reject(new InflowApiError(
      'provider rejected before write',
      400,
      {
        code: 'NegativeSerialNumberInventory',
        message: 'provider rejected before write',
      }
    ));
    await expect(staleTick).resolves.toMatchObject({ outcome: 'lease_lost' });
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it('stops readback reconciliation when ownership is lost during a long read', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const readback = deferred<any>();
    harness.client.getScript = [
      ...Array.from({ length: 20 }, () => undefined),
      () => readback.promise,
    ];
    let applied: any;
    harness.client.dispatchBehavior = (request) => {
      applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };
    const staleTick = harness.coordinator.runOne();
    while (harness.client.getCalls.length < 25) await Promise.resolve();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    harness.clock.advance(30_001);
    harness.store.acquireWorkerLease({
      workerId: 'worker-b',
      leaseMs: 30_000,
      now: harness.clock.now(),
    });
    readback.resolve(applied);
    await expect(staleTick).resolves.toMatchObject({ outcome: 'lease_lost' });
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it('re-reads the full MO and serialized inventory, then dispatches one complete PUT', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };
    const result = await harness.coordinator.runOne();
    expect(result).toMatchObject({ outcome: 'applied_verified' });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('applied_verified');
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.client.prepareCalls[0]).toMatchObject({
      method: 'PUT',
      path: '/manufacturing-orders',
    });
    expect(harness.client.prepareCalls[0]!.options.body).toMatchObject({
      isCompleted: true,
      status: 'completed',
    });
    expect(harness.client.prepareCalls[0]!.options.body.pickLines).toHaveLength(3);
    expect(harness.client.prepareCalls[0]!.options.body.pickMatchings).toHaveLength(4);
    expect(harness.client.prepareCalls[0]!.options.body.putLines).toHaveLength(1);
    expect(harness.client.getCalls).toContain('/products/repeated-component');
  });

  it('uses aggregate availability when exact bound and ordinary inventory each have one bucket', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.summaryOverrides.set('source-donor-product', {
      productId: 'source-donor-product',
      quantityOnHand: '13',
      quantityAvailable: '13',
      quantityAllocated: '0',
      quantityOnOrder: '0',
      locationSummaries: [],
    });
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '10',
      quantityAvailable: '6',
      quantityAllocated: '4',
      quantityOnOrder: '0',
      locationSummaries: [],
    });
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'component_inventory_expectation/v1'
    )).toMatchObject({
      artifact: {
        bulkBuckets: [{
          productId: 'bulk-component',
          locationId: 'location-main',
          sublocation: '',
          expectedQuantityOnHand: '9',
        }],
      },
    });
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it.each([
    ['build', '1', '0', '1'],
    ['manufacturing', '0', '1', '0'],
  ])(
    'accepts current-MO stock reserved via the %s dimension at the dispatch barrier',
    async (_dimension, buildReserved, manufacturingReserved, rawAvailable) => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '1',
      quantityAvailable: '0',
      rawQuantityAvailable: rawAvailable,
      quantityAllocated: '0',
      quantityOnOrder: '0',
      quantityReserved: '1',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: manufacturingReserved,
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: buildReserved,
      quantityPicked: '0',
      locationSummaries: [],
    });
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);
    }
  );

  it('accepts exact dual reservation projections for a nested current-MO component', async () => {
    const harness = createHarness();
    const root = harness.order.lines[0];
    const bulk = root.manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'component-line-b'
    );
    bulk.parentManufacturingOrderLineId = 'subassembly-line';
    root.manufacturingOrderLines = root.manufacturingOrderLines.filter(
      (line: any) => line.manufacturingOrderLineId !== 'component-line-b'
    );
    root.manufacturingOrderLines.push({
      manufacturingOrderLineId: 'subassembly-line',
      parentManufacturingOrderLineId: harness.begin.rootLineId,
      productId: 'subassembly-product',
      quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
      manufacturingOrderLines: [bulk],
      manufacturingOrderOperations: [],
    });
    harness.client.products.set('subassembly-product', {
      productId: 'subassembly-product',
      trackSerials: false,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '1',
      quantityAvailable: '-1',
      rawQuantityAvailable: '0',
      quantityAllocated: '0',
      quantityOnOrder: '0',
      quantityReserved: '2',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '1',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '1',
      quantityPicked: '0',
      locationSummaries: [],
    });
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
  });

  it('rejects the same dual reservation projection for a direct component', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '1',
      quantityAvailable: '-1',
      rawQuantityAvailable: '0',
      quantityAllocated: '0',
      quantityOnOrder: '0',
      quantityReserved: '2',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '1',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '1',
      quantityPicked: '0',
      locationSummaries: [],
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
  });

  it('rejects build-reserved ordinary stock outside the active MO location', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const intent = harness.store.intents
      .get(harness.begin.operationId)
      ?.get('component-line-b');
    expect(intent).toBeDefined();
    intent.locationId = 'location-secondary';
    harness.client.products.get('bulk-component').inventoryLines = [{
      locationId: 'location-secondary',
      sublocation: '',
      quantityOnHand: '1',
    }];
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '1',
      quantityAvailable: '0',
      rawQuantityAvailable: '1',
      quantityAllocated: '0',
      quantityOnOrder: '0',
      quantityReserved: '1',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '0',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '1',
      quantityPicked: '0',
      locationSummaries: [{
        locationId: 'location-secondary',
        locationName: 'Secondary',
        quantityOnHand: '1',
        quantityAvailable: '0',
        rawQuantityAvailable: '1',
        quantityReserved: '1',
        quantityReservedForSales: '0',
        quantityReservedForManufacturing: '0',
        quantityReservedForTransfers: '0',
        quantityReservedForBuilds: '1',
        quantityPicked: '0',
        sublocationSummaries: [],
      }],
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
  });

  it('rejects aggregate ordinary availability when positive stock spans buckets', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.products.get('bulk-component').inventoryLines.push({
      locationId: 'location-secondary',
      sublocation: '',
      quantityOnHand: '1',
    });
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '11',
      quantityAvailable: '6',
      quantityAllocated: '5',
      quantityOnOrder: '0',
      locationSummaries: [],
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
  });

  it('closes before dispatch when allocated stock leaves a nonserialized component unavailable', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.summaryOverrides.set('bulk-component', {
      productId: 'bulk-component',
      quantityOnHand: '10',
      quantityAvailable: '0',
      quantityAllocated: '10',
      quantityOnOrder: '0',
      locationSummaries: [{
        locationId: 'location-main',
        locationName: 'Main',
        quantityOnHand: '10',
        quantityAvailable: '0',
        sublocationSummaries: [{
          sublocation: '',
          quantityOnHand: '10',
          quantityAvailable: '0',
        }],
      }],
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
  });

  it.each(['1', '2'])(
    'closes before dispatch when serialized availability is aggregate-ambiguous (required %s)',
    async (quantity) => {
      const harness = createHarness();
      const componentLine = harness.order.lines[0].manufacturingOrderLines.find(
        (line: any) => line.manufacturingOrderLineId === 'component-line-a'
      );
      componentLine.quantity.standardQuantity = quantity;
      componentLine.quantity.uomQuantity = quantity;
      await createAndCollect(harness);
      harness.coordinator.registerComponent({
        operationId: harness.begin.operationId,
        ...componentIntents[0],
        quantity,
        serialNumbers: quantity === '1'
          ? ['SERIAL-A']
          : ['SERIAL-A', 'SERIAL-B'],
      });
      harness.coordinator.registerComponent({
        operationId: harness.begin.operationId,
        ...componentIntents[1],
      });
      harness.coordinator.registerComponent({
        operationId: harness.begin.operationId,
        ...componentIntents[2],
      });
      harness.client.summaryOverrides.set('repeated-component', {
        productId: 'repeated-component',
        quantityOnHand: '2',
        quantityAvailable: '1',
        quantityAllocated: '1',
        quantityOnOrder: '0',
        locationSummaries: [{
          locationId: 'location-main',
          locationName: 'Main',
          quantityOnHand: '2',
          quantityAvailable: '1',
          sublocationSummaries: [{
            sublocation: '',
            quantityOnHand: '2',
            quantityAvailable: '1',
          }],
        }],
      });

      await expect(harness.coordinator.runOne()).resolves.toMatchObject({
        outcome: 'conflict',
      });
      expect(harness.client.prepareCalls).toEqual([]);
      expect(harness.client.dispatchCalls).toBe(0);
    }
  );

  it('rejects caller serialization metadata that disagrees with the authoritative product', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
      serialized: false,
      serialNumbers: [],
    });
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
    });
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[2],
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('closes on serialized collisions across component intents', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[0],
    });
    const lineB = harness.store.intents.get(harness.begin.operationId)!;
    lineB.set('component-line-b', {
      ...lineB.get('component-line-b'),
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-b',
      productId: 'repeated-component',
      quantity: '1',
      locationId: 'location-main',
      sublocation: null,
      serialized: true,
      serialNumbers: ['SERIAL-A'],
      intentHash: 'collision-intent',
      createdAt: harness.clock.now().toISOString(),
    });
    harness.store.transitionRun({
      operationId: harness.begin.operationId,
      expectedRevision: 1,
      toState: 'ready',
      reason: 'test collision ready state',
      at: harness.clock.now(),
    });

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('read-only reconciles a stored legacy v1 dispatch uncertainty without redispatch', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      throw apiError(408, 'response lost after apply');
    };
    await Promise.all([
      harness.coordinator.runOne(),
      harness.coordinator.runOne(),
    ]);
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.transitions.find(
      (transition) => transition.toState === 'dispatch_uncertain'
    )).toBeDefined();
    const stored = harness.store.getRun(harness.begin.operationId)!;
    stored.canonicalIdentity = {
      companyId: harness.begin.normalizedIdentity.companyId,
      finishedProductId: harness.begin.normalizedIdentity.finishedProductId,
      finishedSerial: harness.begin.normalizedIdentity.finishedSerial,
      parentRunHash: null,
      parentRawLineId: null,
    };
    await harness.coordinator.status(harness.begin.operationId);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('applied_verified');
  });

  it('strands the final mutation after the durable pre-socket boundary', async () => {
    const harness = createHarness({
      testHooks: {
        afterDispatchFenced: () => {
          throw new Error('SIMULATED_FINAL_PRE_SOCKET_CRASH');
        },
      },
    });
    await makeReady(harness);
    await expect(harness.coordinator.runOne())
      .rejects.toThrow(/SIMULATED_FINAL_PRE_SOCKET_CRASH/);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.client.dispatchCalls).toBe(0);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it('revalidates and safely resumes a prepared plan after a pre-prepare crash', async () => {
    let crash = true;
    const harness = createHarness({
      testHooks: {
        afterPrepared: () => {
          if (crash) throw new Error('SIMULATED_PRE_PREPARE_CRASH');
        },
      },
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };
    await expect(harness.coordinator.runOne())
      .rejects.toThrow(/SIMULATED_PRE_PREPARE_CRASH/);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('prepared');
    expect(harness.client.prepareCalls).toEqual([]);
    crash = false;
    harness.store.queue[0]!.claimedBy = null;
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('applied_verified');
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('resumes a prepared plan within one fresh durable rate-budget window', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };

    harness.store.rateLimitAfter = harness.store.rateCalls + 20;
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'rate_limited',
      retryAfterMs: 60_000,
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('prepared');
    expect(harness.client.dispatchCalls).toBe(0);
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'idle',
    });

    harness.clock.advance(60_000);
    harness.store.rateLimitAfter = harness.store.rateCalls + 20;
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('applied_verified');
  });

  it('keeps post-dispatch rate limits on the explicit readback-only path', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      harness.store.rateLimitAfter = harness.store.rateCalls;
      return applied;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'dispatch_uncertain',
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.store.queue).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(1);

    harness.store.rateLimitAfter = Number.MAX_SAFE_INTEGER;
    await expect(harness.coordinator.status(harness.begin.operationId))
      .resolves.toMatchObject({ state: 'applied_verified' });
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('uses failed_no_write only for a canary-attested definitive no-write', async () => {
    const verifierCalls: unknown[] = [];
    const harness = createHarness({
      verifyDefinitiveNoWrite: async (error) => {
        verifierCalls.push(error);
        return true;
      },
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw new InflowApiError(
        'The serialized inventory is no longer available',
        400,
        {
          code: 'NegativeSerialNumberInventory',
          message: 'The serialized inventory is no longer available',
        }
      );
    };
    await harness.coordinator.runOne();
    expect(verifierCalls).toHaveLength(1);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('failed_no_write');
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('rejects a name-shaped provider spoof without consulting the attestation verifier', async () => {
    const verifierCalls: unknown[] = [];
    const harness = createHarness({
      verifyDefinitiveNoWrite: async (error) => {
        verifierCalls.push(error);
        return true;
      },
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      const error = Object.assign(
        new Error('The serialized inventory is no longer available'),
        {
          name: 'InflowApiError',
          statusCode: 400,
          apiError: {
            code: 'NegativeSerialNumberInventory',
            message: 'The serialized inventory is no longer available',
          },
        }
      );
      throw error;
    };
    await harness.coordinator.runOne();
    expect(verifierCalls).toHaveLength(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it('keeps local self-attested no-write errors uncertain', async () => {
    const verifierCalls: unknown[] = [];
    const harness = createHarness({
      verifyDefinitiveNoWrite: async (error) => {
        verifierCalls.push(error);
        return true;
      },
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw Object.assign(
        new Error('NegativeSerialNumberInventory'),
        {
          name: 'CanaryAttestedDefinitiveNoWriteError',
          canaryDomain: 'manufacturing-pick-batch-v1',
          definitiveNoWrite: true,
          statusCode: 400,
        }
      );
    };
    await harness.coordinator.runOne();
    expect(verifierCalls).toHaveLength(0);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
  });

  it.each([
    ['timeout', apiError(408, 'timeout')],
    ['429', apiError(429, 'rate limited')],
    ['5xx', apiError(503, 'provider failed')],
    ['malformed', new SyntaxError('malformed response')],
  ])('keeps %s outcomes uncertain without automatic retry', async (_name, failure) => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw failure;
    };
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('dispatch_uncertain');
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('re-arms only an exact attested rejection with revision-bound pre-write proof', async () => {
    const verifierCalls: unknown[] = [];
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      verifyDefinitiveNoWrite: async (error) => {
        verifierCalls.push(error);
        harness.store.rateLimitAfter = harness.store.rateCalls;
        return true;
      },
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw new InflowApiError(
        'A work-order part would have negative inventory',
        400,
        {
          code: 'WorkOrderPartNegativeInventory',
          message: 'A work-order part would have negative inventory',
        }
      );
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'dispatch_uncertain',
    });
    const uncertain = harness.store.getRun(harness.begin.operationId)!;
    expect(uncertain.state).toBe('dispatch_uncertain');
    expect(verifierCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.queue).toEqual([]);
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dispatch_no_write_rejection/v1:revision:${uncertain.stateRevision}`
    )).toBeDefined();
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dispatch_no_write_proof/v1:revision:${uncertain.stateRevision}`
    )).toBeUndefined();

    await expect(harness.coordinator.status(harness.begin.operationId))
      .resolves.toMatchObject({ state: 'dispatch_uncertain' });
    expect(harness.client.dispatchCalls).toBe(1);

    harness.store.rateLimitAfter = Number.MAX_SAFE_INTEGER;
    await expect(harness.coordinator.rearmProvenNoWrite({
      operationId: harness.begin.operationId,
      expectedRevision: uncertain.stateRevision,
    })).resolves.toMatchObject({ state: 'prepared' });
    expect(harness.store.queue).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(1);

    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, applied);
      return applied;
    };
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.client.dispatchCalls).toBe(2);
  });

  it('refuses to re-arm an unchanged timeout without exact rejection evidence', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw apiError(408, 'response lost');
    };

    await harness.coordinator.runOne();
    const uncertain = harness.store.getRun(harness.begin.operationId)!;
    expect(uncertain.state).toBe('dispatch_uncertain');
    await expect(harness.coordinator.rearmProvenNoWrite({
      operationId: harness.begin.operationId,
      expectedRevision: uncertain.stateRevision,
    })).rejects.toThrow('PROVEN_NO_WRITE_REJECTION_INCOMPLETE');
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.store.queue).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('refuses to persist rejection evidence when the attestation verifier declines it', async () => {
    const harness = createHarness({
      verifyDefinitiveNoWrite: async () => false,
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = () => {
      throw new InflowApiError(
        'A work-order part would have negative inventory',
        400,
        {
          code: 'WorkOrderPartNegativeInventory',
          message: 'A work-order part would have negative inventory',
        }
      );
    };

    await harness.coordinator.runOne();
    const uncertain = harness.store.getRun(harness.begin.operationId)!;
    expect(uncertain.state).toBe('dispatch_uncertain');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dispatch_no_write_rejection/v1:revision:${uncertain.stateRevision}`
    )).toBeUndefined();
    await expect(harness.coordinator.rearmProvenNoWrite({
      operationId: harness.begin.operationId,
      expectedRevision: uncertain.stateRevision,
    })).rejects.toThrow('PROVEN_NO_WRITE_REJECTION_INCOMPLETE');
    expect(harness.store.queue).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('refuses to re-arm an exact rejection when readback shows a partial write', async () => {
    const harness = createHarness({
      verifyDefinitiveNoWrite: async () => true,
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const partial = structuredClone(harness.order);
      partial.timestamp = '0000000000000011';
      partial.pickLines = [structuredClone(request.options.body.pickLines[0])];
      harness.client.orders.set(harness.begin.manufacturingOrderId, partial);
      throw new InflowApiError(
        'A work-order part would have negative inventory',
        400,
        {
          code: 'WorkOrderPartNegativeInventory',
          message: 'A work-order part would have negative inventory',
        }
      );
    };

    await harness.coordinator.runOne();
    const uncertain = harness.store.getRun(harness.begin.operationId)!;
    expect(uncertain.state).toBe('dispatch_uncertain');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dispatch_no_write_rejection/v1:revision:${uncertain.stateRevision}`
    )).toBeDefined();
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dispatch_no_write_proof/v1:revision:${uncertain.stateRevision}`
    )).toBeUndefined();
    await expect(harness.coordinator.rearmProvenNoWrite({
      operationId: harness.begin.operationId,
      expectedRevision: uncertain.stateRevision,
    })).rejects.toThrow('PROVEN_NO_WRITE_EVIDENCE_INCOMPLETE');
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.store.queue).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('accepts only exact expected-post proof with an advanced timestamp', async () => {
    const harness = createHarness();
    await makeReady(harness);
    let expectedPost: any;
    harness.client.dispatchBehavior = (request) => {
      expectedPost = structuredClone(request.options.body);
      expectedPost.timestamp = harness.order.timestamp;
      harness.client.orders.set(harness.begin.manufacturingOrderId, expectedPost);
      throw apiError(408, 'response lost');
    };
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('dispatch_uncertain');

    const manuallyEdited = structuredClone(expectedPost);
    manuallyEdited.timestamp = '0000000000000011';
    manuallyEdited.remarks = `${manuallyEdited.remarks}\nmanual edit`;
    harness.client.orders.set(harness.begin.manufacturingOrderId, manuallyEdited);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('dispatch_uncertain');

    expectedPost.timestamp = '0000000000000011';
    harness.client.orders.set(harness.begin.manufacturingOrderId, expectedPost);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('applied_verified');
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('detects begin snapshot/timestamp drift before prepareMutation and never opens a socket', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const drifted = structuredClone(harness.order);
    drifted.timestamp = '0000000000000011';
    drifted.lines[0].manufacturingOrderLines[0].quantity.standardQuantity = '3';
    harness.client.orders.set(harness.begin.manufacturingOrderId, drifted);
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('conflict');
    expect(harness.client.prepareCalls).toEqual([]);
    expect(harness.client.dispatchCalls).toBe(0);
  });

  it('revalidates the exact source binding after request preparation and before the durable dispatch fence', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const originalPrepare = harness.client.prepareMutation.bind(harness.client);
    harness.client.prepareMutation = async (
      method: string,
      path: string,
      options: any
    ) => {
      const prepared = await originalPrepare(method, path, options);
      const donor = harness.client.products.get('source-donor-product');
      donor.inventoryLines.find(
        (line: any) => line.serial === harness.begin.normalizedIdentity.sourceSerial
      ).serial = 'ALTERNATIVE-SERIAL';
      return prepared;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('conflict');
    expect(harness.client.prepareCalls).toHaveLength(1);
    expect(harness.client.dispatchCalls).toBe(0);
    expect(harness.store.transitions.at(-1)?.reason)
      .toMatch(/final dispatch-fence revalidation failed/);
  });

  it('turns an unsupported pre-write shape into a durable conflict before prepareMutation', async () => {
    const harness = createHarness();
    await makeReady(harness);
    const unsupported = structuredClone(harness.order);
    unsupported.pickLines = [{
      manufacturingOrderPickLineId: 'manual-pick',
      manufacturingOrderId: harness.begin.manufacturingOrderId,
      productId: 'repeated-component',
      locationId: 'location-main',
      quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
    }];
    harness.client.orders.set(harness.begin.manufacturingOrderId, unsupported);
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('conflict');
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('honors the shared durable rate budget before every inFlow request', async () => {
    const harness = createHarness();
    await makeReady(harness);
    harness.store.rateLimitAfter = harness.store.rateCalls;
    const result = await harness.coordinator.runOne();
    expect(result).toMatchObject({
      outcome: 'rate_limited',
      retryAfterMs: 60_000,
    });
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'idle',
    });
    expect(harness.client.prepareCalls).toEqual([]);
  });
});

describe('dependencies, operations, restore quarantine, and singleton hooks', () => {
  it('satisfies the exact parent raw line from the child verified put-line identity', async () => {
    const harness = createHarness();
    const dependencyLine = harness.order.lines[0].manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'component-line-a'
    );
    dependencyLine.quantity.standardQuantity = '1';
    dependencyLine.quantity.uomQuantity = '1';
    await createAndCollect(harness);
    const childInput = beginInput('child-success');
    const childIdentity = {
      ...childInput.identity,
      finishedProductId: 'repeated-component',
      finishedSerial: 'SERIAL-A',
      parentRunHash: harness.begin.runHash,
      parentRawLineId: 'component-line-a',
    };
    const childFixture = expandedOrder({ ...childInput, identity: childIdentity });
    harness.client.orders.set(
      childFixture.begin.manufacturingOrderId,
      structuredClone(childFixture.order)
    );
    const child = harness.coordinator.beginChildWithDependency({
      parentOperationId: harness.begin.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: childInput.idempotencyKeyHash,
      identity: {
        schemaVersion: childIdentity.schemaVersion,
        companyId: childIdentity.companyId,
        finishedProductId: childIdentity.finishedProductId,
        sourceSerial: childIdentity.sourceSerial,
        finishedSerial: childIdentity.finishedSerial,
      },
      locationId: childInput.locationId,
      remarks: childInput.remarks,
    });
    await harness.coordinator.runOne();
    for (const intent of componentIntentsForSource(
      childIdentity.sourceSerial
    ).map((row) => ({
      ...row,
      operationId: child.operationId,
      rawLineId: row.rawLineId,
    }))) {
      harness.coordinator.registerComponent(intent);
    }
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(childFixture.begin.manufacturingOrderId, applied);
      return applied;
    };
    await harness.coordinator.runOne();
    expect(harness.store.getRun(child.operationId)?.state).toBe('applied_verified');
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('waiting_dependencies');
    expect(harness.store.listDependencies(harness.begin.operationId)[0]).toMatchObject({
      parentRawLineId: 'component-line-a',
      satisfiedAt: expect.any(String),
    });
    expect(harness.store.listComponentIntents(harness.begin.operationId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          rawLineId: 'component-line-a',
          productId: 'repeated-component',
          serialNumbers: ['SERIAL-A'],
        }),
      ]));
  });

  it('aggregates two verified child puts before making the parent ready', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
    });
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[2],
    });
    const children: Array<{ status: any; fixture: any }> = [];
    for (const [parentChildIndex, serial] of ['SERIAL-A', 'SERIAL-B'].entries()) {
      const childInput = beginInput(`qty-child-${parentChildIndex}`);
      const childIdentity = {
        ...childInput.identity,
        finishedProductId: 'repeated-component',
        finishedSerial: serial,
        parentRunHash: harness.begin.runHash,
        parentRawLineId: 'component-line-a',
      };
      const fixture = expandedOrder({ ...childInput, identity: childIdentity });
      harness.client.orders.set(
        fixture.begin.manufacturingOrderId,
        structuredClone(fixture.order)
      );
      const status = harness.coordinator.beginChildWithDependency({
        parentOperationId: harness.begin.operationId,
        parentRawLineId: 'component-line-a',
        parentChildIndex,
        idempotencyKeyHash: childInput.idempotencyKeyHash,
        identity: {
          schemaVersion: childIdentity.schemaVersion,
          companyId: childIdentity.companyId,
          finishedProductId: childIdentity.finishedProductId,
          sourceSerial: childIdentity.sourceSerial,
          finishedSerial: childIdentity.finishedSerial,
        },
        locationId: childInput.locationId,
        remarks: childInput.remarks,
      });
      children.push({ status, fixture });
    }
    await harness.coordinator.runOne();
    await harness.coordinator.runOne();
    for (const child of children) {
      for (const intent of componentIntentsForSource(
        child.fixture.begin.normalizedIdentity.sourceSerial
      )) {
        harness.coordinator.registerComponent({
          operationId: child.status.operationId,
          ...intent,
        });
      }
    }
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(applied.manufacturingOrderId, applied);
      return applied;
    };

    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('waiting_dependencies');
    expect(harness.store.listComponentIntents(harness.begin.operationId))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ rawLineId: 'component-line-a' }),
      ]));

    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
    expect(harness.store.listComponentIntents(harness.begin.operationId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          rawLineId: 'component-line-a',
          quantity: '2',
          serialized: true,
          serialNumbers: ['SERIAL-A', 'SERIAL-B'],
        }),
      ]));
  });

  it('recovers a crash after durable child satisfaction but before parent intent registration', async () => {
    let crash = true;
    const harness = createHarness({
      testHooks: {
        afterDependencySatisfied: () => {
          if (crash) {
            crash = false;
            throw new Error(
              'WORKER_LEASE_NOT_HELD: simulated parent aggregation crash'
            );
          }
        },
      },
    });
    const dependencyLine = harness.order.lines[0].manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'component-line-a'
    );
    dependencyLine.quantity.standardQuantity = '1';
    dependencyLine.quantity.uomQuantity = '1';
    await createAndCollect(harness);
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[1],
    });
    harness.coordinator.registerComponent({
      operationId: harness.begin.operationId,
      ...componentIntents[2],
    });
    const childInput = beginInput('aggregation-crash-child');
    const childIdentity = {
      ...childInput.identity,
      finishedProductId: 'repeated-component',
      finishedSerial: 'SERIAL-A',
      parentRunHash: harness.begin.runHash,
      parentRawLineId: 'component-line-a',
    };
    const childFixture = expandedOrder({ ...childInput, identity: childIdentity });
    harness.client.orders.set(
      childFixture.begin.manufacturingOrderId,
      structuredClone(childFixture.order)
    );
    const child = harness.coordinator.beginChildWithDependency({
      parentOperationId: harness.begin.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: childInput.idempotencyKeyHash,
      identity: {
        schemaVersion: childIdentity.schemaVersion,
        companyId: childIdentity.companyId,
        finishedProductId: childIdentity.finishedProductId,
        sourceSerial: childIdentity.sourceSerial,
        finishedSerial: childIdentity.finishedSerial,
      },
      locationId: childInput.locationId,
    });
    await harness.coordinator.runOne();
    for (const intent of componentIntentsForSource(
      childIdentity.sourceSerial
    )) {
      harness.coordinator.registerComponent({
        operationId: child.operationId,
        ...intent,
      });
    }
    harness.client.dispatchBehavior = (request) => {
      const applied = structuredClone(request.options.body);
      applied.timestamp = '0000000000000011';
      harness.client.orders.set(childFixture.begin.manufacturingOrderId, applied);
      return applied;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'lease_lost',
    });
    expect(harness.store.listDependencies(harness.begin.operationId)[0])
      .toMatchObject({ satisfiedAt: expect.any(String) });
    expect(harness.store.listComponentIntents(harness.begin.operationId))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ rawLineId: 'component-line-a' }),
      ]));
    expect(harness.coordinator.finalizeSatisfiedDependencyLine({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
    }).state).toBe('ready');
    expect(harness.store.listComponentIntents(harness.begin.operationId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          rawLineId: 'component-line-a',
          serialNumbers: ['SERIAL-A'],
        }),
      ]));
  });

  it('advances a parent after restart when final intent committed before ready transition', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    for (const [index, intent] of componentIntents.entries()) {
      harness.store.registerComponentIntent({
        operationId: harness.begin.operationId,
        ...intent,
        sublocation: intent.sublocation ?? null,
        intentHash: `restart-intent-${index}`,
        createdAt: harness.clock.now(),
      });
    }
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('collecting');

    harness.coordinator.reconcileDurableDependencyOutcomes();

    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
  });

  it('heals a final-intent crash when status is the first request after restart', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    for (const [index, intent] of componentIntents.entries()) {
      harness.store.registerComponentIntent({
        operationId: harness.begin.operationId,
        ...intent,
        sublocation: intent.sublocation ?? null,
        intentHash: `status-restart-intent-${index}`,
        createdAt: harness.clock.now(),
      });
    }
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('collecting');

    await expect(harness.coordinator.status(harness.begin.operationId))
      .resolves.toMatchObject({ state: 'ready' });
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('ready');
  });

  it('fails closed before materializing an unbounded recursive quantity', async () => {
    const harness = createHarness();
    const component = harness.order.lines[0].manufacturingOrderLines.find(
      (line: any) => line.manufacturingOrderLineId === 'component-line-a'
    );
    component.quantity.standardQuantity = '4294967296';
    component.quantity.uomQuantity = '4294967296';
    await createAndCollect(harness);
    harness.store.dependencies.push({
      parentOperationId: harness.begin.operationId,
      childOperationId: 'synthetic-child',
      parentRawLineId: 'component-line-a',
      parentChildIndex: 0,
      createdAt: harness.clock.now().toISOString(),
      satisfiedAt: harness.clock.now().toISOString(),
    });

    expect(() => harness.coordinator.finalizeSatisfiedDependencyLine({
      operationId: harness.begin.operationId,
      rawLineId: 'component-line-a',
    })).not.toThrow();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('blocked');
  });

  it('reconciles a terminal child without verified put evidence by blocking its parent', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    const childInput = beginInput('missing-parent-evidence-child');
    const child = harness.coordinator.beginChildWithDependency({
      parentOperationId: harness.begin.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: childInput.idempotencyKeyHash,
      identity: {
        schemaVersion: childInput.identity.schemaVersion,
        companyId: childInput.identity.companyId,
        finishedProductId: 'repeated-component',
        sourceSerial: childInput.identity.sourceSerial,
        finishedSerial: childInput.identity.finishedSerial,
      },
      locationId: childInput.locationId,
    });
    harness.store.transitionRun({
      operationId: child.operationId,
      expectedRevision: 0,
      toState: 'applied_verified',
      reason: 'simulated crash after terminal child transition',
      at: harness.clock.now(),
    });

    await harness.coordinator.runOne();

    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
    expect(harness.store.listDependencies(harness.begin.operationId)[0])
      .toMatchObject({ satisfiedAt: null });
  });

  it('stages operation-bearing orders exactly once and requires signed manual resolution', async () => {
    const harness = createHarness({ operations: true });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const staged = structuredClone(request.options.body);
      staged.timestamp = '0000000000000011';
      harness.client.orders.set(harness.begin.manufacturingOrderId, staged);
      return staged;
    };
    await harness.coordinator.runOne();
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('staged_awaiting_operations');
    expect(harness.client.prepareCalls[0]!.options.body).toMatchObject({
      isCompleted: false,
      putLines: [],
    });
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('staged_awaiting_operations');
    const approvalEvidence = {
      version: 'manufacturing-run-hmac/v1' as const,
      kid: 'operator-key-1',
      audience: 'zapier-private-app',
      companyId: 'company-fixture',
      timestamp: 1_767_225_600,
      nonce: 'manual-resolution-nonce',
      bodyHash: 'a'.repeat(64),
    };
    const stagedRevision = harness.store.getRun(
      harness.begin.operationId
    )!.stateRevision;
    expect(() => harness.coordinator.resolveManual({
      operationId: harness.begin.operationId,
      expectedRevision: stagedRevision,
      operatorId: 'operator-a',
      action: 'resolve',
      approvedAt: approvalEvidence.timestamp + 1,
      approvalEvidence,
    })).toThrow(/SIGNED_MANUAL_RESOLUTION_REQUIRED/);
    expect(harness.coordinator.resolveManual({
      operationId: harness.begin.operationId,
      expectedRevision: stagedRevision,
      operatorId: 'operator-a',
      action: 'resolve',
      approvedAt: approvalEvidence.timestamp,
      approvalEvidence,
    }).state).toBe('resolved_manual');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `manual_resolution_approval:${stagedRevision}`
    )).toMatchObject({
      artifact: {
        expectedRevision: stagedRevision,
        operatorId: 'operator-a',
        action: 'resolve',
        hmac: approvalEvidence,
      },
    });
    expect(harness.coordinator.resolveManual({
      operationId: harness.begin.operationId,
      expectedRevision: stagedRevision,
      operatorId: 'operator-a',
      action: 'resolve',
      approvedAt: approvalEvidence.timestamp,
      approvalEvidence,
    }).state).toBe('resolved_manual');
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('worker and status reconciliation block every ancestor after a terminal child crash', async () => {
    const harness = createHarness();
    await createAndCollect(harness);
    const childInput = beginInput('manual-child');
    const childFixture = expandedOrder({
      ...childInput,
      identity: {
        ...childInput.identity,
        finishedProductId: 'repeated-component',
        parentRunHash: harness.begin.runHash,
        parentRawLineId: 'component-line-a',
      },
    });
    harness.client.orders.set(
      childFixture.begin.manufacturingOrderId,
      structuredClone(childFixture.order)
    );
    const child = harness.coordinator.beginChildWithDependency({
      parentOperationId: harness.begin.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: childInput.idempotencyKeyHash,
      identity: {
        schemaVersion: childInput.identity.schemaVersion,
        companyId: childInput.identity.companyId,
        finishedProductId: 'repeated-component',
        sourceSerial: childInput.identity.sourceSerial,
        finishedSerial: childInput.identity.finishedSerial,
      },
      locationId: childInput.locationId,
    });
    await harness.coordinator.runOne();
    const grandchildInput = beginInput('manual-grandchild');
    const grandchild = harness.coordinator.beginChildWithDependency({
      parentOperationId: child.operationId,
      parentRawLineId: 'component-line-a',
      idempotencyKeyHash: grandchildInput.idempotencyKeyHash,
      identity: {
        schemaVersion: grandchildInput.identity.schemaVersion,
        companyId: grandchildInput.identity.companyId,
        finishedProductId: 'repeated-component',
        sourceSerial: grandchildInput.identity.sourceSerial,
        finishedSerial: grandchildInput.identity.finishedSerial,
      },
      locationId: grandchildInput.locationId,
    });
    harness.store.transitionRun({
      operationId: grandchild.operationId,
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'operator inspection required',
      at: harness.clock.now(),
    });
    await harness.coordinator.runOne();
    await harness.coordinator.status(grandchild.operationId);
    expect(harness.store.getRun(child.operationId)?.state).toBe('blocked');
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
    const approvalEvidence = {
      version: 'manufacturing-run-hmac/v1' as const,
      kid: 'operator-key-1',
      audience: 'zapier-private-app',
      companyId: 'company-fixture',
      timestamp: 1_767_225_600,
      nonce: 'manual-descendant-nonce',
      bodyHash: 'b'.repeat(64),
    };
    harness.coordinator.resolveManual({
      operationId: grandchild.operationId,
      expectedRevision: 1,
      operatorId: 'operator-a',
      action: 'resolve',
      approvedAt: approvalEvidence.timestamp,
      approvalEvidence,
    });

    expect(harness.store.getRun(child.operationId)?.state).toBe('blocked');
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('blocked');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      `dependency_block:${grandchild.operationId}:2`
    )).toMatchObject({
      artifact: {
        originChildOperationId: grandchild.operationId,
        childState: 'resolved_manual',
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it('automatically completes an exact staged Assembly order behind the dedicated gate', async () => {
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
      providerExtension: 'preserved',
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const body = structuredClone(request.options.body);
      if (harness.client.dispatchCalls === 1) {
        body.timestamp = '0000000000000011';
        applyStagedComponentConsumption(harness);
      } else {
        body.timestamp = '0000000000000012';
        delete body.putLines[0].manufacturingOrderLineId;
        harness.client.products.get('finished-product').inventoryLines = [{
          serial: 'SERIAL-001',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        }];
        harness.client.products.get('source-donor-product').inventoryLines =
          harness.client.products.get('source-donor-product').inventoryLines
            .filter((line: any) => line.serial !== 'SERIAL-001');
      }
      harness.client.orders.set(harness.begin.manufacturingOrderId, body);
      return body;
    };

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'prepared',
    });
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'operation_completion_intent/v1'
    )).toBeDefined();
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'operation_completion_plan/v1'
    )).toBeDefined();

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.client.dispatchCalls).toBe(2);
    expect(harness.client.orders.get(
      harness.begin.manufacturingOrderId
    )).toMatchObject({
      isCompleted: true,
      status: 'completed',
      putLines: [
        expect.objectContaining({
          productId: 'finished-product',
          locationId: 'location-main',
          quantity: expect.objectContaining({ serialNumbers: ['SERIAL-001'] }),
        }),
      ],
    });
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'operation_completion_dispatch_barrier/v1'
    )).toBeDefined();
  });

  it('recovers a lost operation-completion response by readback without replay', async () => {
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const body = structuredClone(request.options.body);
      body.timestamp = harness.client.dispatchCalls === 1
        ? '0000000000000011'
        : '0000000000000012';
      harness.client.orders.set(harness.begin.manufacturingOrderId, body);
      if (harness.client.dispatchCalls === 1) {
        applyStagedComponentConsumption(harness);
      }
      if (harness.client.dispatchCalls === 2) {
        harness.client.products.get('finished-product').inventoryLines = [{
          serial: 'SERIAL-001',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        }];
        harness.client.products.get('source-donor-product').inventoryLines =
          harness.client.products.get('source-donor-product').inventoryLines
            .filter((line: any) => line.serial !== 'SERIAL-001');
        throw new TypeError('fetch failed after provider commit');
      }
      return body;
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'applied_verified',
    });
    expect(harness.client.dispatchCalls).toBe(2);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.client.dispatchCalls).toBe(2);
  });

  it('keeps an exact completion with a non-advanced timestamp uncertain and readback-only', async () => {
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const body = structuredClone(request.options.body);
      body.timestamp = '0000000000000011';
      if (harness.client.dispatchCalls === 1) {
        applyStagedComponentConsumption(harness);
      }
      harness.client.orders.set(harness.begin.manufacturingOrderId, body);
      return body;
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'dispatch_uncertain',
    });
    await expect(harness.coordinator.status(harness.begin.operationId))
      .resolves.toMatchObject({
        state: 'dispatch_uncertain',
        retryMode: 'readback_only',
      });
    expect(harness.client.dispatchCalls).toBe(2);
  });

  it('does not verify completion while any staged component inventory remains', async () => {
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const body = structuredClone(request.options.body);
      body.timestamp = harness.client.dispatchCalls === 1
        ? '0000000000000011'
        : '0000000000000012';
      if (harness.client.dispatchCalls === 1) {
        applyStagedComponentConsumption(harness);
      } else {
        harness.client.products.get('finished-product').inventoryLines = [{
          serial: 'SERIAL-001',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        }];
        harness.client.products.get('repeated-component').inventoryLines = [{
          serial: 'SERIAL-A',
          locationId: 'location-main',
          sublocation: '',
          quantityOnHand: '1',
        }];
      }
      harness.client.orders.set(harness.begin.manufacturingOrderId, body);
      return body;
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'dispatch_uncertain',
    });
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.client.dispatchCalls).toBe(2);
  });

  it('quarantines a partial operation-completion write and never replays it', async () => {
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const body = structuredClone(request.options.body);
      if (harness.client.dispatchCalls === 1) {
        body.timestamp = '0000000000000011';
        applyStagedComponentConsumption(harness);
        harness.client.orders.set(harness.begin.manufacturingOrderId, body);
        return body;
      }
      const partial = structuredClone(
        harness.client.orders.get(harness.begin.manufacturingOrderId)
      );
      partial.timestamp = '0000000000000012';
      partial.lines[0].manufacturingOrderOperations[0].completedDate =
        body.lines[0].manufacturingOrderOperations[0].completedDate;
      harness.client.orders.set(harness.begin.manufacturingOrderId, partial);
      throw new TypeError('connection reset after partial provider write');
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'conflict',
    });
    expect(harness.client.dispatchCalls).toBe(2);
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.client.dispatchCalls).toBe(2);
  });

  it('does not dispatch when the completion gate closes at the final socket fence', async () => {
    let gateChecks = 0;
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => {
        gateChecks += 1;
        return gateChecks < 4;
      },
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const staged = structuredClone(request.options.body);
      staged.timestamp = '0000000000000011';
      applyStagedComponentConsumption(harness);
      harness.client.orders.set(harness.begin.manufacturingOrderId, staged);
      return staged;
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'staged_awaiting_operations',
    });
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'operation_completion_dispatch_barrier/v1'
    )).toBeUndefined();
  });

  it('never redispatches after a crash at the durable completion barrier', async () => {
    let fenceCount = 0;
    const harness = createHarness({
      operations: true,
      operationCompletionGate: () => true,
      testHooks: {
        afterDispatchFenced: () => {
          fenceCount += 1;
          if (fenceCount === 2) {
            throw new Error('simulated crash after completion barrier');
          }
        },
      },
    });
    harness.order.lines[0].manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: harness.begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
    }];
    harness.client.products.set('finished-product', {
      productId: 'finished-product',
      trackSerials: true,
      inventoryLines: [],
    });
    await makeReady(harness);
    harness.client.dispatchBehavior = (request) => {
      const staged = structuredClone(request.options.body);
      staged.timestamp = '0000000000000011';
      applyStagedComponentConsumption(harness);
      harness.client.orders.set(harness.begin.manufacturingOrderId, staged);
      return staged;
    };

    await harness.coordinator.runOne();
    await expect(harness.coordinator.runOne()).rejects.toThrow(
      /simulated crash after completion barrier/
    );
    expect(harness.client.dispatchCalls).toBe(1);
    expect(harness.store.getRun(harness.begin.operationId)?.state)
      .toBe('dispatch_uncertain');
    expect(harness.store.getRunArtifact(
      harness.begin.operationId,
      'operation_completion_dispatch_barrier/v1'
    )).toBeDefined();

    await expect(harness.coordinator.runOne()).resolves.toMatchObject({
      outcome: 'idle',
    });
    await expect(harness.coordinator.status(harness.begin.operationId))
      .resolves.toMatchObject({
        state: 'dispatch_uncertain',
        retryMode: 'readback_only',
      });
    expect(harness.client.dispatchCalls).toBe(1);
  });

  it('keeps restore quarantine and stable status read-only forever', async () => {
    const harness = createHarness();
    harness.coordinator.begin(harness.input);
    harness.store.transitionRun({
      operationId: harness.begin.operationId,
      expectedRevision: 0,
      toState: 'restore_quarantine',
      reason: 'restored backup',
      at: harness.clock.now(),
    });
    await harness.coordinator.status(harness.begin.operationId);
    expect(harness.store.getRun(harness.begin.operationId)?.state).toBe('restore_quarantine');
    expect(harness.client.getCalls).toEqual([]);
    expect(harness.client.prepareCalls).toEqual([]);
  });

  it('validates one launchd service, exclusive loopback ownership, process lock, store lease and 20 rpm', () => {
    const validate = exported('validateCoordinatorSingletonConfig');
    expect(validate({
      listenerHost: '127.0.0.1',
      listenerExclusive: true,
      processLockPath: '/var/run/inflow-manufacturing.lock',
      workerLeaseMs: 30_000,
      launchdServiceLabels: ['com.YOUR_COMPANY.biz.inflow-manufacturing-coordinator'],
      requestsPerMinute: 20,
    })).toMatchObject({ requestsPerMinute: 20, listenerHost: '127.0.0.1' });
    expect(() => validate({
      listenerHost: '0.0.0.0',
      listenerExclusive: true,
      processLockPath: '/var/run/inflow-manufacturing.lock',
      workerLeaseMs: 30_000,
      launchdServiceLabels: ['one', 'two'],
      requestsPerMinute: 21,
    })).toThrow(/COORDINATOR_SINGLETON_CONFIG_INVALID/);
  });

  it('holds a non-stale process lock exclusively until the owner releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inflow-coordinator-lock-'));
    const lockPath = join(directory, 'coordinator.lock');
    const acquire = exported('acquireNonStaleProcessLock');
    const lock = acquire(lockPath, process.pid);
    expect(() => acquire(lockPath, process.pid)).toThrow(/PROCESS_LOCK_HELD/);
    lock.release();
    const replacement = acquire(lockPath, process.pid);
    replacement.release();
    await rm(directory, { recursive: true, force: true });
  });

  it('fails closed if a stale process lock name is swapped before removal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inflow-coordinator-lock-race-'));
    const lockPath = join(directory, 'coordinator.lock');
    const acquire = exported('acquireNonStaleProcessLock');
    await writeFile(lockPath, JSON.stringify({ pid: 999_999 }), { mode: 0o600 });

    expect(() => acquire(lockPath, process.pid, {
      beforeStaleRename: () => {
        rmSync(lockPath);
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid }),
          { mode: 0o600 }
        );
      },
    })).toThrow(/PROCESS_LOCK_IDENTITY_CHANGED/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
    });
    await rm(directory, { recursive: true, force: true });
  });

  it('fails closed if the owned process lock name is swapped during release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'inflow-coordinator-release-race-'));
    const lockPath = join(directory, 'coordinator.lock');
    const acquire = exported('acquireNonStaleProcessLock');
    const lock = acquire(lockPath, process.pid, {
      beforeReleaseRename: () => {
        rmSync(lockPath);
        writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid + 1 }),
          { mode: 0o600 }
        );
      },
    });

    expect(() => lock.release()).toThrow(/PROCESS_LOCK_IDENTITY_CHANGED/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: process.pid + 1,
    });
    await rm(directory, { recursive: true, force: true });
  });
});
