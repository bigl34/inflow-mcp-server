import { describe, expect, it } from 'vitest';
import {
  ADAPTER_PRODUCTION_ROOTS,
  computeBuildIdentities,
  verifyBuildIdentityOverride,
} from './build-identity.js';

describe('build identities', () => {
  it('derives stable SHA-256 identities from the running production artifacts', () => {
    const first = computeBuildIdentities();
    const second = computeBuildIdentities();
    expect(first).toEqual(second);
    expect(first.adapterManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.probeBuild).toMatch(/^[a-f0-9]{64}$/);
  });

  it('covers the coordinator HTTP and runtime execution paths', () => {
    expect(ADAPTER_PRODUCTION_ROOTS).toEqual(expect.arrayContaining([
      'http',
      'runtime',
    ]));
  });

  it('rejects an environment identity that does not match the running build', () => {
    expect(() => verifyBuildIdentityOverride('INFLOW_PROBE_BUILD', 'old-build', 'running-build'))
      .toThrow('INFLOW_PROBE_BUILD_MISMATCH');
    expect(verifyBuildIdentityOverride('INFLOW_PROBE_BUILD', 'running-build', 'running-build')).toBe('running-build');
  });
});

