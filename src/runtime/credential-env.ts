import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

const COORDINATOR_ENVIRONMENT_NAMES = [
  'INFLOW_API_KEY',
  'INFLOW_API_VERSION',
  'INFLOW_BASE_URL',
  'INFLOW_COMPANY_ID',
  'INFLOW_COORDINATOR_AUDIENCE',
  'INFLOW_COORDINATOR_BODY_LIMIT_BYTES',
  'INFLOW_COORDINATOR_DATABASE_PATH',
  'INFLOW_COORDINATOR_HEADERS_TIMEOUT_MS',
  'INFLOW_COORDINATOR_HMAC_CURRENT_KID',
  'INFLOW_COORDINATOR_HMAC_CURRENT_SECRET',
  'INFLOW_COORDINATOR_HMAC_NEXT_KID',
  'INFLOW_COORDINATOR_HMAC_NEXT_SECRET',
  'INFLOW_COORDINATOR_HOST',
  'INFLOW_COORDINATOR_KEEP_ALIVE_TIMEOUT_MS',
  'INFLOW_COORDINATOR_LAUNCHD_LABEL',
  'INFLOW_COORDINATOR_MAX_HEADER_BYTES',
  'INFLOW_COORDINATOR_PORT',
  'INFLOW_COORDINATOR_PROCESS_LOCK_PATH',
  'INFLOW_COORDINATOR_REQUEST_TIMEOUT_MS',
  'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL',
  'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL',
  'INFLOW_COORDINATOR_WEBHOOK_AUDIENCE',
  'INFLOW_COORDINATOR_WEBHOOK_CLAIM_TTL_MS',
  'INFLOW_COORDINATOR_WEBHOOK_MAX_ATTEMPTS',
  'INFLOW_COORDINATOR_WEBHOOK_RETRY_DELAY_MS',
  'INFLOW_COORDINATOR_WEBHOOK_TIMEOUT_MS',
  'INFLOW_COORDINATOR_WORKER_POLL_MS',
  'INFLOW_DEBUG',
  'INFLOW_ENABLE_LEGACY_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_WRITES',
  'INFLOW_ENABLE_MO_SERIAL_WRITES',
  'INFLOW_ENABLE_PRICE_WRITES',
  'INFLOW_ENABLE_PRODUCT_GROUP_WRITES',
  'INFLOW_ENABLE_SAFE_WRITES',
  'INFLOW_ENABLE_STANDARD_WRITES',
  'INFLOW_ENABLE_STOCK_WRITES',
  'INFLOW_MAX_RETRIES',
  'INFLOW_RATE_LIMIT',
  'INFLOW_READ_RETRY_BUDGET',
  'INFLOW_REQUEST_TIMEOUT',
  'INFLOW_RETRY_DELAY',
  'INFLOW_STATE_DIR',
] as const;

export const ALLOWED_COORDINATOR_ENVIRONMENT_NAMES: ReadonlySet<string> =
  new Set(COORDINATOR_ENVIRONMENT_NAMES);

export class CredentialEnvironmentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CredentialEnvironmentError';
  }
}

const REQUIRED_COORDINATOR_ENVIRONMENT_NAMES = [
  'INFLOW_COMPANY_ID',
  'INFLOW_API_KEY',
  'INFLOW_COORDINATOR_HMAC_CURRENT_KID',
  'INFLOW_COORDINATOR_HMAC_CURRENT_SECRET',
  'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL',
  'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL',
] as const;

const WRITE_GATE_NAMES = [
  'INFLOW_ENABLE_SAFE_WRITES',
  'INFLOW_ENABLE_STOCK_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_WRITES',
  'INFLOW_ENABLE_PRICE_WRITES',
  'INFLOW_ENABLE_PRODUCT_GROUP_WRITES',
  'INFLOW_ENABLE_MO_SERIAL_WRITES',
  'INFLOW_ENABLE_STANDARD_WRITES',
  'INFLOW_ENABLE_LEGACY_WRITES',
] as const;

