export interface ManufacturingRunReadinessOptions {
  now?: () => Date;
  host(): Promise<{
    healthy: boolean;
    reasonCode?: string;
  }> | {
    healthy: boolean;
    reasonCode?: string;
  };
  clock(): Promise<{ skewMs: number }> | { skewMs: number };
  gate(): Promise<{
    enabled: boolean;
    reasonCode?: string;
    attestationState: string;
  }> | {
    enabled: boolean;
    reasonCode?: string;
    attestationState: string;
  };
  storage(): Promise<{
    writeGateOpen: boolean;
    journalMode: string;
    synchronous: number;
    foreignKeys: number;
  }> | {
    writeGateOpen: boolean;
    journalMode: string;
    synchronous: number;
    foreignKeys: number;
  };
  rate(): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  }> | {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
  };
}

export interface ManufacturingRunReadiness {
  schemaVersion: 'manufacturing-run-readiness/v1';
  ready: boolean;
  checkedAt: string;
  checks: {
    host: { ok: boolean; code?: string };
    clock: { ok: boolean; skewMs?: number; code?: string };
    gate: { ok: boolean; code?: string };
    attestation: { ok: boolean; state?: string; code?: string };
    storage: { ok: boolean; code?: string };
    rate: {
      ok: boolean;
      remaining?: number;
      retryAfterMs?: number;
      code?: string;
    };
  };
}

function safeCode(value: string | undefined, fallback: string): string {
  return value && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : fallback;
}

function attestationCode(state: string): string {
  switch (state) {
    case 'missing':
      return 'ATTESTATION_MISSING';
    case 'expired':
      return 'ATTESTATION_EXPIRED';
    case 'invalid':
      return 'ATTESTATION_INVALID';
    default:
      return 'ATTESTATION_UNAVAILABLE';
  }
}

export async function evaluateManufacturingRunReadiness(
  options: ManufacturingRunReadinessOptions
): Promise<ManufacturingRunReadiness> {
  const now = options.now?.() ?? new Date();
  let host: ManufacturingRunReadiness['checks']['host'];
  try {
    const value = await options.host();
    host = value.healthy
      ? { ok: true }
      : { ok: false, code: safeCode(value.reasonCode, 'HOST_UNHEALTHY') };
  } catch {
    host = { ok: false, code: 'HOST_UNAVAILABLE' };
  }

  let clock: ManufacturingRunReadiness['checks']['clock'];
  try {
    const value = await options.clock();
    const ok = Number.isFinite(value.skewMs) && Math.abs(value.skewMs) <= 300_000;
    clock = ok
      ? { ok: true, skewMs: value.skewMs }
      : { ok: false, skewMs: value.skewMs, code: 'CLOCK_SKEW' };
  } catch {
    clock = { ok: false, code: 'CLOCK_UNAVAILABLE' };
  }

  let gate: ManufacturingRunReadiness['checks']['gate'];
  let attestation: ManufacturingRunReadiness['checks']['attestation'];
  try {
    const value = await options.gate();
    gate = value.enabled
      ? { ok: true }
      : {
          ok: false,
          code: safeCode(value.reasonCode, 'WRITE_GATE_CLOSED'),
        };
    attestation = value.attestationState === 'valid'
      ? { ok: true, state: 'valid' }
      : {
          ok: false,
          state: value.attestationState,
          code: attestationCode(value.attestationState),
        };
  } catch {
    gate = { ok: false, code: 'WRITE_GATE_UNAVAILABLE' };
    attestation = { ok: false, code: 'ATTESTATION_UNAVAILABLE' };
  }

  let storage: ManufacturingRunReadiness['checks']['storage'];
  try {
    const value = await options.storage();
    const ok =
      value.writeGateOpen === true &&
      value.journalMode.toLowerCase() === 'wal' &&
      value.synchronous === 2 &&
      value.foreignKeys === 1;
    storage = ok
      ? { ok: true }
      : { ok: false, code: 'STORAGE_UNHEALTHY' };
  } catch {
    storage = { ok: false, code: 'STORAGE_UNAVAILABLE' };
  }

  let rate: ManufacturingRunReadiness['checks']['rate'];
  try {
    const value = await options.rate();
    rate = value.allowed
      ? {
          ok: true,
          remaining: value.remaining,
          retryAfterMs: value.retryAfterMs,
        }
      : {
          ok: false,
          remaining: value.remaining,
          retryAfterMs: value.retryAfterMs,
          code: 'RATE_BUDGET_EXHAUSTED',
        };
  } catch {
    rate = { ok: false, code: 'RATE_BUDGET_UNAVAILABLE' };
  }

  const checks = { host, clock, gate, attestation, storage, rate };
  return {
    schemaVersion: 'manufacturing-run-readiness/v1',
    ready: Object.values(checks).every((check) => check.ok),
    checkedAt: now.toISOString(),
    checks,
  };
}
