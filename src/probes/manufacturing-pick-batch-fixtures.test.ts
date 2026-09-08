import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureApprovalPlanHash,
  fixtureManifestHash,
  parseManufacturingPickBatchFixtureCommandArguments,
  parseManufacturingPickBatchFixtureApproval,
  parseManufacturingPickBatchFixtureManifest,
  runManufacturingPickBatchFixtureCommand,
  runManufacturingPickBatchFixtureCommandFromEnvironment,
  type ManufacturingPickBatchFixtureApproval,
  type ManufacturingPickBatchFixtureManifest,
} from './manufacturing-pick-batch-fixtures.js';

const roots: string[] = [];
const secureTempRoot = process.platform === 'linux' ? '/tmp' : tmpdir();
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ids = {
  complete: '00000000-0000-4000-8000-000000000001',
  staging: '00000000-0000-4000-8000-000000000002',
  serialized: '00000000-0000-4000-8000-000000000003',
  bulk: '00000000-0000-4000-8000-000000000004',
  completeSubassemblyBom: '00000000-0000-4000-8000-000000000005',
  stagingSubassemblyBom: '00000000-0000-4000-8000-000000000006',
  subassemblySerializedBom: '00000000-0000-4000-8000-000000000007',
  subassemblyBulkBom: '00000000-0000-4000-8000-000000000008',
  operation: '00000000-0000-4000-8000-000000000009',
  seed: '00000000-0000-4000-8000-000000000010',
  reverse: '00000000-0000-4000-8000-000000000011',
  seedSerialized: '00000000-0000-4000-8000-000000000012',
  seedBulk: '00000000-0000-4000-8000-000000000013',
  reversalSerialized: '00000000-0000-4000-8000-000000000014',
  reversalBulk: '00000000-0000-4000-8000-000000000015',
  subassembly: '00000000-0000-4000-8000-000000000016',
};

function manifest(): ManufacturingPickBatchFixtureManifest {
  return {
    schemaVersion: 'manufacturing-pick-batch-fixture-manifest/v2',
    scenarioId: 'mpb-canary-260731-a1',
    marker: '__MPB_CANARY__260731_A1',
    tenantFingerprint: 'tenant-sha',
    baseHost: 'cloudapi.inflowinventory.com',
    apiVersion: '2026-04-13',
    probeBuild: 'probe-sha',
    adapterManifestHash: 'adapter-sha',
    locationId: 'location-main',
    categoryId: 'category-inert',
    adjustmentDate: '2026-07-31T12:00:00.000Z',
    adjustmentReasonIds: { add: 'reason-add', remove: 'reason-remove' },
    operationTypeId: 'operation-assembly',
    products: {
      finishedComplete: { productId: ids.complete, name: '__MPB_CANARY__260731_A1 finished complete', sku: 'MPB-CANARY-260731-A1-FC' },
      finishedStaging: { productId: ids.staging, name: '__MPB_CANARY__260731_A1 finished staging', sku: 'MPB-CANARY-260731-A1-FS' },
      expandedSubassembly: { productId: ids.subassembly, name: '__MPB_CANARY__260731_A1 expanded subassembly', sku: 'MPB-CANARY-260731-A1-SA' },
      serializedInput: { productId: ids.serialized, name: '__MPB_CANARY__260731_A1 serialized input', sku: 'MPB-CANARY-260731-A1-SI' },
      bulkInput: { productId: ids.bulk, name: '__MPB_CANARY__260731_A1 bulk input', sku: 'MPB-CANARY-260731-A1-BI' },
    },
    serials: ['MPB-CANARY-260731-A1-SERIAL-A', 'MPB-CANARY-260731-A1-SERIAL-B'],
    quantities: { serialized: '2', bulk: '4' },
    itemBomIds: {
      finishedCompleteSubassembly: ids.completeSubassemblyBom,
      finishedStagingSubassembly: ids.stagingSubassemblyBom,
      expandedSubassemblySerialized: ids.subassemblySerializedBom,
      expandedSubassemblyBulk: ids.subassemblyBulkBom,
    },
    productOperationId: ids.operation,
    stockAdjustmentIds: { seed: ids.seed, reversal: ids.reverse },
    stockAdjustmentItemIds: {
      seedSerialized: ids.seedSerialized,
      seedBulk: ids.seedBulk,
      reversalSerialized: ids.reversalSerialized,
      reversalBulk: ids.reversalBulk,
    },
    approvedInertArtifactIds: [ids.complete, ids.staging, ids.subassembly, ids.serialized, ids.bulk, ids.seed, ids.reverse],
  };
}

