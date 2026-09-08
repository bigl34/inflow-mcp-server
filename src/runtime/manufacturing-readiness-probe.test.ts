import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { manufacturingRunCanonicalMaterial, MANUFACTURING_RUN_AUTH_VERSION } from '../http/manufacturing-run-auth.js';
import { probeManufacturingReadiness } from './manufacturing-readiness-probe.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('manufacturing readiness probe', () => {
  it('uses the secure credential file without returning signing material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inflow-readiness-probe-'));
    roots.push(root);
    const credentialFile = join(root, 'coordinator.env');
    const secret = 's'.repeat(32);
    await writeFile(credentialFile, [
      'INFLOW_COMPANY_ID=company-1',
      'INFLOW_API_KEY=api-key',
      'INFLOW_COORDINATOR_HMAC_CURRENT_KID=current',
      `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${secret}`,
      'INFLOW_COORDINATOR_AUDIENCE=zapier-private-app',
      'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://example.com/ready',
      'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://example.com/terminal',
    ].join('\n'));
    await chmod(credentialFile, 0o600);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const releaseOid = 'a'.repeat(40);
    const materialSha256 = 'b'.repeat(64);
    const result = await probeManufacturingReadiness({
      credentialFile,
      expectedReleaseOid: releaseOid,
      expectedMaterialSha256: materialSha256,
      now: () => new Date('2026-08-12T10:00:00.000Z'),
      nonce: 'nonce-1',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).includes('/healthz?probe=')) {
          return new Response(JSON.stringify({
            status: 'ok', nonce: 'nonce-1', releaseOid, materialSha256,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ readiness: { ready: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      identity: { status: 'ok', nonce: 'nonce-1', releaseOid, materialSha256 },
      readiness: { readiness: { ready: true } },
    });
    const headers = calls[1].init.headers as Record<string, string>;
    const material = manufacturingRunCanonicalMaterial({
      version: MANUFACTURING_RUN_AUTH_VERSION,
      method: 'POST',
      pathAndQuery: '/v1/manufacturing-runs/ready',
      audience: 'zapier-private-app',
      companyId: 'company-1',
      timestamp: String(Math.floor(new Date('2026-08-12T10:00:00.000Z').getTime() / 1_000)),
      nonce: 'nonce-1',
      kid: 'current',
      rawBody: Buffer.from('{}'),
    });
    expect(headers['x-inflow-signature']).toBe(
      createHmac('sha256', secret).update(material).digest('hex')
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('fails closed before signed readiness when measured runtime identity differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inflow-readiness-identity-'));
    roots.push(root);
    const credentialFile = join(root, 'coordinator.env');
    await writeFile(credentialFile, [
      'INFLOW_COMPANY_ID=company-1',
      'INFLOW_API_KEY=api-key',
      'INFLOW_COORDINATOR_HMAC_CURRENT_KID=current',
      `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${'s'.repeat(32)}`,
      'INFLOW_COORDINATOR_AUDIENCE=zapier-private-app',
      'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://example.com/ready',
      'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://example.com/terminal',
    ].join('\n'));
    await chmod(credentialFile, 0o600);
    let calls = 0;
    await expect(probeManufacturingReadiness({
      credentialFile,
      expectedReleaseOid: 'a'.repeat(40),
      expectedMaterialSha256: 'b'.repeat(64),
      nonce: 'nonce-1',
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({
          nonce: 'nonce-1', releaseOid: 'c'.repeat(40), materialSha256: 'b'.repeat(64),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    })).rejects.toThrow('RUNTIME_IDENTITY_MISMATCH');
    expect(calls).toBe(1);
  });
});