export function parseCredentialEnvironment(
  source: string
): Record<string, string> {
  if (source.includes('\0')) {
    throw new CredentialEnvironmentError('CREDENTIAL_ENV_NUL_BYTE');
  }
  const parsed: Record<string, string> = {};
  const lines = source.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r')
      ? lines[index].slice(0, -1)
      : lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = separator < 0 ? '' : line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new CredentialEnvironmentError(
        `CREDENTIAL_ENV_MALFORMED_LINE_${index + 1}`
      );
    }
    if (!ALLOWED_COORDINATOR_ENVIRONMENT_NAMES.has(key)) {
      throw new CredentialEnvironmentError(
        `CREDENTIAL_ENV_KEY_NOT_ALLOWED_${key}`
      );
    }
    if (Object.hasOwn(parsed, key)) {
      throw new CredentialEnvironmentError(
        `CREDENTIAL_ENV_DUPLICATE_KEY_${key}`
      );
    }
    const value = line.slice(separator + 1);
    if (value.length === 0 || value.includes('\r')) {
      throw new CredentialEnvironmentError(
        `CREDENTIAL_ENV_VALUE_INVALID_${key}`
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

export function validateCoordinatorCredentialEnvironment(
  values: Readonly<Record<string, string>>
): void {
  for (const name of REQUIRED_COORDINATOR_ENVIRONMENT_NAMES) {
    if (!values[name]?.trim()) {
      throw new CredentialEnvironmentError(`${name}_REQUIRED`);
    }
  }
  if (values.INFLOW_COORDINATOR_HMAC_CURRENT_SECRET.length < 32) {
    throw new CredentialEnvironmentError('HMAC_CURRENT_SECRET_INVALID');
  }
  const nextKid = values.INFLOW_COORDINATOR_HMAC_NEXT_KID?.trim();
  const nextSecret = values.INFLOW_COORDINATOR_HMAC_NEXT_SECRET;
  if (Boolean(nextKid) !== Boolean(nextSecret)) {
    throw new CredentialEnvironmentError('HMAC_NEXT_INCOMPLETE');
  }
  if (nextSecret !== undefined && nextSecret.length < 32) {
    throw new CredentialEnvironmentError('HMAC_NEXT_SECRET_INVALID');
  }
  if (
    nextKid !== undefined &&
    nextKid === values.INFLOW_COORDINATOR_HMAC_CURRENT_KID.trim()
  ) {
    throw new CredentialEnvironmentError('HMAC_NEXT_KID_DUPLICATE');
  }
  for (const name of [
    'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL',
    'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL',
  ] as const) {
    let parsed: URL;
    try {
      parsed = new URL(values[name]);
    } catch {
      throw new CredentialEnvironmentError('COORDINATOR_WEBHOOK_URL_INVALID');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new CredentialEnvironmentError('COORDINATOR_WEBHOOK_HTTPS_REQUIRED');
    }
  }
  for (const name of WRITE_GATE_NAMES) {
    const value = values[name];
    if (value !== undefined && value !== 'true' && value !== 'false') {
      throw new CredentialEnvironmentError(`WRITE_GATE_INVALID_${name}`);
    }
  }
}

export function installCoordinatorCredentialEnvironment(
  values: Readonly<Record<string, string>>,
  target: Record<string, string | undefined> = process.env
): void {
  validateCoordinatorCredentialEnvironment(values);
  for (const name of Object.keys(target)) {
    if (name.startsWith('INFLOW_')) delete target[name];
  }
  for (const [name, value] of Object.entries(values)) {
    target[name] = value;
  }
}

export interface CredentialFileMetadata {
  isFile(): boolean;
  mode: number;
  nlink: number;
  uid: number;
}

export function validateCredentialFileMetadata(
  metadata: CredentialFileMetadata,
  currentUid: number | undefined
): void {
  if (!metadata.isFile()) {
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_NOT_REGULAR');
  }
  if (metadata.nlink !== 1) {
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_LINK_COUNT_INVALID');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_MODE_INVALID');
  }
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_OWNER_INVALID');
  }
}

export function readSecureCredentialEnvironment(
  credentialFile: string
): Record<string, string> {
  if (!isAbsolute(credentialFile)) {
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_ABSOLUTE_REQUIRED');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      credentialFile,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const metadata = fstatSync(descriptor);
    const uid =
      typeof process.getuid === 'function' ? process.getuid() : undefined;
    validateCredentialFileMetadata(metadata, uid);
    if (metadata.size > 65_536) {
      throw new CredentialEnvironmentError('CREDENTIAL_FILE_TOO_LARGE');
    }
    const values = parseCredentialEnvironment(readFileSync(descriptor, 'utf8'));
    validateCoordinatorCredentialEnvironment(values);
    return values;
  } catch (error) {
    if (error instanceof CredentialEnvironmentError) throw error;
    throw new CredentialEnvironmentError('CREDENTIAL_FILE_OPEN_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
