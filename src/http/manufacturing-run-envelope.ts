import type { ManufacturingRunState } from '../core/manufacturing-run-store.js';
import type {
  ManufacturingRunBlockerEvidence,
  ManufacturingRunEnvelopeSnapshot,
} from '../services/manufacturing-run-coordinator.js';
import {
  manufacturingRunNotificationContextSchema,
  type ManufacturingRunNotificationContext,
} from './manufacturing-run-schemas.js';

const CONTEXT_PREFIX = '[manufacturing-run-context:v1:';
const CONTEXT_PATTERN =
  /^\[manufacturing-run-context:v1:([A-Za-z0-9_-]+)\](?:\n([\s\S]*))?$/;

export type ManufacturingRunNotificationDisposition =
  | 'none'
  | 'empty'
  | 'pending'
  | 'claimed'
  | 'delivery_unknown'
  | 'acknowledged';

export interface ManufacturingRunFailure {
  code: string;
  message: string;
}

export interface ManufacturingRunEnvelope {
  schemaVersion: 'manufacturing-run/v1';
  operationId: string | null;
  state: ManufacturingRunState | null;
  manufacturingOrder: {
    manufacturingOrderId: string;
    rootLineId: string;
    runHash: string;
  } | null;
  stateRevision: number | null;
  retryMode:
    | 'worker_fifo'
    | 'readback_only'
    | 'manual'
    | 'none'
    | null;
  expectedComponents: ManufacturingRunEnvelopeSnapshot['expectedComponents'];
  failure: ManufacturingRunFailure | null;
  notificationDisposition: ManufacturingRunNotificationDisposition;
  notificationContext: ManufacturingRunNotificationContext | null;
  blockerEvidence: ManufacturingRunBlockerEvidence | null;
}

export function encodeManufacturingRunRemarks(input: {
  remarks?: string;
  notificationContext?: ManufacturingRunNotificationContext;
}): string | undefined {
  const remarks = input.remarks?.trim();
  if (input.notificationContext === undefined) return remarks || undefined;
  const notificationContext = manufacturingRunNotificationContextSchema.parse(
    input.notificationContext
  );
  const encoded = Buffer.from(JSON.stringify({
    schemaVersion: 'manufacturing-run-context/v1',
    notificationContext,
  })).toString('base64url');
  return `${CONTEXT_PREFIX}${encoded}]${remarks ? `\n${remarks}` : ''}`;
}

export function decodeManufacturingRunRemarks(value: string): {
  remarks: string;
  notificationContext: ManufacturingRunNotificationContext | null;
} {
  if (!value.startsWith(CONTEXT_PREFIX)) {
    return { remarks: value, notificationContext: null };
  }
  const match = CONTEXT_PATTERN.exec(value);
  if (!match) throw new Error('INVALID_MANUFACTURING_RUN_CONTEXT');
  try {
    const parsed = JSON.parse(
      Buffer.from(match[1]!, 'base64url').toString('utf8')
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'notificationContext,schemaVersion' ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !==
        'manufacturing-run-context/v1'
    ) {
      throw new Error('invalid context envelope');
    }
    const notificationContext = manufacturingRunNotificationContextSchema.parse(
      (parsed as { notificationContext?: unknown }).notificationContext
    );
    return {
      remarks: match[2] ?? '',
      notificationContext,
    };
  } catch {
    throw new Error('INVALID_MANUFACTURING_RUN_CONTEXT');
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z][A-Z0-9_]{2,127}/.exec(message)?.[0];
  return code ?? 'COORDINATOR_OPERATION_FAILED';
}

function publicMessage(code: string): string {
  if (/^WRITE_GATE_|^STORAGE_|^RATE_|^COORDINATOR_.*UNAVAILABLE/.test(code)) {
    return 'Coordinator unavailable';
  }
  if (/^UNSUPPORTED_|^INVALID_COMPONENT_|^SERIAL_COUNT_/.test(code)) {
    return 'Unsupported manufacturing order shape';
  }
  if (/IDEMPOTENCY|CONFLICT|REVISION|DRIFT/.test(code)) {
    return 'Request conflicts with durable coordinator state';
  }
  if (/BLOCKED|QUARANTINE|MANUAL/.test(code)) {
    return 'Operator resolution required';
  }
  return 'Manufacturing run operation failed';
}

export function sanitizeManufacturingRunFailure(
  error: unknown
): ManufacturingRunFailure {
  const code = errorCode(error);
  return { code, message: publicMessage(code) };
}

export function createManufacturingRunEnvelope(input: {
  snapshot?: ManufacturingRunEnvelopeSnapshot;
  failure?: ManufacturingRunFailure | null;
  notificationDisposition?: ManufacturingRunNotificationDisposition;
  notificationContext?: ManufacturingRunNotificationContext | null;
  blockerEvidence?: ManufacturingRunBlockerEvidence | null;
}): ManufacturingRunEnvelope {
  const snapshot = input.snapshot;
  return {
    schemaVersion: 'manufacturing-run/v1',
    operationId: snapshot?.operationId ?? null,
    state: snapshot?.state ?? null,
    manufacturingOrder: snapshot
      ? {
          manufacturingOrderId: snapshot.manufacturingOrderId,
          rootLineId: snapshot.rootLineId,
          runHash: snapshot.runHash,
        }
      : null,
    stateRevision: snapshot?.stateRevision ?? null,
    retryMode: snapshot?.retryMode ?? null,
    expectedComponents: snapshot?.expectedComponents ?? [],
    failure: input.failure ?? null,
    notificationDisposition: input.notificationDisposition ?? 'none',
    notificationContext: input.notificationContext ?? null,
    blockerEvidence: input.blockerEvidence ?? null,
  };
}

export function manufacturingRunHttpStatus(input: {
  accepted?: boolean;
  snapshot?: Pick<ManufacturingRunEnvelopeSnapshot, 'state'>;
  failure?: ManufacturingRunFailure | null;
}): number {
  if (input.accepted) return 202;
  const code = input.failure?.code ?? '';
  if (/^WRITE_GATE_|^STORAGE_|^RATE_|^COORDINATOR_.*UNAVAILABLE/.test(code)) {
    return 503;
  }
  if (/^UNSUPPORTED_|^INVALID_COMPONENT_|^SERIAL_COUNT_/.test(code)) {
    return 422;
  }
  if (/IDEMPOTENCY|CONFLICT|REVISION|DRIFT/.test(code)) return 409;
  if (/BLOCKED|QUARANTINE|MANUAL/.test(code)) return 423;
  if (input.failure) return 503;
  if (input.snapshot?.state === 'conflict') return 409;
  if (
    input.snapshot &&
    ['blocked', 'restore_quarantine', 'staged_awaiting_operations'].includes(
      input.snapshot.state
    )
  ) {
    return 423;
  }
  return 200;
}
