import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadGateStatus,
  signCanaryAttestation,
  writeCanaryAttestation,
  type UnsignedCanaryAttestation,
} from './attestation.js';

describe('canary attestations', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('binds a private attestation to the exact probe, adapter, serializer, and tenant', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-attestation-'));
    const stateDir = join(root, 'state');
    const unsigned: UnsignedCanaryAttestation = {
      schemaVersion: 'canary-attestation/v1',
      domain: 'prices',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
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
        add: true,
        update: true,
        remove: 'omit-row',
        clear: 'empty-array',
        rowIdStrategy: 'server-assigned',
        projectionPreserved: true,
        readback: true,
      },
      beforeSnapshotHash: 'before-hash',
      afterCleanupSnapshotHash: 'after-hash',
    };
    await writeCanaryAttestation(stateDir, signCanaryAttestation(unsigned, 'secret'));
    const common = {
      stateDir,
      domain: 'prices' as const,
      environmentEnabled: true,
      apiKey: 'secret',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
      serializerVersion: 'canonical/v1',
      contractVersion: 'mutation/v1',
    };
    await expect(loadGateStatus(common)).resolves.toMatchObject({
      attestationState: 'valid',
      enabled: true,
    });
    await expect(loadGateStatus({ ...common, serializerVersion: 'canonical/v2' }))
      .resolves.toMatchObject({ attestationState: 'invalid', enabled: false });

    await chmod(stateDir, 0o755);
    await expect(loadGateStatus(common)).resolves.toMatchObject({
      attestationState: 'invalid',
      enabled: false,
      reasonCode: 'UNSAFE_ATTESTATION_DIRECTORY',
    });
  });

  it('accepts the dedicated manufacturing pick-batch domain only with every required observation and enforced concurrency', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-pick-batch-attestation-'));
    const stateDir = join(root, 'state');
    const observedSemantics = {
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
    const unsigned = {
      schemaVersion: 'canary-attestation/v1' as const,
      domain: 'manufacturing-pick-batch-v1',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
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
      optimisticConcurrency: 'enforced' as const,
      observedSemantics,
      beforeSnapshotHash: 'before-hash',
      afterCleanupSnapshotHash: 'after-hash',
    };
    await writeCanaryAttestation(
      stateDir,
      signCanaryAttestation(unsigned as UnsignedCanaryAttestation, 'secret')
    );
    const common = {
      stateDir,
      domain: 'manufacturing-pick-batch-v1' as const,
      environmentEnabled: true,
      apiKey: 'secret',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
      serializerVersion: 'canonical/v1',
      contractVersion: 'mutation/v1',
    };
    await expect(loadGateStatus(common as Parameters<typeof loadGateStatus>[0]))
      .resolves.toMatchObject({
        attestationState: 'valid',
        enabled: true,
        optimisticConcurrency: 'enforced',
      });

    for (const observation of Object.keys(observedSemantics)) {
      const invalid = {
        ...unsigned,
        observedSemantics: { ...observedSemantics, [observation]: false },
      };
      await writeCanaryAttestation(
        stateDir,
        signCanaryAttestation(invalid as UnsignedCanaryAttestation, 'secret')
      );
      await expect(loadGateStatus(common as Parameters<typeof loadGateStatus>[0]))
        .resolves.toMatchObject({ attestationState: 'invalid', enabled: false });
    }

    await writeCanaryAttestation(
      stateDir,
      signCanaryAttestation(
        {
          ...unsigned,
          observedSemantics: {
            ...observedSemantics,
            deterministicCreateRecovery: 'claimed',
          },
        } as UnsignedCanaryAttestation,
        'secret'
      )
    );
    await expect(loadGateStatus(common as Parameters<typeof loadGateStatus>[0]))
      .resolves.toMatchObject({ attestationState: 'invalid', enabled: false });

    await writeCanaryAttestation(
      stateDir,
      signCanaryAttestation(
        { ...unsigned, optimisticConcurrency: 'unknown' } as UnsignedCanaryAttestation,
        'secret'
      )
    );
    await expect(loadGateStatus(common as Parameters<typeof loadGateStatus>[0]))
      .resolves.toMatchObject({ attestationState: 'invalid', enabled: false });
  });

  it('requires every exact operation-completion observation and enforced concurrency', async () => {
    root = await mkdtemp(join(tmpdir(), 'inflow-operation-completion-attestation-'));
    const stateDir = join(root, 'state');
    const observedSemantics = {
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
    };
    const unsigned: UnsignedCanaryAttestation = {
      schemaVersion: 'canary-attestation/v1',
      domain: 'manufacturing-operation-completion-v1',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
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
      observedSemantics,
      beforeSnapshotHash: 'before-hash',
      afterCleanupSnapshotHash: 'after-hash',
    };
    const common = {
      stateDir,
      domain: 'manufacturing-operation-completion-v1' as const,
      environmentEnabled: true,
      apiKey: 'secret',
      tenantFingerprint: 'tenant-1',
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      probeBuild: 'probe-sha',
      adapterManifestHash: 'adapter-sha',
      serializerVersion: 'canonical/v1',
      contractVersion: 'mutation/v1',
    };
    await writeCanaryAttestation(
      stateDir,
      signCanaryAttestation(unsigned, 'secret')
    );
    await expect(loadGateStatus(common)).resolves.toMatchObject({
      attestationState: 'valid',
      enabled: true,
      optimisticConcurrency: 'enforced',
    });

    await writeCanaryAttestation(
      stateDir,
      signCanaryAttestation({
        ...unsigned,
        observedSemantics: {
          ...observedSemantics,
          responseLossReadback: false,
        },
      }, 'secret')
    );
    await expect(loadGateStatus(common)).resolves.toMatchObject({
      attestationState: 'invalid',
      enabled: false,
    });
  });
});