function legacyManifest(): ManufacturingPickBatchFixtureManifest {
  const value = manifest();
  const { expandedSubassembly: _expandedSubassembly, ...products } = value.products;
  return {
    ...value,
    schemaVersion: 'manufacturing-pick-batch-fixture-manifest/v1',
    products,
    itemBomIds: {
      finishedCompleteSerialized: ids.completeSubassemblyBom,
      finishedCompleteBulk: ids.stagingSubassemblyBom,
      finishedStagingSerialized: ids.subassemblySerializedBom,
      finishedStagingBulk: ids.subassemblyBulkBom,
    },
    approvedInertArtifactIds: [ids.complete, ids.staging, ids.serialized, ids.bulk, ids.seed, ids.reverse],
  };
}

function transitionalExpandedV1Manifest(): ManufacturingPickBatchFixtureManifest {
  return {
    ...manifest(),
    schemaVersion: 'manufacturing-pick-batch-fixture-manifest/v1',
  };
}

function approval(
  value: ManufacturingPickBatchFixtureManifest,
  stage: ManufacturingPickBatchFixtureApproval['stage'],
): ManufacturingPickBatchFixtureApproval {
  return {
    schemaVersion: 'manufacturing-pick-batch-fixture-approval/v1',
    approved: true,
    stage,
    approvalNonce: `approval-${stage}`,
    manifestHash: fixtureManifestHash(value),
    stagePlanHash: fixtureApprovalPlanHash(value, stage),
    tenantFingerprint: value.tenantFingerprint,
    baseHost: value.baseHost,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
    scenarioId: value.scenarioId,
    issuedAt: '2026-07-31T11:59:00.000Z',
    expiresAt: '2026-07-31T12:10:00.000Z',
  };
}

function runtimeIdentity(value = manifest()) {
  return {
    tenantFingerprint: value.tenantFingerprint,
    baseHost: value.baseHost,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
  };
}

describe('manufacturing pick-batch fixture contracts', () => {
  it('strictly parses a manifest and rejects unknown, duplicate, or non-marker identities', () => {
    expect(parseManufacturingPickBatchFixtureManifest(manifest())).toEqual(manifest());
    expect(() => parseManufacturingPickBatchFixtureManifest({ ...manifest(), surprise: true })).toThrow(/surprise.*not allowed/i);
    expect(() => parseManufacturingPickBatchFixtureManifest({ ...manifest(), serials: [manifest().serials[0], manifest().serials[0]] })).toThrow(/serials.*unique/i);
    expect(() => parseManufacturingPickBatchFixtureManifest({
      ...manifest(),
      products: { ...manifest().products, bulkInput: { ...manifest().products.bulkInput, sku: 'NORMAL-SKU' } },
    })).toThrow(/marker/i);
  });

  it('strictly parses and binds an unexpired stage approval to every deployment identity', () => {
    const value = manifest();
    expect(parseManufacturingPickBatchFixtureApproval(approval(value, 'create-products'), value, 'create-products', new Date('2026-07-31T12:00:00Z'))).toMatchObject({ approved: true });
    expect(() => parseManufacturingPickBatchFixtureApproval({ ...approval(value, 'create-products'), probeBuild: 'other' }, value, 'create-products', new Date('2026-07-31T12:00:00Z'))).toThrow(/probeBuild/i);
    expect(() => parseManufacturingPickBatchFixtureApproval(approval(value, 'seed-stock'), value, 'create-products', new Date('2026-07-31T12:00:00Z'))).toThrow(/stage/i);
    expect(() => parseManufacturingPickBatchFixtureApproval(approval(value, 'create-products'), value, 'create-products', new Date('2026-07-31T12:11:00Z'))).toThrow(/expired/i);
    expect(() => parseManufacturingPickBatchFixtureApproval({ ...approval(value, 'create-products'), extra: true }, value, 'create-products', new Date('2026-07-31T12:00:00Z'))).toThrow(/extra.*not allowed/i);
    expect(parseManufacturingPickBatchFixtureManifest({ ...value, adjustmentReasonIds: { add: 'reason-correction', remove: 'reason-correction' } }).adjustmentReasonIds).toEqual({ add: 'reason-correction', remove: 'reason-correction' });
  });

  it('strictly parses the CLI surface and rejects mutation commands without an approval file', () => {
    expect(parseManufacturingPickBatchFixtureCommandArguments([
      '--command', 'plan', '--manifest', '/tmp/manifest.json', '--state-dir', '/tmp/state', '--owner-id', 'owner-a',
    ])).toMatchObject({ command: 'plan', manifestPath: '/tmp/manifest.json' });
    expect(() => parseManufacturingPickBatchFixtureCommandArguments([
      '--command', 'seed-stock', '--manifest', '/tmp/manifest.json', '--state-dir', '/tmp/state', '--owner-id', 'owner-a',
    ])).toThrow(/approval is required/i);
    expect(() => parseManufacturingPickBatchFixtureCommandArguments([
      '--command', 'plan', '--manifest', '/tmp/manifest.json', '--state-dir', '/tmp/state', '--owner-id', 'owner-a', '--wat', 'no',
    ])).toThrow(/unsupported flag/i);
  });
});

