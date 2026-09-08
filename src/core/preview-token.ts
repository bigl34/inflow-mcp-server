import {
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from 'node:crypto';
import { stableStringify } from './canonical-json.js';

export interface PreviewTokenPayload {
  schemaVersion: 'preview-token/v1';
  operationId: string;
  operation: string;
  idempotencyKeyHash?: string;
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  resourceType: string;
  resourceId?: string;
  mode: string;
  currentSemanticHash?: string;
  currentWriteShapeHash?: string;
  entityTimestamp?: string;
  desiredHash: string;
  sourceHashes?: Record<string, string>;
  plannedIds?: Record<string, string[]>;
  adapterVersion: string;
  serializerVersion: string;
  contractVersion: string;
  issuedAt: string;
  expiresAt: string;
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function tenantFingerprint(companyId: string, _apiKey: string, baseHost = ''): string {
  return createHmac('sha256', 'inflow-tenant-fingerprint/v1')
    .update(`${baseHost.trim().toLowerCase()}\0${companyId}`)
    .digest('hex')
    .slice(0, 24);
}

export class PreviewTokenService {
  private readonly signingKey: Buffer;

  constructor(apiKey: string, companyId: string) {
    this.signingKey = Buffer.from(
      hkdfSync('sha256', apiKey, companyId, 'inflow-preview-token/v1', 32)
    );
  }

  issue(payload: PreviewTokenPayload): string {
    const compactPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined)
    ) as unknown as PreviewTokenPayload;
    const encodedPayload = encode(stableStringify(compactPayload));
    const signature = createHmac('sha256', this.signingKey)
      .update(encodedPayload)
      .digest();
    return `${encodedPayload}.${encode(signature)}`;
  }

  verify(
    token: string,
    expected: Partial<Pick<
      PreviewTokenPayload,
      'operation' | 'tenantFingerprint' | 'baseHost' | 'apiVersion' |
      'resourceType' | 'resourceId' |
      'adapterVersion' | 'serializerVersion' | 'contractVersion'
    >> = {}
  ): PreviewTokenPayload {
    if (Buffer.byteLength(token, 'utf8') > 16_384) {
      throw new Error('INVALID_PREVIEW_TOKEN: token too large');
    }
    const [encodedPayload, encodedSignature, ...rest] = token.split('.');
    if (!encodedPayload || !encodedSignature || rest.length > 0) {
      throw new Error('INVALID_PREVIEW_TOKEN: malformed token');
    }
    const actual = decode(encodedSignature);
    const wanted = createHmac('sha256', this.signingKey)
      .update(encodedPayload)
      .digest();
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw new Error('INVALID_PREVIEW_TOKEN: signature mismatch');
    }

    let payload: PreviewTokenPayload;
    try {
      payload = JSON.parse(decode(encodedPayload).toString('utf8')) as PreviewTokenPayload;
    } catch {
      throw new Error('INVALID_PREVIEW_TOKEN: invalid payload');
    }
    if (payload.schemaVersion !== 'preview-token/v1') {
      throw new Error('INVALID_PREVIEW_TOKEN: unsupported schema');
    }
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw new Error('INVALID_PREVIEW_TOKEN: invalid dates');
    }
    if (issuedAt > Date.now() + 5 * 60_000) {
      throw new Error('INVALID_PREVIEW_TOKEN: issued in the future');
    }
    if (expiresAt <= Date.now()) {
      throw new Error('EXPIRED_PREVIEW_TOKEN: run preview again');
    }
    for (const [key, value] of Object.entries(expected)) {
      if (value !== undefined && payload[key as keyof PreviewTokenPayload] !== value) {
        throw new Error(`PREVIEW_TOKEN_SCOPE_MISMATCH: ${key}`);
      }
    }
    return payload;
  }
}
