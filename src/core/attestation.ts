import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { stableStringify } from './canonical-json.js';

export type WriteDomain =
  | 'manufacturing'
  | 'manufacturing-pick-batch-v1'
  | 'manufacturing-operation-completion-v1'
  | 'prices'
  | 'product-groups'
  | 'mo-serials'
  | 'standard';

export interface CanaryAttestation {
  schemaVersion: 'canary-attestation/v1';
  domain: WriteDomain;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  serializerVersion: string;
  contractVersion: string;
  approvalNonce: string;
  issuedAt: string;
  expiresAt: string;
  passed: boolean;
  cleanupVerified: boolean;
  confirmedResidualIds: string[];
  possibleResidualIds: string[];
  approvedInertArtifactIds: string[];
  optimisticConcurrency: 'enforced' | 'unavailable' | 'unknown';
  observedSemantics: Record<string, string | boolean>;
  beforeSnapshotHash: string;
  afterCleanupSnapshotHash: string;
  mac: string;
}

export interface GateStatus {
  domain: WriteDomain;
  environmentEnabled: boolean;
  attestationState: 'valid' | 'missing' | 'invalid' | 'expired';
  enabled: boolean;
  reasonCode?: string;
  issuedAt?: string;
  expiresAt?: string;
  optimisticConcurrency?: CanaryAttestation['optimisticConcurrency'];
  residualCount?: number;
}

export type UnsignedCanaryAttestation = Omit<CanaryAttestation, 'mac'>;

function attestationKey(apiKey: string, tenantFingerprint: string): Buffer {
  return Buffer.from(hkdfSync('sha256', apiKey, tenantFingerprint, 'inflow-canary-attestation/v1', 32));
}

function body(attestation: CanaryAttestation): Omit<CanaryAttestation, 'mac'> {
  const { mac: _mac, ...rest } = attestation;
  return rest;
}

const REQUIRED_OBSERVATIONS: Record<WriteDomain, string[]> = {
  manufacturing: ['add', 'update', 'remove', 'clear', 'rowIdStrategy', 'readback'],
  'manufacturing-pick-batch-v1': [
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
  ],
  'manufacturing-operation-completion-v1': [
    'exactAssemblyShape',
    'trackTimePreserved',
    'timesheetsPreserved',
    'operationsCompleted',
    'outputSerial',
    'putAway',
    'orderCompleted',
    'unknownFieldsPreserved',
    'staleRowversionNoWrite',
    'responseLossReadback',
    'partialWriteQuarantine',
    'inventoryMovement',
    'exactReadback',
    'cleanup',
  ],
  prices: ['add', 'update', 'remove', 'clear', 'rowIdStrategy', 'projectionPreserved', 'readback'],
  'product-groups': ['add', 'update', 'remove', 'clear', 'rowIdStrategy', 'compensation', 'readback'],
  'mo-serials': ['add', 'swap', 'remove', 'inventoryMovement', 'compensation', 'readback'],
  standard: ['domainAdaptersIndividuallyProven', 'readback'],
};

function validAttestationWindow(value: CanaryAttestation): boolean {
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return false;
  if (issued > Date.now() + 5 * 60_000) return false;
  const maxTtl =
    value.domain === 'mo-serials' ||
    value.domain === 'standard' ||
    value.domain === 'manufacturing-pick-batch-v1' ||
    value.domain === 'manufacturing-operation-completion-v1'
    ? 30 * 24 * 60 * 60_000
    : 90 * 24 * 60 * 60_000;
  return expires - issued <= maxTtl;
}

export function signCanaryAttestation(
  value: UnsignedCanaryAttestation,
  apiKey: string
): CanaryAttestation {
  const mac = createHmac('sha256', attestationKey(apiKey, value.tenantFingerprint))
    .update(stableStringify(value))
    .digest('hex');
  return { ...value, mac };
}

export async function writeCanaryAttestation(
  stateDir: string,
  value: CanaryAttestation
): Promise<void> {
  await ensurePrivateDirectory(stateDir);
  const directory = join(stateDir, 'attestations');
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${value.domain}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`UNSAFE_ATTESTATION_DIRECTORY: ${path}`);
  }
}