describe('fixture command fail-closed state', () => {
  it('uses the provider-supported default list projection for residual discovery', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value);
    await runManufacturingPickBatchFixtureCommand({
      command: 'plan', manifest: value, client, stateDir, ownerId: 'owner-a',
      runtimeIdentity: runtimeIdentity(value), now: new Date('2026-07-31T12:00:00Z'),
    });
    expect(client.listOptions).toEqual([
      expect.objectContaining({ path: '/products', options: expect.not.objectContaining({ include: expect.anything() }) }),
      expect.objectContaining({ path: '/stock-adjustments', options: expect.not.objectContaining({ include: expect.anything() }) }),
    ]);
    expect(client.productReadOptions).toHaveLength(5);
    expect(client.productReadOptions.every(({ include }) =>
      Array.isArray(include) && !include.includes('customFields'))).toBe(true);
  });

  it('creates owner-only state and lock files during a read-only plan', async () => {
    const stateDir = await mkdtemp(join(secureTempRoot, 'mpb-fixtures-'));
    roots.push(stateDir);
    let lockMode: number | undefined;
    const client = noArtifactClient();
    const result = await runManufacturingPickBatchFixtureCommand({
      command: 'plan', manifest: manifest(), client, stateDir, ownerId: 'owner-a',
      runtimeIdentity: runtimeIdentity(),
      hooks: { lockAcquired: async (path) => { lockMode = (await stat(path)).mode & 0o777; } },
      now: new Date('2026-07-31T12:00:00Z'),
    });
    expect(result.stage).toBe('planned');
    expect(lockMode).toBe(0o600);
    const checkpointPath = join(stateDir, 'manufacturing-pick-batch-fixtures.json');
    expect((await stat(checkpointPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({ ownerId: 'owner-a', stage: 'planned' });
  });

  it('rejects a checkpoint that became group-readable', async () => {
    const stateDir = await mkdtemp(join(secureTempRoot, 'mpb-fixtures-'));
    roots.push(stateDir);
    const input = { command: 'plan' as const, manifest: manifest(), client: noArtifactClient(), stateDir, ownerId: 'owner-a', runtimeIdentity: runtimeIdentity(), now: new Date('2026-07-31T12:00:00Z') };
    await runManufacturingPickBatchFixtureCommand(input);
    await chmod(join(stateDir, 'manufacturing-pick-batch-fixtures.json'), 0o640);
    await expect(runManufacturingPickBatchFixtureCommand(input)).rejects.toThrow(/owner.only/i);
  });

  it('rejects a group-writable state directory before creating a lock', async () => {
    const stateDir = await fixtureStateDir();
    await chmod(stateDir, 0o770);
    await expect(runManufacturingPickBatchFixtureCommand({
      command: 'plan', manifest: manifest(), client: noArtifactClient(), stateDir, ownerId: 'owner-a',
      runtimeIdentity: runtimeIdentity(), now: new Date('2026-07-31T12:00:00Z'),
    })).rejects.toThrow(/STATE_DIR_NOT_OWNER_ONLY/);
  });

  it('binds the environment-facing command to the runtime identity', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const manifestPath = join(stateDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(value), { mode: 0o600 });
    const client = new MemoryFixtureClient(value);
    const env = {
      INFLOW_TENANT_FINGERPRINT: value.tenantFingerprint,
      INFLOW_BASE_HOST: value.baseHost,
      INFLOW_API_VERSION: value.apiVersion,
      INFLOW_PROBE_BUILD: value.probeBuild,
      INFLOW_ADAPTER_MANIFEST_HASH: value.adapterManifestHash,
    };
    const result = await runManufacturingPickBatchFixtureCommandFromEnvironment({
      argv: ['--command', 'plan', '--manifest', manifestPath, '--state-dir', stateDir, '--owner-id', 'owner-a'],
      env,
      client,
      now: new Date('2026-07-31T12:00:00Z'),
    });
    expect(result.stage).toBe('planned');
    await expect(runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'status'),
      runtimeIdentity: { ...runtimeIdentity(value), probeBuild: 'wrong' },
    })).rejects.toThrow(/RUNTIME_IDENTITY_MISMATCH: probeBuild/);
  });

  it('persists a pre-socket barrier and never dispatches an ambiguous resume', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value);
    await planFixture(client, stateDir, value);
    const barrierEvents: string[] = [];
    await expect(runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'create-products'),
      approval: approval(value, 'create-products'),
      hooks: {
        checkpointDurable: () => { barrierEvents.push('checkpoint-durable'); },
        beforeDispatch: () => {
          barrierEvents.push('before-dispatch');
          expect(barrierEvents.at(-2)).toBe('checkpoint-durable');
          throw new Error('process-crash-before-socket');
        },
      },
    })).rejects.toThrow('process-crash-before-socket');
    expect(client.dispatchCalls).toBe(0);
    expect(barrierEvents.slice(-2)).toEqual(['checkpoint-durable', 'before-dispatch']);
    const saved = JSON.parse(await readFile(join(stateDir, 'manufacturing-pick-batch-fixtures.json'), 'utf8'));
    expect(saved.inFlight).toMatchObject({ dispatchState: 'dispatching', stage: 'create-products', mutationIndex: 0 });
    await expect(runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'create-products'),
      approval: approval(value, 'create-products'),
    })).rejects.toThrow(/NO_RETRY/);
    expect(client.dispatchCalls).toBe(0);
  });

  it('recovers an applied response-loss by exact readback without a retry', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { responseLossMutation: 1 });
    await planFixture(client, stateDir, value);
    const created = await runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'create-products'),
      approval: approval(value, 'create-products'),
    });
    expect(created.stage).toBe('products-created');
    expect(client.dispatchCalls).toBe(5);
    expect(client.preparedCalls).toBe(5);
    expect(client.preparedBodies[0]).toMatchObject({ itemType: 'StockedProduct' });
    expect(client.preparedBodies[0]).not.toHaveProperty('isManufacturable');
  });

  it('accepts the provider-normalized itemType spelling during exact readback', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { providerNormalizedItemType: true });
    await planFixture(client, stateDir, value);
    const created = await runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'create-products'),
      approval: approval(value, 'create-products'),
    });
    expect(created.stage).toBe('products-created');
    expect(client.dispatchCalls).toBe(5);
  });

  it('rejects a partial product readback after one dispatch', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { partialProductReadback: true });
    await planFixture(client, stateDir, value);
    await expect(runManufacturingPickBatchFixtureCommand({
      ...commandInput(client, stateDir, value, 'create-products'),
      approval: approval(value, 'create-products'),
    })).rejects.toThrow(/PARTIAL_READBACK/);
    expect(client.dispatchCalls).toBe(1);
  });

  it('runs the exact staged seed, handoff, reversal, config cleanup, deactivation, and residual proof', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value);
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    const seeded = await runApproved(client, stateDir, value, 'seed-stock');
    expect(seeded.stage).toBe('stock-seeded');
    expect(client.seeded).toBe(true);
    expect(client.adjustmentReadOptions.every((options) => JSON.stringify(options?.include) === JSON.stringify(['lines']))).toBe(true);
    expect(client.products.get(value.products.finishedComplete.productId)?.isManufacturable).toBe(true);
    expect(client.products.get(value.products.finishedStaging.productId)?.isManufacturable).toBe(true);
    expect(client.products.get(value.products.expandedSubassembly!.productId)).toMatchObject({
      isManufacturable: true,
      trackSerials: false,
      itemBoms: [
        { childProductId: value.products.serializedInput.productId, quantity: { standardQuantity: '1' } },
        { childProductId: value.products.bulkInput.productId, quantity: { standardQuantity: '2' } },
      ],
      productOperations: [],
    });
    expect(client.products.get(value.products.finishedComplete.productId)?.itemBoms).toEqual([
      expect.objectContaining({ childProductId: value.products.expandedSubassembly!.productId }),
    ]);
    expect(client.products.get(value.products.finishedStaging.productId)?.itemBoms).toEqual([
      expect.objectContaining({ childProductId: value.products.expandedSubassembly!.productId }),
    ]);
    const handoff = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'handoff'));
    expect(handoff.stage).toBe('handoff-complete');
    await runApproved(client, stateDir, value, 'reverse-stock');
    expect(client.seeded).toBe(false);
    await runApproved(client, stateDir, value, 'clear-config');
    await runApproved(client, stateDir, value, 'deactivate-products');
    const final = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'));
    expect(final.stage).toBe('complete');
    expect(final.approvedInertResiduals).toHaveLength(7);
    expect([...client.products.values()].every((product) => product.isActive === false && product.itemBoms.length === 0 && product.productOperations.length === 0)).toBe(true);
    expect(client.adjustments.get(ids.reverse)?.lines.map((line: any) => line.quantity.standardQuantity)).toEqual(['-2.0000', '-4.0000']);
  });

  it('retains the legacy v1 direct-leaf lifecycle and cleanup path', async () => {
    const stateDir = await fixtureStateDir();
    const value = legacyManifest();
    const client = new MemoryFixtureClient(value);
    await completeThroughDeactivation(client, stateDir, value);
    const final = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'));
    expect(final.stage).toBe('complete');
    expect(final.approvedInertResiduals).toHaveLength(6);
    expect(client.products.get(value.products.finishedComplete.productId)?.itemBoms).toEqual([]);
    expect(client.products.get(value.products.finishedStaging.productId)?.itemBoms).toEqual([]);
  });

  it('retains cleanup compatibility for expanded fixtures written under the transitional v1 label', async () => {
    const stateDir = await fixtureStateDir();
    const value = transitionalExpandedV1Manifest();
    const client = new MemoryFixtureClient(value);
    await completeThroughDeactivation(client, stateDir, value);
    const final = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'));
    expect(final.stage).toBe('complete');
    expect(final.approvedInertResiduals).toHaveLength(7);
  });

  it('adopts exact externally applied seed and reversal adjustments without redispatching', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value);
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    client.applyExternalStockAdjustment('seed');
    const dispatchesBeforeSeedRecovery = client.dispatchCalls;
    const seeded = await runApproved(client, stateDir, value, 'seed-stock');
    expect(seeded.stage).toBe('stock-seeded');
    expect(client.dispatchCalls).toBe(dispatchesBeforeSeedRecovery);
    await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'handoff'));
    client.applyExternalStockAdjustment('reversal');
    const dispatchesBeforeReversalRecovery = client.dispatchCalls;
    const reversed = await runApproved(client, stateDir, value, 'reverse-stock');
    expect(reversed.stage).toBe('stock-reversed');
    expect(client.dispatchCalls).toBe(dispatchesBeforeReversalRecovery);
  });

  it('accepts provider-normalized adjustment line IDs while retaining exact semantic and stock proof', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { providerNormalizedLineIds: true });
    await completeThroughDeactivation(client, stateDir, value);
    const final = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'));
    expect(final.stage).toBe('complete');
    expect(client.adjustments.get(ids.seed)?.lines.map((line: any) => line.stockAdjustmentLineId)).toEqual(['provider-line-seed-0', 'provider-line-seed-1']);
    expect(client.adjustments.get(ids.reverse)?.lines.map((line: any) => line.stockAdjustmentLineId)).toEqual(['provider-line-reversal-0', 'provider-line-reversal-1']);
  });

  it('accepts provider-derived available quantities while BOM config is active', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { providerDerivedAvailability: true });
    await completeThroughDeactivation(client, stateDir, value);
    const final = await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'));
    expect(final.stage).toBe('complete');
    expect(client.availabilitySamples).toContain('seeded:1.0000/2.0000');
    expect(client.availabilitySamples).toContain('reversed:-1.0000/-2.0000');
  });

  it('blocks seed approval when the exact stock projection does not move', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { seedMovementBroken: true });
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    await expect(runApproved(client, stateDir, value, 'seed-stock')).rejects.toThrow(/STOCK_MISMATCH/);
    expect(client.dispatchCalls).toBe(9);
  });

  it('rejects stock-adjustment metadata that lacks the full lines projection', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { omitAdjustmentLines: true });
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    await expect(runApproved(client, stateDir, value, 'seed-stock')).rejects.toThrow(/stock-adjustment.lines/);
    expect(client.dispatchCalls).toBe(9);
  });

  it.each([
    'missing-line', 'missing-id', 'duplicate-id', 'extra-line', 'wrong-product', 'wrong-quantity', 'wrong-serial',
  ] as const)('blocks a seed adjustment with %s line readback', async (adjustmentLineCorruption) => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { adjustmentLineCorruption });
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    await expect(runApproved(client, stateDir, value, 'seed-stock')).rejects.toThrow(/PARTIAL_READBACK|PARTIAL_OR_MISSING_READBACK|AMBIGUOUS_WRITE/);
    expect(client.dispatchCalls).toBe(9);
  });

  it('blocks cleanup when reversal does not restore the exact baseline', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value, { reversalMovementBroken: true });
    await planFixture(client, stateDir, value);
    await runApproved(client, stateDir, value, 'create-products');
    await runApproved(client, stateDir, value, 'configure-products');
    await runApproved(client, stateDir, value, 'seed-stock');
    await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'handoff'));
    await expect(runApproved(client, stateDir, value, 'reverse-stock')).rejects.toThrow(/STOCK_MISMATCH/);
    expect(client.seeded).toBe(true);
  });

  it('fails final residual discovery on an unexpected exact marker artifact', async () => {
    const stateDir = await fixtureStateDir();
    const value = manifest();
    const client = new MemoryFixtureClient(value);
    await completeThroughDeactivation(client, stateDir, value);
    for (let index = 0; index < 101; index += 1) {
      client.extraProducts.push({ productId: `unmarked-${index}`, name: `ordinary product ${index}`, sku: `ORDINARY-${index}`, customFields: { custom1: '' } });
    }
    client.extraProducts.push({ productId: '00000000-0000-4000-8000-000000000099', name: 'unexpected hidden marker product', sku: 'UNRELATED-DISPLAY-SKU', customFields: { custom1: value.marker } });
    await expect(runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'verify-cleanup'))).rejects.toThrow(/UNEXPECTED_MARKER_ARTIFACTS/);
  });
});

