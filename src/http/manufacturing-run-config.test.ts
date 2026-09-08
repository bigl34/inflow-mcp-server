import { describe, expect, it } from 'vitest';

const configModule = await import('./manufacturing-run-config.js').catch(
  () => ({})
);

function exported(name: string): (...args: any[]) => any {
  const value = (configModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value as (...args: any[]) => any;
}

function environment(): Record<string, string> {
  return {
    HOME: '/home/service',
    INFLOW_COMPANY_ID: 'company-1',
    INFLOW_STATE_DIR: '/var/lib/inflow',
    INFLOW_COORDINATOR_HMAC_CURRENT_KID: 'current',
    INFLOW_COORDINATOR_HMAC_CURRENT_SECRET: 'c'.repeat(32),
    INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL:
      'https://hooks.zapier.invalid/run-ready',
    INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL:
      'https://hooks.zapier.invalid/terminal',
  };
}

describe('manufacturing run HTTP configuration', () => {
  it('loads safe loopback, exclusive, bounded defaults without exposing keys', () => {
    const load = exported('loadManufacturingRunHttpConfig');
    const config = load(environment());
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 8787,
      audience: 'zapier-private-app',
      companyId: 'company-1',
      databasePath: '/var/lib/inflow/manufacturing-runs.sqlite',
      processLockPath: '/var/lib/inflow/manufacturing-run-http.lock',
      bodyLimitBytes: 65_536,
      requestTimeoutMs: 10_000,
      headersTimeoutMs: 5_000,
      keepAliveTimeoutMs: 5_000,
      maxHeaderBytes: 16_384,
      workerPollMs: 250,
      webhookRunReadyUrl: 'https://hooks.zapier.invalid/run-ready',
      webhookTerminalUrl: 'https://hooks.zapier.invalid/terminal',
      webhookAudience: 'zapier-webhook',
      webhookMaxAttempts: 5,
      webhookRetryDelayMs: 5_000,
      webhookTimeoutMs: 10_000,
      webhookClaimTtlMs: 30_000,
      listenerExclusive: true,
    });
    expect(JSON.stringify(config)).not.toContain('c'.repeat(32));
  });

  it('reloads current/next keys so removal revokes the next key immediately', () => {
    const loadKeys = exported('loadManufacturingRunHmacKeyring');
    const env = {
      ...environment(),
      INFLOW_COORDINATOR_HMAC_NEXT_KID: 'next',
      INFLOW_COORDINATOR_HMAC_NEXT_SECRET: 'n'.repeat(32),
    };
    expect(loadKeys(env)).toEqual({
      current: { kid: 'current', secret: 'c'.repeat(32) },
      next: { kid: 'next', secret: 'n'.repeat(32) },
    });
    delete (env as Record<string, string | undefined>)
      .INFLOW_COORDINATOR_HMAC_NEXT_KID;
    delete (env as Record<string, string | undefined>)
      .INFLOW_COORDINATOR_HMAC_NEXT_SECRET;
    expect(loadKeys(env)).toEqual({
      current: { kid: 'current', secret: 'c'.repeat(32) },
    });
  });

  it.each([
    [{ INFLOW_COORDINATOR_HOST: '0.0.0.0' }, /LOOPBACK/],
    [{ INFLOW_COORDINATOR_PORT: '0' }, /PORT/],
    [{ INFLOW_COORDINATOR_BODY_LIMIT_BYTES: '1000000' }, /BODY_LIMIT/],
    [{ INFLOW_COORDINATOR_HMAC_CURRENT_SECRET: 'short' }, /HMAC/],
    [{ INFLOW_COORDINATOR_HMAC_NEXT_KID: 'next' }, /HMAC_NEXT/],
    [{
      INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL: 'http://hooks.invalid/run-ready',
    }, /WEBHOOK_HTTPS/],
    [{
      INFLOW_COORDINATOR_WEBHOOK_TIMEOUT_MS: '30000',
    }, /WEBHOOK_TIMEOUT.*CLAIM_TTL/],
  ])('rejects unsafe or incomplete configuration %#', (override, expected) => {
    const load = exported('loadManufacturingRunHttpConfig');
    expect(() => load({ ...environment(), ...override })).toThrow(expected);
  });
});