async function privateDirectoryState(path: string): Promise<'safe' | 'missing' | 'unsafe'> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0 ? 'safe' : 'unsafe';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function loadGateStatus(args: {
  stateDir: string;
  domain: WriteDomain;
  environmentEnabled: boolean | undefined;
  apiKey: string;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  probeBuild: string;
  adapterManifestHash: string;
  serializerVersion: string;
  contractVersion: string;
}): Promise<GateStatus> {
  const base = {
    domain: args.domain,
    environmentEnabled: args.environmentEnabled === true,
  };
  if (!args.probeBuild || !args.adapterManifestHash) {
    return { ...base, attestationState: 'invalid', enabled: false, reasonCode: 'BUILD_IDENTITY_MISSING' };
  }
  const directory = join(args.stateDir, 'attestations');
  const stateDirState = await privateDirectoryState(args.stateDir);
  const attestationDirState = await privateDirectoryState(directory);
  if (stateDirState === 'unsafe' || attestationDirState === 'unsafe') {
    return { ...base, attestationState: 'invalid', enabled: false, reasonCode: 'UNSAFE_ATTESTATION_DIRECTORY' };
  }
  if (stateDirState === 'missing' || attestationDirState === 'missing') {
    return { ...base, attestationState: 'missing', enabled: false, reasonCode: 'ATTESTATION_MISSING' };
  }
  const path = join(directory, `${args.domain}.json`);
  let raw: string;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      return { ...base, attestationState: 'invalid', enabled: false, reasonCode: 'UNSAFE_ATTESTATION_FILE' };
    }
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...base, attestationState: 'missing', enabled: false, reasonCode: 'ATTESTATION_MISSING' };
    }
    return { ...base, attestationState: 'invalid', enabled: false, reasonCode: 'ATTESTATION_READ_FAILED' };
  }
  try {
    const value = JSON.parse(raw) as CanaryAttestation;
    const actual = Buffer.from(value.mac, 'hex');
    const expected = createHmac('sha256', attestationKey(args.apiKey, args.tenantFingerprint))
      .update(stableStringify(body(value)))
      .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('mac');
    if (
      value.schemaVersion !== 'canary-attestation/v1' || value.domain !== args.domain ||
      value.tenantFingerprint !== args.tenantFingerprint || value.baseHost !== args.baseHost ||
      value.apiVersion !== args.apiVersion || value.adapterManifestHash !== args.adapterManifestHash ||
      value.probeBuild !== args.probeBuild || value.serializerVersion !== args.serializerVersion ||
      value.contractVersion !== args.contractVersion || !value.passed || !value.cleanupVerified ||
      !value.beforeSnapshotHash || !value.afterCleanupSnapshotHash || !value.observedSemantics ||
      !value.approvalNonce || !validAttestationWindow(value) ||
      REQUIRED_OBSERVATIONS[value.domain].some((key) =>
        value.domain === 'manufacturing-pick-batch-v1' ||
        value.domain === 'manufacturing-operation-completion-v1'
          ? value.observedSemantics[key] !== true
          : !value.observedSemantics[key]
      ) ||
      ((value.domain === 'manufacturing-pick-batch-v1' ||
        value.domain === 'manufacturing-operation-completion-v1') &&
        value.optimisticConcurrency !== 'enforced') ||
      value.possibleResidualIds.length > 0 ||
      value.confirmedResidualIds.some((id) => !value.approvedInertArtifactIds.includes(id))
    ) throw new Error('scope');
    const expired = Date.parse(value.expiresAt) <= Date.now();
    const enabled = base.environmentEnabled && !expired;
    return {
      ...base,
      attestationState: expired ? 'expired' : 'valid',
      enabled,
      reasonCode: enabled ? undefined : expired ? 'ATTESTATION_EXPIRED' : 'ENVIRONMENT_GATE_DISABLED',
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      optimisticConcurrency: value.optimisticConcurrency,
      residualCount: value.confirmedResidualIds.length,
    };
  } catch {
    return { ...base, attestationState: 'invalid', enabled: false, reasonCode: 'ATTESTATION_INVALID' };
  }
}
