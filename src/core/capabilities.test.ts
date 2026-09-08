import { describe, expect, it } from 'vitest';
import { assertCapability, parseApiVersion, resolveCapabilities } from './capabilities.js';

describe('capability matrix', () => {
  it('validates real ISO dates', () => {
    expect(parseApiVersion('2026-04-13')).toBeGreaterThan(0);
    expect(() => parseApiVersion('2026-02-30')).toThrow(/INVALID_API_VERSION/);
  });

  it('reports and rejects unavailable additions on rollback', () => {
    expect(resolveCapabilities('2025-01-01').every((row) => !row.available)).toBe(true);
    expect(() => assertCapability('operation-types.read', '2025-01-01')).toThrow(/UNSUPPORTED_API_VERSION/);
    expect(() => assertCapability('operation-types.read', '2026-04-13')).not.toThrow();
  });
});
