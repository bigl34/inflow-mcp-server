import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const authModule = await import('./manufacturing-run-auth.js')
  .catch(() => ({})) as Record<string, any>;

const VERSION = 'manufacturing-run-hmac/v1';
const NOW = new Date('2026-07-24T10:00:00.000Z');
const signingFixtures = JSON.parse(readFileSync(
  new URL('./fixtures/manufacturing-run-signing-v1.json', import.meta.url),
  'utf8'
)) as {
  schemaVersion: string;
  authVersion: string;
  keys: Record<string, { kid: string; secret: string }>;
  cases: Array<{
    name: string;
    key: string;
    method: string;
    pathAndQuery: string;
    audience: string;
    companyId: string;
    timestamp: string;
    nonce: string;
    rawBodyUtf8: string;
    bodySha256Hex: string;
    canonicalMaterialUtf8: string;
    signatureHex: string;
  }>;
};

function exportsOf(): Record<string, any> {
  expect(authModule.verifyManufacturingRunRequest).toBeTypeOf('function');
  expect(authModule.manufacturingRunCanonicalMaterial).toBeTypeOf('function');
  return authModule as Record<string, any>;
}

function signed(input: {
  secret?: string;
  kid?: string;
  method?: string;
  url?: string;
  body?: Buffer;
  audience?: string;
  companyId?: string;
  timestamp?: string;
  nonce?: string;
} = {}): {
  method: string;
  url: string;
  rawBody: Buffer;
  headers: Record<string, string>;
} {
  const method = input.method ?? 'POST';
  const url = input.url ?? '/v1/manufacturing-runs/status?source=zapier';
  const rawBody = input.body ?? Buffer.from('{"operationId":"operation-1"}');
  const kid = input.kid ?? 'current';
  const audience = input.audience ?? 'zapier-private-app';
  const companyId = input.companyId ?? 'company-1';
  const timestamp = input.timestamp ?? String(Math.floor(NOW.getTime() / 1_000));
  const nonce = input.nonce ?? 'nonce-1234567890';
  const digest = createHash('sha256').update(rawBody).digest('hex');
  const material = [
    VERSION,
    method,
    url,
    audience,
    companyId,
    timestamp,
    nonce,
    kid,
    digest,
  ].join('\n');
  const signature = createHmac('sha256', input.secret ?? 'current-secret')
    .update(material)
    .digest('hex');
  return {
    method,
    url,
    rawBody,
    headers: {
      'x-inflow-auth-version': VERSION,
      'x-inflow-key-id': kid,
      'x-inflow-timestamp': timestamp,
      'x-inflow-nonce': nonce,
      'x-inflow-audience': audience,
      'x-inflow-company-id': companyId,
      'x-inflow-signature': signature,
    },
  };
}

function verifier(overrides: Record<string, unknown> = {}) {
  const claims = new Set<string>();
  return {
    expectedAudience: 'zapier-private-app',
    expectedCompanyId: 'company-1',
    now: () => NOW,
    keyring: () => ({
      current: { kid: 'current', secret: 'current-secret' },
      next: { kid: 'next', secret: 'next-secret' },
    }),
    nonceStore: {
      claimNonce: ({ nonce }: { nonce: string }) => {
        if (claims.has(nonce)) return false;
        claims.add(nonce);
        return true;
      },
    },
    ...overrides,
  };
}

