import type { InflowConfig } from '../config.js';
import { canonicalHash } from '../core/canonical-json.js';
import {
  signCanaryAttestation,
  writeCanaryAttestation,
  type CanaryAttestation,
  type WriteDomain,
} from '../core/attestation.js';
import { MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION } from '../core/mutation.js';
import { tenantFingerprint } from '../core/preview-token.js';

type GenericCanaryDomain = Exclude<WriteDomain, 'manufacturing-pick-batch-v1'>;

export interface PassingCanaryEvidence {
  domain: GenericCanaryDomain;
  approvalNonce?: string;
  observedSemantics: Record<string, string | boolean>;
  optimisticConcurrency: CanaryAttestation['optimisticConcurrency'];
  beforeSnapshot: unknown;
  afterCleanupSnapshot: unknown;
  confirmedResidualIds?: string[];
  possibleResidualIds?: string[];
  approvedInertArtifactIds?: string[];
}

export function assertCanaryAttestationReady(
  config: InflowConfig,
  approvalNonce = process.env.INFLOW_CANARY_APPROVAL_NONCE
): string {
  if (!config.probeBuild || !config.adapterManifestHash) {
    throw new Error('CANARY_BUILD_IDENTITY_REQUIRED: running probe/adapter artifacts have no computed identity');
  }
  if (!approvalNonce?.trim()) {
    throw new Error('CANARY_APPROVAL_NONCE_REQUIRED: record the explicit approval nonce before any canary write');
  }
  return approvalNonce.trim();
}

export async function issuePassingCanaryAttestation(
  config: InflowConfig,
  evidence: PassingCanaryEvidence
): Promise<void> {
  if ((evidence.domain as WriteDomain) === 'manufacturing-pick-batch-v1') {
    throw new Error(
      'DEDICATED_CANARY_ISSUER_REQUIRED: generic manufacturing evidence cannot attest the pick-batch contract'
    );
  }
  const approvalNonce = assertCanaryAttestationReady(config, evidence.approvalNonce);
  if ((evidence.possibleResidualIds?.length ?? 0) > 0) {
    throw new Error('CANARY_ATTESTATION_REFUSED: possible residual IDs remain');
  }
  const issuedAt = new Date();
  const ttlDays =
    evidence.domain === 'mo-serials' ||
    evidence.domain === 'standard' ||
    evidence.domain === 'manufacturing-operation-completion-v1'
      ? 30
      : 90;
  const baseHost = new URL(config.baseUrl).host.toLowerCase();
  const fingerprint = tenantFingerprint(config.companyId, config.apiKey, baseHost);
  const unsigned = {
    schemaVersion: 'canary-attestation/v1' as const,
    domain: evidence.domain,
    tenantFingerprint: fingerprint,
    baseHost,
    apiVersion: config.apiVersion,
    probeBuild: config.probeBuild,
    adapterManifestHash: config.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
    approvalNonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlDays * 24 * 60 * 60_000).toISOString(),
    passed: true,
    cleanupVerified: true,
    confirmedResidualIds: [...new Set(evidence.confirmedResidualIds ?? [])].sort(),
    possibleResidualIds: [],
    approvedInertArtifactIds: [...new Set(evidence.approvedInertArtifactIds ?? [])].sort(),
    optimisticConcurrency: evidence.optimisticConcurrency,
    observedSemantics: evidence.observedSemantics,
    beforeSnapshotHash: canonicalHash(evidence.beforeSnapshot, `canary-before/${evidence.domain}/v1`),
    afterCleanupSnapshotHash: canonicalHash(evidence.afterCleanupSnapshot, `canary-after/${evidence.domain}/v1`),
  };
  await writeCanaryAttestation(config.stateDir, signCanaryAttestation(unsigned, config.apiKey));
}