function noArtifactClient() {
  return {
    get: vi.fn(async () => { const error = Object.assign(new Error('not found'), { statusCode: 404 }); throw error; }),
    postRead: vi.fn(),
    getList: vi.fn(async () => ({ data: [] })),
    prepareMutation: vi.fn(),
  } as any;
}

async function fixtureStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(secureTempRoot, 'mpb-fixtures-'));
  roots.push(stateDir);
  return stateDir;
}

function commandInput(
  client: MemoryFixtureClient,
  stateDir: string,
  value: ManufacturingPickBatchFixtureManifest,
  command: Parameters<typeof runManufacturingPickBatchFixtureCommand>[0]['command'],
) {
  return {
    command,
    manifest: value,
    client: client as any,
    stateDir,
    ownerId: 'owner-a',
    runtimeIdentity: runtimeIdentity(value),
    now: new Date('2026-07-31T12:00:00Z'),
  };
}

async function planFixture(client: MemoryFixtureClient, stateDir: string, value: ManufacturingPickBatchFixtureManifest) {
  return runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'plan'));
}

async function runApproved(
  client: MemoryFixtureClient,
  stateDir: string,
  value: ManufacturingPickBatchFixtureManifest,
  stage: ManufacturingPickBatchFixtureApproval['stage'],
) {
  return runManufacturingPickBatchFixtureCommand({ ...commandInput(client, stateDir, value, stage), approval: approval(value, stage) });
}

