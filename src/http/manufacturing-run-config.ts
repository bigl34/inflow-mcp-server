import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import type { ManufacturingRunHmacKeyring } from './manufacturing-run-auth.js';

type Environment = Record<string, string | undefined>;

export interface ManufacturingRunHttpConfig {
  host: string;
  port: number;
  audience: string;
  companyId: string;
  databasePath: string;
  processLockPath: string;
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxHeaderBytes: number;
  workerPollMs: number;
  webhookRunReadyUrl: string;
  webhookTerminalUrl: string;
  webhookAudience: string;
  webhookMaxAttempts: number;
  webhookRetryDelayMs: number;
  webhookTimeoutMs: number;
  webhookClaimTtlMs: number;
  listenerExclusive: true;
}

function requireText(
  environment: Environment,
  name: string,
  code = name
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${code}_REQUIRED`);
  return value;
}

function positiveInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string
): number {
  const text = environment[name];
  const value = text === undefined ? fallback : Number(text);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(code);
  }
  return value;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '127.0.0.1' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}

function requireHttpsUrl(environment: Environment, name: string): string {
  const value = requireText(environment, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('COORDINATOR_WEBHOOK_URL_INVALID');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('COORDINATOR_WEBHOOK_HTTPS_REQUIRED');
  }
  return parsed.toString();
}

export function loadManufacturingRunHmacKeyring(
  environment: Environment = process.env
): ManufacturingRunHmacKeyring {
  const currentKid = requireText(
    environment,
    'INFLOW_COORDINATOR_HMAC_CURRENT_KID',
    'HMAC_CURRENT_KID'
  );
  const currentSecret = requireText(
    environment,
    'INFLOW_COORDINATOR_HMAC_CURRENT_SECRET',
    'HMAC_CURRENT_SECRET'
  );
  if (currentSecret.length < 32) throw new Error('HMAC_CURRENT_SECRET_INVALID');
  const nextKid = environment.INFLOW_COORDINATOR_HMAC_NEXT_KID?.trim();
  const nextSecret = environment.INFLOW_COORDINATOR_HMAC_NEXT_SECRET?.trim();
  if (Boolean(nextKid) !== Boolean(nextSecret)) {
    throw new Error('HMAC_NEXT_INCOMPLETE');
  }
  if (nextSecret && nextSecret.length < 32) {
    throw new Error('HMAC_NEXT_SECRET_INVALID');
  }
  if (nextKid === currentKid) throw new Error('HMAC_NEXT_KID_DUPLICATE');
  return {
    current: { kid: currentKid, secret: currentSecret },
    ...(nextKid && nextSecret
      ? { next: { kid: nextKid, secret: nextSecret } }
      : {}),
  };
}

export function loadManufacturingRunHttpConfig(
  environment: Environment = process.env
): ManufacturingRunHttpConfig {
  loadManufacturingRunHmacKeyring(environment);
  const companyId = requireText(environment, 'INFLOW_COMPANY_ID');
  const host = environment.INFLOW_COORDINATOR_HOST?.trim() || '127.0.0.1';
  if (!isLoopback(host)) throw new Error('COORDINATOR_LOOPBACK_REQUIRED');
  const stateDir = resolve(
    environment.INFLOW_STATE_DIR ??
      join(environment.HOME || '/tmp', '.local/state/inflow-mcp')
  );
  const bodyLimitBytes = positiveInteger(
    environment,
    'INFLOW_COORDINATOR_BODY_LIMIT_BYTES',
    65_536,
    1_024,
    65_536,
    'COORDINATOR_BODY_LIMIT_INVALID'
  );
  const webhookClaimTtlMs = positiveInteger(
    environment,
    'INFLOW_COORDINATOR_WEBHOOK_CLAIM_TTL_MS',
    30_000,
    1_000,
    3_600_000,
    'COORDINATOR_WEBHOOK_CLAIM_TTL_INVALID'
  );
  const webhookTimeoutMs = positiveInteger(
    environment,
    'INFLOW_COORDINATOR_WEBHOOK_TIMEOUT_MS',
    10_000,
    100,
    3_599_999,
    'COORDINATOR_WEBHOOK_TIMEOUT_INVALID'
  );
  if (webhookTimeoutMs >= webhookClaimTtlMs) {
    throw new Error('COORDINATOR_WEBHOOK_TIMEOUT_MUST_PRECEDE_CLAIM_TTL');
  }
  return {
    host,
    port: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_PORT',
      8_787,
      1,
      65_535,
      'COORDINATOR_PORT_INVALID'
    ),
    audience:
      environment.INFLOW_COORDINATOR_AUDIENCE?.trim() || 'zapier-private-app',
    companyId,
    databasePath: resolve(
      environment.INFLOW_COORDINATOR_DATABASE_PATH ??
        join(stateDir, 'manufacturing-runs.sqlite')
    ),
    processLockPath: resolve(
      environment.INFLOW_COORDINATOR_PROCESS_LOCK_PATH ??
        join(stateDir, 'manufacturing-run-http.lock')
    ),
    bodyLimitBytes,
    requestTimeoutMs: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_REQUEST_TIMEOUT_MS',
      10_000,
      100,
      60_000,
      'COORDINATOR_REQUEST_TIMEOUT_INVALID'
    ),
    headersTimeoutMs: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_HEADERS_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      'COORDINATOR_HEADERS_TIMEOUT_INVALID'
    ),
    keepAliveTimeoutMs: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_KEEP_ALIVE_TIMEOUT_MS',
      5_000,
      100,
      60_000,
      'COORDINATOR_KEEP_ALIVE_TIMEOUT_INVALID'
    ),
    maxHeaderBytes: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_MAX_HEADER_BYTES',
      16_384,
      1_024,
      32_768,
      'COORDINATOR_HEADER_LIMIT_INVALID'
    ),
    workerPollMs: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_WORKER_POLL_MS',
      250,
      10,
      60_000,
      'COORDINATOR_WORKER_POLL_INVALID'
    ),
    webhookRunReadyUrl: requireHttpsUrl(
      environment,
      'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL'
    ),
    webhookTerminalUrl: requireHttpsUrl(
      environment,
      'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL'
    ),
    webhookAudience:
      environment.INFLOW_COORDINATOR_WEBHOOK_AUDIENCE?.trim() ||
      'zapier-webhook',
    webhookMaxAttempts: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_WEBHOOK_MAX_ATTEMPTS',
      5,
      1,
      20,
      'COORDINATOR_WEBHOOK_MAX_ATTEMPTS_INVALID'
    ),
    webhookRetryDelayMs: positiveInteger(
      environment,
      'INFLOW_COORDINATOR_WEBHOOK_RETRY_DELAY_MS',
      5_000,
      100,
      3_600_000,
      'COORDINATOR_WEBHOOK_RETRY_DELAY_INVALID'
    ),
    webhookTimeoutMs,
    webhookClaimTtlMs,
    listenerExclusive: true,
  };
}
