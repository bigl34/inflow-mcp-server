import { describe, expect, it, vi } from 'vitest';

const readinessModule = await import('./manufacturing-run-readiness.js').catch(
  () => ({})
) as Record<string, any>;

function evaluate(options: Record<string, unknown>): Promise<unknown> {
  expect(readinessModule.evaluateManufacturingRunReadiness).toBeTypeOf('function');
  return readinessModule.evaluateManufacturingRunReadiness(options);
}

describe('manufacturing run readiness', () => {
  it('checks host, clock, gate, attestation, storage, and rate without consuming budget', async () => {
    const rateStatus = vi.fn(() => ({
      allowed: true,
      remaining: 12,
      retryAfterMs: 0,
    }));
    await expect(evaluate({
      now: () => new Date('2026-07-24T10:00:00.000Z'),
      host: () => ({ healthy: true }),
      clock: () => ({ skewMs: 125 }),
      gate: () => ({
        enabled: true,
        reasonCode: undefined,
        attestationState: 'valid',
      }),
      storage: () => ({
        writeGateOpen: true,
        journalMode: 'wal',
        synchronous: 2,
        foreignKeys: 1,
      }),
      rate: rateStatus,
    })).resolves.toEqual({
      schemaVersion: 'manufacturing-run-readiness/v1',
      ready: true,
      checkedAt: '2026-07-24T10:00:00.000Z',
      checks: {
        host: { ok: true },
        clock: { ok: true, skewMs: 125 },
        gate: { ok: true },
        attestation: { ok: true, state: 'valid' },
        storage: { ok: true },
        rate: { ok: true, remaining: 12, retryAfterMs: 0 },
      },
    });
    expect(rateStatus).toHaveBeenCalledOnce();
  });

  it('fails closed with sanitized reason codes for unhealthy dependencies', async () => {
    await expect(evaluate({
      now: () => new Date('2026-07-24T10:00:00.000Z'),
      host: () => ({ healthy: false, reasonCode: 'HOST_UNHEALTHY' }),
      clock: () => ({ skewMs: 300_001 }),
      gate: () => ({
        enabled: false,
        reasonCode: 'ENVIRONMENT_GATE_DISABLED',
        attestationState: 'expired',
      }),
      storage: () => {
        throw new Error('database path /secret/state.sqlite');
      },
      rate: () => ({
        allowed: false,
        remaining: 0,
        retryAfterMs: 10_000,
      }),
    })).resolves.toEqual({
      schemaVersion: 'manufacturing-run-readiness/v1',
      ready: false,
      checkedAt: '2026-07-24T10:00:00.000Z',
      checks: {
        host: { ok: false, code: 'HOST_UNHEALTHY' },
        clock: { ok: false, skewMs: 300_001, code: 'CLOCK_SKEW' },
        gate: { ok: false, code: 'ENVIRONMENT_GATE_DISABLED' },
        attestation: { ok: false, state: 'expired', code: 'ATTESTATION_EXPIRED' },
        storage: { ok: false, code: 'STORAGE_UNAVAILABLE' },
        rate: {
          ok: false,
          remaining: 0,
          retryAfterMs: 10_000,
          code: 'RATE_BUDGET_EXHAUSTED',
        },
      },
    });
  });
});