async function completeThroughDeactivation(client: MemoryFixtureClient, stateDir: string, value: ManufacturingPickBatchFixtureManifest) {
  await planFixture(client, stateDir, value);
  await runApproved(client, stateDir, value, 'create-products');
  await runApproved(client, stateDir, value, 'configure-products');
  await runApproved(client, stateDir, value, 'seed-stock');
  await runManufacturingPickBatchFixtureCommand(commandInput(client, stateDir, value, 'handoff'));
  await runApproved(client, stateDir, value, 'reverse-stock');
  await runApproved(client, stateDir, value, 'clear-config');
  await runApproved(client, stateDir, value, 'deactivate-products');
}

interface MemoryOptions {
  responseLossMutation?: number;
  partialProductReadback?: boolean;
  seedMovementBroken?: boolean;
  reversalMovementBroken?: boolean;
  omitAdjustmentLines?: boolean;
  providerNormalizedLineIds?: boolean;
  providerNormalizedItemType?: boolean;
  providerDerivedAvailability?: boolean;
  adjustmentLineCorruption?: 'missing-line' | 'missing-id' | 'duplicate-id' | 'extra-line' | 'wrong-product' | 'wrong-quantity' | 'wrong-serial';
}

class MemoryFixtureClient {
  readonly products = new Map<string, any>();
  readonly adjustments = new Map<string, any>();
  readonly extraProducts: any[] = [];
  readonly preparedBodies: any[] = [];
  readonly adjustmentReadOptions: any[] = [];
  readonly listOptions: any[] = [];
  readonly productReadOptions: any[] = [];
  readonly availabilitySamples: string[] = [];
  preparedCalls = 0;
  dispatchCalls = 0;
  seeded = false;
  private lastSerializedAvailability = '0.0000';

