import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const MANUFACTURING_RUN_AUTH_VERSION = 'manufacturing-run-hmac/v1';
export const MANUFACTURING_RUN_AUTH_CLOCK_SKEW_MS = 5 * 60_000;
export const MANUFACTURING_RUN_NONCE_TTL_MS = 10 * 60_000;

export interface ManufacturingRunHmacKey {
  kid: string;
  secret: string | Uint8Array;
}

export interface ManufacturingRunHmacKeyring {
  current: ManufacturingRunHmacKey;
  next?: ManufacturingRunHmacKey;
}

export interface ManufacturingRunNonceStore {
  claimNonce(input: {
    kid: string;
    nonce: string;
    expiresAt: string | Date | number;
    now?: string | Date | number;
  }): boolean;
}

export interface ManufacturingRunAuthContext {
  version: typeof MANUFACTURING_RUN_AUTH_VERSION;
  kid: string;
  audience: string;
  companyId: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}

export class ManufacturingRunAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManufacturingRunAuthError';
  }
}

type HeaderValue = string | string[] | undefined;

export interface ManufacturingRunSignedRequest {
  method: string;
  url: string;
  rawBody: Uint8Array;
  headers: Record<string, HeaderValue>;
}

export interface ManufacturingRunAuthOptions {
  expectedAudience: string;
  expectedCompanyId: string;
  keyring(): ManufacturingRunHmacKeyring;
  nonceStore: ManufacturingRunNonceStore;
  now?: () => Date;
}

function requireSingleHeader(
  headers: Record<string, HeaderValue>,
  name: string
): string {
  const direct = headers[name];
  const value = direct ?? Object.entries(headers).find(
    ([candidate]) => candidate.toLowerCase() === name
  )?.[1];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ManufacturingRunAuthError('AUTH_HEADER_MISSING');
  }
  return value;
}

function requiredText(value: string, code: string, maxLength: number): string {
  if (!value || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new ManufacturingRunAuthError(code);
  }
  return value;
}

export function manufacturingRunCanonicalMaterial(input: {
  version: string;
  method: string;
  pathAndQuery: string;
  audience: string;
  companyId: string;
  timestamp: string;
  nonce: string;
  kid: string;
  rawBody: Uint8Array;
}): Buffer {
  const bodyHash = createHash('sha256').update(input.rawBody).digest('hex');
  return Buffer.from([
    input.version,
    input.method,
    input.pathAndQuery,
    input.audience,
    input.companyId,
    input.timestamp,
    input.nonce,
    input.kid,
    bodyHash,
  ].join('\n'), 'utf8');
}

function keyFor(
  keyring: ManufacturingRunHmacKeyring,
  kid: string
): ManufacturingRunHmacKey {
  const candidates = [keyring.current, keyring.next].filter(
    (candidate): candidate is ManufacturingRunHmacKey => candidate !== undefined
  );
  const key = candidates.find((candidate) => candidate.kid === kid);
  if (!key) throw new ManufacturingRunAuthError('AUTH_KEY_REVOKED');
  if (!key.secret || key.kid.length > 128) {
    throw new ManufacturingRunAuthError('AUTH_KEY_INVALID');
  }
  return key;
}

export function verifyManufacturingRunRequest(
  input: ManufacturingRunSignedRequest & ManufacturingRunAuthOptions
): ManufacturingRunAuthContext {
  const version = requireSingleHeader(input.headers, 'x-inflow-auth-version');
  const kid = requiredText(
    requireSingleHeader(input.headers, 'x-inflow-key-id'),
    'AUTH_KEY_INVALID',
    128
  );
  const timestampText = requiredText(
    requireSingleHeader(input.headers, 'x-inflow-timestamp'),
    'AUTH_TIMESTAMP_INVALID',
    32
  );
  const nonce = requiredText(
    requireSingleHeader(input.headers, 'x-inflow-nonce'),
    'AUTH_NONCE_INVALID',
    256
  );
  const audience = requiredText(
    requireSingleHeader(input.headers, 'x-inflow-audience'),
    'AUTH_AUDIENCE_INVALID',
    256
  );
  const companyId = requiredText(
    requireSingleHeader(input.headers, 'x-inflow-company-id'),
    'AUTH_COMPANY_INVALID',
    256
  );
  const signatureText = requireSingleHeader(input.headers, 'x-inflow-signature');

  if (version !== MANUFACTURING_RUN_AUTH_VERSION) {
    throw new ManufacturingRunAuthError('AUTH_VERSION_UNSUPPORTED');
  }
  if (audience !== input.expectedAudience) {
    throw new ManufacturingRunAuthError('AUTH_AUDIENCE_MISMATCH');
  }
  if (companyId !== input.expectedCompanyId) {
    throw new ManufacturingRunAuthError('AUTH_COMPANY_MISMATCH');
  }
  if (!/^[0-9]+$/.test(timestampText)) {
    throw new ManufacturingRunAuthError('AUTH_TIMESTAMP_INVALID');
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ManufacturingRunAuthError('AUTH_TIMESTAMP_INVALID');
  }
  const now = input.now?.() ?? new Date();
  const timestampMs = timestamp * 1_000;
  if (
    !Number.isFinite(now.getTime()) ||
    Math.abs(now.getTime() - timestampMs) > MANUFACTURING_RUN_AUTH_CLOCK_SKEW_MS
  ) {
    throw new ManufacturingRunAuthError('AUTH_TIMESTAMP_OUT_OF_WINDOW');
  }

  const key = keyFor(input.keyring(), kid);
  const bodyHash = createHash('sha256').update(input.rawBody).digest('hex');
  if (!/^[0-9a-f]{64}$/i.test(signatureText)) {
    throw new ManufacturingRunAuthError('AUTH_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha256', key.secret)
    .update(manufacturingRunCanonicalMaterial({
      version,
      method: input.method,
      pathAndQuery: input.url,
      audience,
      companyId,
      timestamp: timestampText,
      nonce,
      kid,
      rawBody: input.rawBody,
    }))
    .digest();
  const actual = Buffer.from(signatureText, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ManufacturingRunAuthError('AUTH_SIGNATURE_INVALID');
  }
  if (!input.nonceStore.claimNonce({
    kid,
    nonce,
    now,
    expiresAt: new Date(now.getTime() + MANUFACTURING_RUN_NONCE_TTL_MS),
  })) {
    throw new ManufacturingRunAuthError('AUTH_NONCE_REPLAY');
  }
  return {
    version: MANUFACTURING_RUN_AUTH_VERSION,
    kid,
    audience,
    companyId,
    timestamp,
    nonce,
    bodyHash,
  };
}
