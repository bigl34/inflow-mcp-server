#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  manufacturingRunCanonicalMaterial,
  MANUFACTURING_RUN_AUTH_VERSION,
} from '../http/manufacturing-run-auth.js';
import { readSecureCredentialEnvironment } from './credential-env.js';

export const DEFAULT_COORDINATOR_ORIGIN = 'http://127.0.0.1:8788';

export async function probeManufacturingReadiness({
  credentialFile,
  origin = DEFAULT_COORDINATOR_ORIGIN,
  expectedReleaseOid,
  expectedMaterialSha256,
  fetchImpl = fetch,
  now = () => new Date(),
  nonce = randomUUID(),
}: {
  credentialFile: string;
  origin?: string;
  expectedReleaseOid?: string;
  expectedMaterialSha256?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: string;
}): Promise<{ ok: boolean; status: number; identity: unknown; readiness: unknown }> {
  if (!/^[0-9a-f]{40}$/.test(expectedReleaseOid ?? '')
    || !/^[0-9a-f]{64}$/.test(expectedMaterialSha256 ?? '')) {
    throw new Error('EXPECTED_RUNTIME_IDENTITY_INVALID');
  }
  const credentials = readSecureCredentialEnvironment(credentialFile);
  const path = '/v1/manufacturing-runs/ready';
  const identityResponse = await fetchImpl(`${origin}/healthz?probe=${encodeURIComponent(nonce)}`, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    signal: AbortSignal.timeout(5_000),
  });
  const identity = await identityResponse.json() as Record<string, unknown>;
  if (!identityResponse.ok || identity.nonce !== nonce || identity.releaseOid !== expectedReleaseOid
    || identity.materialSha256 !== expectedMaterialSha256) {
    throw new Error('RUNTIME_IDENTITY_MISMATCH');
  }
  const body = Buffer.from('{}');
  const timestamp = String(Math.floor(now().getTime() / 1_000));
  const kid = credentials.INFLOW_COORDINATOR_HMAC_CURRENT_KID;
  const audience = credentials.INFLOW_COORDINATOR_AUDIENCE ?? 'zapier-private-app';
  const companyId = credentials.INFLOW_COMPANY_ID;
  const material = manufacturingRunCanonicalMaterial({
    version: MANUFACTURING_RUN_AUTH_VERSION,
    method: 'POST',
    pathAndQuery: path,
    audience,
    companyId,
    timestamp,
    nonce,
    kid,
    rawBody: body,
  });
  const response = await fetchImpl(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-inflow-auth-version': MANUFACTURING_RUN_AUTH_VERSION,
      'x-inflow-key-id': kid,
      'x-inflow-timestamp': timestamp,
      'x-inflow-nonce': nonce,
      'x-inflow-audience': audience,
      'x-inflow-company-id': companyId,
      'x-inflow-signature': createHmac(
        'sha256',
        credentials.INFLOW_COORDINATOR_HMAC_CURRENT_SECRET
      ).update(material).digest('hex'),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  const readiness = await response.json();
  return { ok: response.ok, status: response.status, identity, readiness };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const credentialIndex = args.indexOf('--credential-file');
  const originIndex = args.indexOf('--origin');
  const releaseIndex = args.indexOf('--expected-release-oid');
  const materialIndex = args.indexOf('--expected-material-sha256');
  if (credentialIndex < 0 || !args[credentialIndex + 1]
    || releaseIndex < 0 || materialIndex < 0
    || args.some((arg, index) => arg.startsWith('--')
      && ![credentialIndex, originIndex, releaseIndex, materialIndex].includes(index))) {
    throw new Error('usage: manufacturing-readiness-probe --credential-file ABS --expected-release-oid OID --expected-material-sha256 SHA256 [--origin URL]');
  }
  const result = await probeManufacturingReadiness({
    credentialFile: args[credentialIndex + 1],
    expectedReleaseOid: args[releaseIndex + 1],
    expectedMaterialSha256: args[materialIndex + 1],
    ...(originIndex >= 0 ? { origin: args[originIndex + 1] } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch((error: unknown) => {
    const code = error instanceof Error && /^[A-Z0-9_:-]{1,100}$/.test(error.message)
      ? error.message
      : 'READINESS_PROBE_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  });
}
