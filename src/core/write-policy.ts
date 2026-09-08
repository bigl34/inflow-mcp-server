import type { InflowConfig } from '../config.js';

export type SafeWriteClassification = 'ordinary' | 'stock';
export type SafeWriteIdempotencyPolicy =
  | 'required'
  | 'create-only'
  | 'replacement-optional'
  | 'delete-absence-verified';

export interface SafeWriteOperationPolicy {
  operation: string;
  classification: SafeWriteClassification;
  staticSupport: boolean;
  idempotency: SafeWriteIdempotencyPolicy;
  unsupportedReason?: string;
}

export interface SafeWriteClassAuthorization {
  classification: SafeWriteClassification;
  requiredGates: Array<'INFLOW_ENABLE_SAFE_WRITES' | 'INFLOW_ENABLE_STOCK_WRITES'>;
  masterEnabled: boolean;
  stockEnabled: boolean;
  enabled: boolean;
  reasonCode?: 'SAFE_WRITES_DISABLED' | 'STOCK_WRITES_DISABLED';
}

export interface SafeWriteAuthorization extends SafeWriteOperationPolicy {
  requiredGates: SafeWriteClassAuthorization['requiredGates'];
  masterEnabled: boolean;
  stockEnabled: boolean;
  effectiveApplyEnabled: boolean;
  reasonCode?: 'OPERATION_UNSUPPORTED' | 'SAFE_WRITES_DISABLED' | 'STOCK_WRITES_DISABLED';
}

const UNSUPPORTED_PENDING_CANARY =
  'Adapter apply remains unavailable until its operation-specific release canary passes.';

const POLICIES: readonly SafeWriteOperationPolicy[] = [
  {
    operation: 'set_product_prices',
    classification: 'ordinary',
    staticSupport: true,
    idempotency: 'replacement-optional',
  },
  {
    operation: 'set_product',
    classification: 'ordinary',
    staticSupport: true,
    idempotency: 'create-only',
  },
  {
    operation: 'set_product_group_config',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'replacement-optional',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'create_product_group_variants',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_customer',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'create-only',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_vendor',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'create-only',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_taxing_scheme',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'create-only',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_webhook',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'create-only',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'remove_webhook',
    classification: 'ordinary',
    staticSupport: false,
    idempotency: 'delete-absence-verified',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_sales_order',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_purchase_order',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_purchase_order_receipts',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_stock_adjustment',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_stock_transfer',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_stock_count',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'set_manufacturing_order',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
  {
    operation: 'reconcile_manufacturing_order_serials',
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: UNSUPPORTED_PENDING_CANARY,
  },
] as const;

const POLICY_BY_OPERATION = new Map(
  POLICIES.map((policy) => [policy.operation, policy] as const)
);

export function listSafeWritePolicies(): SafeWriteOperationPolicy[] {
  return POLICIES.map((policy) => ({ ...policy }));
}

export function getSafeWritePolicy(operation: string): SafeWriteOperationPolicy {
  const policy = POLICY_BY_OPERATION.get(operation);
  if (policy) return { ...policy };
  return {
    operation,
    classification: 'stock',
    staticSupport: false,
    idempotency: 'required',
    unsupportedReason: 'Unknown safe-write operations fail closed as unsupported and stock-affecting.',
  };
}

export function classifySafeWriteOperations(operations: readonly string[]): {
  classification: SafeWriteClassification;
  staticSupport: boolean;
  unknownOperations: string[];
} {
  const policies = operations.map((operation) => getSafeWritePolicy(operation));
  const unknownOperations = operations.filter((operation) => !POLICY_BY_OPERATION.has(operation));
  return {
    classification:
      unknownOperations.length > 0 || policies.some((policy) => policy.classification === 'stock')
        ? 'stock'
        : 'ordinary',
    staticSupport:
      operations.length > 0 &&
      unknownOperations.length === 0 &&
      policies.every((policy) => policy.staticSupport),
    unknownOperations,
  };
}

export function evaluateSafeWriteClassAuthorization(
  config: Pick<InflowConfig, 'safeWritesEnabled' | 'stockWritesEnabled'>,
  classification: SafeWriteClassification
): SafeWriteClassAuthorization {
  const requiredGates: SafeWriteClassAuthorization['requiredGates'] =
    classification === 'stock'
      ? ['INFLOW_ENABLE_SAFE_WRITES', 'INFLOW_ENABLE_STOCK_WRITES']
      : ['INFLOW_ENABLE_SAFE_WRITES'];
  const masterEnabled = config.safeWritesEnabled === true;
  const stockEnabled = config.stockWritesEnabled === true;
  const reasonCode = !masterEnabled
    ? 'SAFE_WRITES_DISABLED'
    : classification === 'stock' && !stockEnabled
      ? 'STOCK_WRITES_DISABLED'
      : undefined;
  return {
    classification,
    requiredGates,
    masterEnabled,
    stockEnabled,
    enabled: reasonCode === undefined,
    reasonCode,
  };
}

export function evaluateSafeWriteAuthorization(
  config: Pick<InflowConfig, 'safeWritesEnabled' | 'stockWritesEnabled'>,
  operation: string
): SafeWriteAuthorization {
  const policy = getSafeWritePolicy(operation);
  const gates = evaluateSafeWriteClassAuthorization(config, policy.classification);
  const reasonCode = !policy.staticSupport ? 'OPERATION_UNSUPPORTED' : gates.reasonCode;
  return {
    ...policy,
    requiredGates: gates.requiredGates,
    masterEnabled: gates.masterEnabled,
    stockEnabled: gates.stockEnabled,
    effectiveApplyEnabled: reasonCode === undefined,
    reasonCode,
  };
}

export function assertSafeWriteAuthorized(
  config: Pick<InflowConfig, 'safeWritesEnabled' | 'stockWritesEnabled'>,
  operation: string
): void {
  const authorization = evaluateSafeWriteAuthorization(config, operation);
  if (authorization.effectiveApplyEnabled) return;
  if (authorization.reasonCode === 'OPERATION_UNSUPPORTED') {
    throw new Error(
      `OPERATION_UNSUPPORTED: ${operation}; ${authorization.unsupportedReason ?? 'adapter apply is not released'}`
    );
  }
  if (authorization.reasonCode === 'SAFE_WRITES_DISABLED') {
    throw new Error('SAFE_WRITES_DISABLED: INFLOW_ENABLE_SAFE_WRITES must be true at apply time');
  }
  throw new Error('STOCK_WRITES_DISABLED: INFLOW_ENABLE_STOCK_WRITES must be true at apply time');
}

export function assertMasterSafeWritesEnabled(
  config: Pick<InflowConfig, 'safeWritesEnabled'>
): void {
  if (config.safeWritesEnabled !== true) {
    throw new Error('SAFE_WRITES_DISABLED: INFLOW_ENABLE_SAFE_WRITES must be true at apply time');
  }
}