  constructor(private readonly value: ManufacturingPickBatchFixtureManifest, private readonly options: MemoryOptions = {}) {}

  applyExternalStockAdjustment(direction: 'seed' | 'reversal'): void {
    const seed = direction === 'seed';
    this.apply('/stock-adjustments', {
      stockAdjustmentId: seed ? this.value.stockAdjustmentIds.seed : this.value.stockAdjustmentIds.reversal,
      date: this.value.adjustmentDate,
      locationId: this.value.locationId,
      adjustmentReasonId: seed ? this.value.adjustmentReasonIds.add : this.value.adjustmentReasonIds.remove,
      lines: [
        {
          stockAdjustmentLineId: seed
            ? this.value.stockAdjustmentItemIds.seedSerialized
            : this.value.stockAdjustmentItemIds.reversalSerialized,
          productId: this.value.products.serializedInput.productId,
          quantity: {
            standardQuantity: seed ? '2' : '-2',
            uomQuantity: seed ? '2' : '-2',
            uom: '',
            serialNumbers: [...this.value.serials],
          },
        },
        {
          stockAdjustmentLineId: seed
            ? this.value.stockAdjustmentItemIds.seedBulk
            : this.value.stockAdjustmentItemIds.reversalBulk,
          productId: this.value.products.bulkInput.productId,
          quantity: {
            standardQuantity: seed ? '4' : '-4',
            uomQuantity: seed ? '4' : '-4',
            uom: '',
            serialNumbers: [],
          },
        },
      ],
      remarks: `${this.value.marker} ${direction}`,
      customFields: {
        custom1: this.value.marker,
        custom2: this.value.scenarioId,
        custom3: direction,
      },
    });
  }

