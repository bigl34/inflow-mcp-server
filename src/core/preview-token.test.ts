import { describe, expect, it } from 'vitest';
import { PreviewTokenService, tenantFingerprint } from './preview-token.js';

describe('preview tokens', () => {
  it('binds and verifies mutation scope', () => {
    const service = new PreviewTokenService('secret', 'company');
    const payload = {
      schemaVersion: 'preview-token/v1' as const,
      operationId: 'op-1',
      operation: 'set_product',
      tenantFingerprint: tenantFingerprint('company', 'secret'),
      baseHost: 'cloudapi.inflowinventory.com',
      apiVersion: '2026-04-13',
      resourceType: 'product',
      resourceId: 'p-1',
      mode: 'patch',
      desiredHash: 'desired',
      adapterVersion: 'product/v1',
      serializerVersion: 'canonical/v1',
      contractVersion: 'mutation/v1',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const token = service.issue(payload);
    expect(service.verify(token, { resourceId: 'p-1' })).toEqual(payload);
    expect(() => service.verify(token, { resourceId: 'p-2' })).toThrow(/SCOPE_MISMATCH/);
    expect(() => service.verify(`${token}x`)).toThrow(/signature/);
  });
});
