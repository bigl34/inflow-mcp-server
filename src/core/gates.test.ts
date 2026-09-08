import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InflowConfig } from '../config.js';
import {
  signCanaryAttestation,
  writeCanaryAttestation,
  type UnsignedCanaryAttestation,
} from './attestation.js';
import {
  resolveCoordinatorWriteGate,
  resolveManufacturingOperationCompletionGate,
} from './gates.js';
import { tenantFingerprint } from './preview-token.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function config(stateDir: string): InflowConfig {
  return {
    companyId: 'company',
    apiKey: 'secret',
    baseUrl: 'https://cloudapi.inflowinventory.com',
    apiVersion: '2026-04-13',
    rateLimitPerMinute: 60,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryDelayMs: 1,
    readRetryBudgetMs: 1_000,
    debug: false,
    safeWritesEnabled: false,
    stockWritesEnabled: false,
    stateDir,
    adapterManifestHash: 'adapter-sha',
    probeBuild: 'probe-sha',
    enableLegacyWrites: false,
    writeGates: {
      manufacturing: false,
      'manufacturing-pick-batch-v1': true,
      'manufacturing-operation-completion-v1': false,
      prices: false,
      'product-groups': false,
      'mo-serials': false,
      standard: false,
    },
  };
}

async function writeCoordinatorAttestation(value: InflowConfig): Promise<void> {
  const host = new URL(value.baseUrl).host.toLowerCase();
  const unsigned: UnsignedCanaryAttestation = {
    schemaVersion: 'canary-attestation/v1',
    domain: 'manufacturing-pick-batch-v1',
    tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, host),
    baseHost: host,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
    serializerVersion: 'canonical/v1',
    contractVersion: 'mutation/v1',
    approvalNonce: 'approval-1',
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    passed: true,
    cleanupVerified: true,
    confirmedResidualIds: [],
    possibleResidualIds: [],
    approvedInertArtifactIds: [],
    optimisticConcurrency: 'enforced',
    observedSemantics: {
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
    },
    beforeSnapshotHash: 'before-hash',
    afterCleanupSnapshotHash: 'after-hash',
  };
  await writeCanaryAttestation(value.stateDir, signCanaryAttestation(unsigned, value.apiKey));
}

async function writeOperationCompletionAttestation(
  value: InflowConfig
): Promise<void> {
  const host = new URL(value.baseUrl).host.toLowerCase();
  const unsigned: UnsignedCanaryAttestation = {
    schemaVersion: 'canary-attestation/v1',
    domain: 'manufacturing-operation-completion-v1',
    tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, host),
    baseHost: host,
    apiVersion: value.apiVersion,
    probeBuild: value.probeBuild,
    adapterManifestHash: value.adapterManifestHash,
    serializerVersion: 'canonical/v1',
    contractVersion: 'mutation/v1',
    approvalNonce: 'approval-2',
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    passed: true,
    cleanupVerified: true,
    confirmedResidualIds: [],
    possibleResidualIds: [],
    approvedInertArtifactIds: [],
    optimisticConcurrency: 'enforced',
    observedSemantics: {
      exactAssemblyShape: true,
      trackTimePreserved: true,
      timesheetsPreserved: true,
      operationsCompleted: true,
      outputSerial: true,
      putAway: true,
      orderCompleted: true,
      unknownFieldsPreserved: true,
      staleRowversionNoWrite: true,
      responseLossReadback: true,
      partialWriteQuarantine: true,
      inventoryMovement: true,
      exactReadback: true,
      cleanup: true,
    },
    beforeSnapshotHash: 'before-hash',
    afterCleanupSnapshotHash: 'after-hash',
  };
  await writeCanaryAttestation(
    value.stateDir,
    signCanaryAttestation(unsigned, value.apiKey)
  );
}

describe('coordinator write gate', () => {
  it('requires master, then stock, then the dedicated environment gate and attestation', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-coordinator-gates-'));
    const value = config(join(root, 'state'));
    await writeCoordinatorAttestation(value);

    await expect(resolveCoordinatorWriteGate(value)).resolves.toMatchObject({
      enabled: false,
      reasonCode: 'SAFE_WRITES_DISABLED',
      attestationState: 'valid',
    });
    value.safeWritesEnabled = true;
    await expect(resolveCoordinatorWriteGate(value)).resolves.toMatchObject({
      enabled: false,
      reasonCode: 'STOCK_WRITES_DISABLED',
    });
    value.stockWritesEnabled = true;
    await expect(resolveCoordinatorWriteGate(value)).resolves.toMatchObject({
      enabled: true,
      reasonCode: undefined,
      coordinatorEnvironmentEnabled: true,
    });
    value.writeGates['manufacturing-pick-batch-v1'] = false;
    await expect(resolveCoordinatorWriteGate(value)).resolves.toMatchObject({
      enabled: false,
      reasonCode: 'ENVIRONMENT_GATE_DISABLED',
      coordinatorEnvironmentEnabled: false,
    });
  });

  it('never treats master and stock gates as substitutes for attestation', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-coordinator-no-attestation-'));
    const value = config(join(root, 'state'));
    value.safeWritesEnabled = true;
    value.stockWritesEnabled = true;
    await expect(resolveCoordinatorWriteGate(value)).resolves.toMatchObject({
      enabled: false,
      reasonCode: 'ATTESTATION_MISSING',
    });
  });

  it('requires the base coordinator gate plus a separate completion gate and attestation', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-operation-completion-gates-'));
    const value = config(join(root, 'state'));
    value.safeWritesEnabled = true;
    value.stockWritesEnabled = true;
    await writeCoordinatorAttestation(value);
    await expect(resolveManufacturingOperationCompletionGate(value))
      .resolves.toMatchObject({
        enabled: false,
        reasonCode: 'ATTESTATION_MISSING',
        coordinatorEnabled: true,
      });

    await writeOperationCompletionAttestation(value);
    await expect(resolveManufacturingOperationCompletionGate(value))
      .resolves.toMatchObject({
        enabled: false,
        reasonCode: 'ENVIRONMENT_GATE_DISABLED',
        completionEnvironmentEnabled: false,
      });

    value.writeGates['manufacturing-operation-completion-v1'] = true;
    await expect(resolveManufacturingOperationCompletionGate(value))
      .resolves.toMatchObject({
        enabled: true,
        reasonCode: undefined,
        coordinatorEnabled: true,
        completionEnvironmentEnabled: true,
      });
  });
});