describe('manufacturing run request authentication', () => {
  it('verifies the shared current and next cross-runtime fixtures byte-for-byte', () => {
    const {
      manufacturingRunCanonicalMaterial,
      verifyManufacturingRunRequest,
    } = exportsOf();
    expect(signingFixtures).toMatchObject({
      schemaVersion: 'manufacturing-run-signing-fixtures/v1',
      authVersion: VERSION,
    });
    expect(signingFixtures.cases.map((fixture) => fixture.key)).toEqual([
      'current',
      'next',
    ]);

    const keyring = {
      current: signingFixtures.keys.current,
      next: signingFixtures.keys.next,
    };
    for (const fixture of signingFixtures.cases) {
      const key = signingFixtures.keys[fixture.key]!;
      const rawBody = Buffer.from(fixture.rawBodyUtf8, 'utf8');
      const material = manufacturingRunCanonicalMaterial({
        version: signingFixtures.authVersion,
        method: fixture.method,
        pathAndQuery: fixture.pathAndQuery,
        audience: fixture.audience,
        companyId: fixture.companyId,
        timestamp: fixture.timestamp,
        nonce: fixture.nonce,
        kid: key.kid,
        rawBody,
      });
      expect(createHash('sha256').update(rawBody).digest('hex')).toBe(
        fixture.bodySha256Hex
      );
      expect(material.toString('utf8')).toBe(fixture.canonicalMaterialUtf8);
      expect(createHmac('sha256', key.secret).update(material).digest('hex')).toBe(
        fixture.signatureHex
      );
      expect(verifyManufacturingRunRequest({
        method: fixture.method,
        url: fixture.pathAndQuery,
        rawBody,
        headers: {
          'x-inflow-auth-version': signingFixtures.authVersion,
          'x-inflow-key-id': key.kid,
          'x-inflow-timestamp': fixture.timestamp,
          'x-inflow-nonce': fixture.nonce,
          'x-inflow-audience': fixture.audience,
          'x-inflow-company-id': fixture.companyId,
          'x-inflow-signature': fixture.signatureHex,
        },
        expectedAudience: fixture.audience,
        expectedCompanyId: fixture.companyId,
        keyring: () => keyring,
        nonceStore: { claimNonce: () => true },
        now: () => NOW,
      })).toMatchObject({ kid: key.kid });
    }
  });

  it('rejects shared fixture body, path, and query tampering', () => {
    const { verifyManufacturingRunRequest } = exportsOf();
    const fixture = signingFixtures.cases[0]!;
    const key = signingFixtures.keys[fixture.key]!;
    const request = {
      method: fixture.method,
      url: fixture.pathAndQuery,
      rawBody: Buffer.from(fixture.rawBodyUtf8, 'utf8'),
      headers: {
        'x-inflow-auth-version': signingFixtures.authVersion,
        'x-inflow-key-id': key.kid,
        'x-inflow-timestamp': fixture.timestamp,
        'x-inflow-nonce': fixture.nonce,
        'x-inflow-audience': fixture.audience,
        'x-inflow-company-id': fixture.companyId,
        'x-inflow-signature': fixture.signatureHex,
      },
    };
    const options = {
      expectedAudience: fixture.audience,
      expectedCompanyId: fixture.companyId,
      keyring: () => ({
        current: signingFixtures.keys.current!,
        next: signingFixtures.keys.next!,
      }),
      nonceStore: { claimNonce: () => true },
      now: () => NOW,
    };
    for (const tampered of [
      { ...request, rawBody: Buffer.from(`${fixture.rawBodyUtf8} `, 'utf8') },
      { ...request, url: `${fixture.pathAndQuery}/tampered` },
      { ...request, url: `${fixture.pathAndQuery}?tampered=true` },
    ]) {
      expect(() => verifyManufacturingRunRequest({
        ...tampered,
        ...options,
      })).toThrow(/AUTH_SIGNATURE_INVALID/);
    }
  });

  it('binds the exact raw bytes, method, path/query, audience, tenant, time, nonce, kid, and version', () => {
    const { verifyManufacturingRunRequest } = exportsOf();
    const options = verifier();
    expect(verifyManufacturingRunRequest({
      ...signed(),
      ...options,
    })).toEqual({
      version: VERSION,
      kid: 'current',
      audience: 'zapier-private-app',
      companyId: 'company-1',
      timestamp: Math.floor(NOW.getTime() / 1_000),
      nonce: 'nonce-1234567890',
      bodyHash: createHash('sha256')
        .update(Buffer.from('{"operationId":"operation-1"}'))
        .digest('hex'),
    });

    const base = signed();
    for (const request of [
      { ...base, rawBody: Buffer.from('{"operationId":"operation-2"}') },
      { ...base, method: 'PUT' },
      { ...base, url: '/v1/manufacturing-runs/status?source=other' },
      signed({ audience: 'wrong-audience' }),
      signed({ companyId: 'other-company' }),
    ]) {
      expect(() => verifyManufacturingRunRequest({
        ...request,
        ...verifier(),
      })).toThrow(/AUTH_/);
    }
  });

  it('rejects expired and future timestamps outside five minutes', () => {
    const { verifyManufacturingRunRequest } = exportsOf();
    const expired = signed({
      timestamp: String(Math.floor((NOW.getTime() - 300_001) / 1_000)),
    });
    const future = signed({
      timestamp: String(Math.ceil((NOW.getTime() + 300_001) / 1_000)),
    });
    expect(() => verifyManufacturingRunRequest({
      ...expired,
      ...verifier(),
    })).toThrow(/AUTH_TIMESTAMP_OUT_OF_WINDOW/);
    expect(() => verifyManufacturingRunRequest({
      ...future,
      ...verifier(),
    })).toThrow(/AUTH_TIMESTAMP_OUT_OF_WINDOW/);
  });

  it('accepts current and next keys, rejects replay, and honors immediate revocation', () => {
    const { verifyManufacturingRunRequest } = exportsOf();
    const keys = {
      current: { kid: 'current', secret: 'current-secret' },
      next: { kid: 'next', secret: 'next-secret' },
    };
    const options = verifier({ keyring: () => keys });
    expect(verifyManufacturingRunRequest({
      ...signed({ nonce: 'nonce-current' }),
      ...options,
    }).kid).toBe('current');
    expect(verifyManufacturingRunRequest({
      ...signed({
        kid: 'next',
        secret: 'next-secret',
        nonce: 'nonce-next',
      }),
      ...options,
    }).kid).toBe('next');
    expect(() => verifyManufacturingRunRequest({
      ...signed({ nonce: 'nonce-current' }),
      ...options,
    })).toThrow(/AUTH_NONCE_REPLAY/);

    delete (keys as { next?: unknown }).next;
    expect(() => verifyManufacturingRunRequest({
      ...signed({
        kid: 'next',
        secret: 'next-secret',
        nonce: 'nonce-revoked',
      }),
      ...options,
    })).toThrow(/AUTH_KEY_REVOKED/);
  });

  it('uses a constant-length SHA-256 MAC and claims a ten-minute nonce lease only after verification', () => {
    const { verifyManufacturingRunRequest } = exportsOf();
    const calls: Array<Record<string, unknown>> = [];
    const options = verifier({
      nonceStore: {
        claimNonce: (claim: Record<string, unknown>) => {
          calls.push(claim);
          return true;
        },
      },
    });
    const request = signed();
    request.headers['x-inflow-signature'] = '00';
    expect(() => verifyManufacturingRunRequest({
      ...request,
      ...options,
    })).toThrow(/AUTH_SIGNATURE_INVALID/);
    expect(calls).toEqual([]);

    verifyManufacturingRunRequest({
      ...signed(),
      ...options,
    });
    expect(calls).toEqual([{
      kid: 'current',
      nonce: 'nonce-1234567890',
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    }]);
  });
});