  async get(path: string, options?: any): Promise<any> {
    if (path.startsWith('/products/')) {
      this.productReadOptions.push(structuredClone(options));
      const id = path.slice('/products/'.length);
      const product = this.products.get(id);
      if (!product) throw notFound();
      const copy = structuredClone(product);
      if (this.options.providerNormalizedItemType) copy.itemType = 'stockedProduct';
      copy.inventoryLines = !this.seeded
        ? []
        : id === this.value.products.serializedInput.productId
          ? this.value.serials.map((serial) => ({ productId: id, serial, locationId: this.value.locationId, sublocation: '', quantityOnHand: '1.0000' }))
          : id === this.value.products.bulkInput.productId
            ? [{ productId: id, serial: '', locationId: this.value.locationId, sublocation: '', quantityOnHand: '4.0000' }]
            : [];
      if (this.options.partialProductReadback) delete copy.inventoryLines;
      return copy;
    }
    if (path.startsWith('/stock-adjustments/')) {
      this.adjustmentReadOptions.push(structuredClone(options));
      const adjustment = this.adjustments.get(path.slice('/stock-adjustments/'.length));
      if (!adjustment) throw notFound();
      const copy = structuredClone(adjustment);
      if (this.options.omitAdjustmentLines) delete copy.lines;
      return copy;
    }
    throw new Error(`unexpected GET ${path}`);
  }

  async postRead(path: string): Promise<any> {
    if (path !== '/products/summary') throw new Error(`unexpected POST_READ ${path}`);
    const configured =
      (this.products.get(this.value.products.finishedComplete.productId)?.itemBoms?.length ?? 0) > 0 ||
      (this.products.get(this.value.products.finishedStaging.productId)?.itemBoms?.length ?? 0) > 0 ||
      (this.products.get(this.value.products.expandedSubassembly?.productId ?? '')?.itemBoms?.length ?? 0) > 0;
    return [this.value.products.serializedInput, this.value.products.bulkInput].map((identity) => {
      const quantity = !this.seeded ? '0.0000' : identity.productId === this.value.products.serializedInput.productId ? '2.0000' : '4.0000';
      let available = quantity;
      if (this.options.providerDerivedAvailability && configured) {
        available = this.seeded
          ? identity.productId === this.value.products.serializedInput.productId ? '1.0000' : '2.0000'
          : identity.productId === this.value.products.serializedInput.productId ? '-1.0000' : '-2.0000';
      }
      if (this.options.providerDerivedAvailability && identity.productId === this.value.products.bulkInput.productId) {
        this.availabilitySamples.push(`${this.seeded ? 'seeded' : 'reversed'}:${this.lastSerializedAvailability}/${available}`);
      }
      if (this.options.providerDerivedAvailability && identity.productId === this.value.products.serializedInput.productId) {
        this.lastSerializedAvailability = available;
      }
      return {
        productId: identity.productId,
        quantityOnHand: quantity,
        quantityAvailable: available,
        quantityOnOrder: '0.0000',
        quantityAllocated: '0.0000',
        locationSummaries: !this.seeded ? [] : [{
          locationId: this.value.locationId,
          locationName: 'Canary',
          quantityOnHand: quantity,
          quantityAvailable: available,
          sublocationSummaries: [],
        }],
      };
    });
  }

