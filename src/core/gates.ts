import type { InflowConfig } from '../config.js';
import { MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION } from './mutation.js';
import { tenantFingerprint } from './preview-token.js';
import { loadGateStatus, type GateStatus, type WriteDomain } from './attestation.js';

export interface CoordinatorWriteGateStatus extends GateStatus {
  requiredGates: [
    'INFLOW_ENABLE_SAFE_WRITES',
    'INFLOW_ENABLE_STOCK_WRITES',
    'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
    'manufacturing-pick-batch-v1 attestation',
  ];
  masterEnabled: boolean;
  stockEnabled: boolean;
  coordinatorEnvironmentEnabled: boolean;
}

export interface ManufacturingOperationCompletionGateStatus extends GateStatus {
  requiredGates: [
    'INFLOW_ENABLE_SAFE_WRITES',
    'INFLOW_ENABLE_STOCK_WRITES',
    'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
    'manufacturing-pick-batch-v1 attestation',
    'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES',
    'manufacturing-operation-completion-v1 attestation',
  ];
  coordinatorEnabled: boolean;
  completionEnvironmentEnabled: boolean;
}

export function resolveWriteGate(config: InflowConfig, domain: WriteDomain) {
  const baseHost = new URL(config.baseUrl).host.toLowerCase();
  return loadGateStatus({
    stateDir: config.stateDir,
    domain,
    environmentEnabled: config.writeGates[domain],
    apiKey: config.apiKey,
    tenantFingerprint: tenantFingerprint(config.companyId, config.apiKey, baseHost),
    baseHost,
    apiVersion: config.apiVersion,
    probeBuild: config.probeBuild,
    adapterManifestHash: config.adapterManifestHash,
    serializerVersion: SERIALIZER_VERSION,
    contractVersion: MUTATION_CONTRACT_VERSION,
  });
}

export async function resolveCoordinatorWriteGate(
  config: InflowConfig
): Promise<CoordinatorWriteGateStatus> {
  const coordinator = await resolveWriteGate(config, 'manufacturing-pick-batch-v1');
  const masterEnabled = config.safeWritesEnabled === true;
  const stockEnabled = config.stockWritesEnabled === true;
  const coordinatorEnvironmentEnabled =
    config.writeGates['manufacturing-pick-batch-v1'] === true;
  const reasonCode = !masterEnabled
    ? 'SAFE_WRITES_DISABLED'
    : !stockEnabled
      ? 'STOCK_WRITES_DISABLED'
      : coordinator.reasonCode;
  return {
    ...coordinator,
    requiredGates: [
      'INFLOW_ENABLE_SAFE_WRITES',
      'INFLOW_ENABLE_STOCK_WRITES',
      'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
      'manufacturing-pick-batch-v1 attestation',
    ],
    masterEnabled,
    stockEnabled,
    coordinatorEnvironmentEnabled,
    enabled: reasonCode === undefined && coordinator.enabled,
    reasonCode,
  };
}

export async function resolveManufacturingOperationCompletionGate(
  config: InflowConfig
): Promise<ManufacturingOperationCompletionGateStatus> {
  const [coordinator, completion] = await Promise.all([
    resolveCoordinatorWriteGate(config),
    resolveWriteGate(config, 'manufacturing-operation-completion-v1'),
  ]);
  const completionEnvironmentEnabled =
    config.writeGates['manufacturing-operation-completion-v1'] === true;
  const reasonCode = !coordinator.enabled
    ? coordinator.reasonCode ?? 'MANUFACTURING_PICK_BATCH_GATE_CLOSED'
    : completion.reasonCode;
  return {
    ...completion,
    requiredGates: [
      'INFLOW_ENABLE_SAFE_WRITES',
      'INFLOW_ENABLE_STOCK_WRITES',
      'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
      'manufacturing-pick-batch-v1 attestation',
      'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES',
      'manufacturing-operation-completion-v1 attestation',
    ],
    coordinatorEnabled: coordinator.enabled,
    completionEnvironmentEnabled,
    enabled: reasonCode === undefined && completion.enabled,
    reasonCode,
  };
}
