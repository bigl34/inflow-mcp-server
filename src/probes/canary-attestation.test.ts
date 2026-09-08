import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { InflowConfig } from '../config.js';
import { loadGateStatus } from '../core/attestation.js';
import { MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION } from '../core/mutation.js';
import { tenantFingerprint } from '../core/preview-token.js';
import { assertCanaryAttestationReady, issuePassingCanaryAttestation } from './canary-attestation.js';

const paths: string[] = [];
afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function config(stateDir: string): InflowConfig {
  return {
    companyId: 'company', apiKey: 'secret', baseUrl: 'https://example.test', apiVersion: '2026-04-13',
    rateLimitPerMinute: 60, requestTimeoutMs: 1_000, maxRetries: 0, retryDelayMs: 1,
    readRetryBudgetMs: 1_000, debug: false, stateDir, adapterManifestHash: 'adapter-sha',
    probeBuild: 'probe-sha', enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
    writeGates: { manufacturing: true, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
  };
}

describe('canary attestation issuance', () => {
  it('refuses before a write when immutable build identity or approval is absent', () => {
    const value = config('/tmp/not-used');
    expect(() => assertCanaryAttestationReady({ ...value, probeBuild: '' }, 'approval')).toThrow('CANARY_BUILD_IDENTITY_REQUIRED');
    expect(() => assertCanaryAttestationReady(value, '')).toThrow('CANARY_APPROVAL_NONCE_REQUIRED');
  });

  it('writes a gate-valid, owner-only attestation from passing cleanup evidence', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-canary-attestation-'));
    paths.push(stateDir);
    const value = config(stateDir);
    await issuePassingCanaryAttestation(value, {
      domain: 'manufacturing', approvalNonce: 'approval-123',
      observedSemantics: { add: true, update: true, remove: true, clear: true, rowIdStrategy: 'client-supplied', readback: true },
      optimisticConcurrency: 'enforced', beforeSnapshot: { rows: [] }, afterCleanupSnapshot: { rows: [] },
      confirmedResidualIds: ['inactive-parent'], approvedInertArtifactIds: ['inactive-parent'],
    });
    const raw = JSON.parse(await readFile(join(stateDir, 'attestations', 'manufacturing.json'), 'utf8'));
    expect(raw.approvalNonce).toBe('approval-123');
    const host = new URL(value.baseUrl).host.toLowerCase();
    await expect(loadGateStatus({
      stateDir, domain: 'manufacturing', environmentEnabled: true, apiKey: value.apiKey,
      tenantFingerprint: tenantFingerprint(value.companyId, value.apiKey, host), baseHost: host,
      apiVersion: value.apiVersion, probeBuild: value.probeBuild, adapterManifestHash: value.adapterManifestHash,
      serializerVersion: SERIALIZER_VERSION, contractVersion: MUTATION_CONTRACT_VERSION,
    })).resolves.toMatchObject({ attestationState: 'valid', enabled: true });
  });

  it('refuses to mint the dedicated pick-batch attestation through the generic manufacturing path', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-generic-canary-refusal-'));
    paths.push(stateDir);
    await expect(issuePassingCanaryAttestation(config(stateDir), {
      domain: 'manufacturing-pick-batch-v1',
      approvalNonce: 'approval-123',
      observedSemantics: {
        deterministicCreateRecovery: true,
        serverExpandedBom: true,
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
        inventoryMovement: true,
        exactReadback: true,
        manualCompletion: true,
        cleanup: true,
      },
      optimisticConcurrency: 'enforced',
      beforeSnapshot: {},
      afterCleanupSnapshot: {},
    } as unknown as Parameters<typeof issuePassingCanaryAttestation>[1]))
      .rejects.toThrow('DEDICATED_CANARY_ISSUER_REQUIRED');
  });
});