  async getList(path: string, options?: any): Promise<any> {
    this.listOptions.push({ path, options: structuredClone(options) });
    const skip = options?.pagination?.skip ?? 0;
    const count = options?.pagination?.count ?? 100;
    let rows = path === '/products'
      ? [...this.products.values(), ...this.extraProducts]
      : path === '/stock-adjustments'
        ? [...this.adjustments.values()]
        : [];
    if (path === '/products' && options?.filters?.smart) {
      const query = String(options.filters.smart);
      rows = rows.filter((row) => String(row.name ?? '').includes(query) || String(row.sku ?? '').includes(query));
    }
    if (path === '/products' && options?.filters?.name) {
      const query = String(options.filters.name);
      rows = rows.filter((row) => String(row.name ?? '').includes(query));
    }
    return { data: structuredClone(rows.slice(skip, skip + count)), totalCount: rows.length };
  }

  async prepareMutation(_method: string, path: string, options?: { body?: any }): Promise<any> {
    this.preparedCalls += 1;
    const mutationNumber = this.preparedCalls;
    const body = structuredClone(options?.body);
    this.preparedBodies.push(structuredClone(body));
    return {
      correlationId: `correlation-${mutationNumber}`,
      dispatch: async () => {
        this.dispatchCalls += 1;
        this.apply(path, body);
        if (this.options.responseLossMutation === mutationNumber) throw new Error('simulated response loss');
        return {};
      },
    };
  }

  private apply(path: string, body: any): void {
    if (path === '/products') {
      const existing = this.products.get(body.productId);
      this.products.set(body.productId, {
        ...(existing ?? body),
        ...body,
        timestamp: `rowversion-${this.dispatchCalls}`,
        itemBoms: body.itemBoms ?? existing?.itemBoms ?? [],
        productOperations: body.productOperations ?? existing?.productOperations ?? [],
        isManufacturable: (body.itemBoms ?? existing?.itemBoms ?? []).length > 0,
        inventoryLines: [],
      });
      return;
    }
    if (path === '/stock-adjustments') {
      const direction = body.stockAdjustmentId === this.value.stockAdjustmentIds.seed ? 'seed' : 'reversal';
      this.adjustments.set(body.stockAdjustmentId, {
        ...body,
        lines: body.lines.map((line: any, index: number) => ({
          stockAdjustmentLineId: this.options.providerNormalizedLineIds ? `provider-line-${direction}-${index}` : line.stockAdjustmentLineId,
          productId: line.productId,
          quantity: {
            standardQuantity: `${line.quantity.standardQuantity}.0000`.replace('-.', '-0.'),
            uomQuantity: `${line.quantity.uomQuantity}.0000`.replace('-.', '-0.'),
            uom: line.quantity.uom,
            serialNumbers: line.quantity.serialNumbers,
          },
          sublocation: '',
          timestamp: `line-rowversion-${index}`,
        })),
        timestamp: `adjustment-rowversion-${this.dispatchCalls}`,
      });
      const lines = this.adjustments.get(body.stockAdjustmentId).lines;
      if (this.options.adjustmentLineCorruption === 'missing-line') lines.pop();
      if (this.options.adjustmentLineCorruption === 'missing-id') delete lines[0].stockAdjustmentLineId;
      if (this.options.adjustmentLineCorruption === 'duplicate-id') lines[1].stockAdjustmentLineId = lines[0].stockAdjustmentLineId;
      if (this.options.adjustmentLineCorruption === 'extra-line') {
        const extra = structuredClone(lines[1]);
        extra.stockAdjustmentLineId = 'extra-provider-line';
        lines.push(extra);
      }
      if (this.options.adjustmentLineCorruption === 'wrong-product') lines[0].productId = 'wrong-product';
      if (this.options.adjustmentLineCorruption === 'wrong-quantity') lines[0].quantity.standardQuantity = '3.0000';
      if (this.options.adjustmentLineCorruption === 'wrong-serial') lines[0].quantity.serialNumbers = ['WRONG-SERIAL'];
      if (direction === 'seed' && !this.options.seedMovementBroken) this.seeded = true;
      if (direction === 'reversal' && !this.options.reversalMovementBroken) this.seeded = false;
      return;
    }
    throw new Error(`unexpected mutation ${path}`);
  }
}

function notFound() {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}
