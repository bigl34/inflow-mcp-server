import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const credentialModule = await import('./credential-env.js')
  .catch(() => ({})) as Record<string, unknown>;

describe('coordinator credential environment parsing', () => {
  it('parses only literal allowlisted assignments without shell evaluation', () => {
    expect(credentialModule.parseCredentialEnvironment).toBeTypeOf('function');
    const parse = credentialModule.parseCredentialEnvironment as (
      source: string
    ) => Record<string, string>;

    expect(parse([
      '# coordinator credentials',
      'INFLOW_COMPANY_ID=company-1',
      'INFLOW_API_KEY=$(echo should-not-run)',
      `INFLOW_COORDINATOR_HMAC_CURRENT_KID=current`,
      `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${'s'.repeat(32)}`,
      'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://hooks.zapier.invalid/run-ready',
      'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://hooks.zapier.invalid/terminal',
      'INFLOW_ENABLE_SAFE_WRITES=false',
      'INFLOW_ENABLE_STOCK_WRITES=false',
      '',
    ].join('\n'))).toEqual({
      INFLOW_COMPANY_ID: 'company-1',
      INFLOW_API_KEY: '$(echo should-not-run)',
      INFLOW_COORDINATOR_HMAC_CURRENT_KID: 'current',
      INFLOW_COORDINATOR_HMAC_CURRENT_SECRET: 's'.repeat(32),
      INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL:
        'https://hooks.zapier.invalid/run-ready',
      INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL:
        'https://hooks.zapier.invalid/terminal',
      INFLOW_ENABLE_SAFE_WRITES: 'false',
      INFLOW_ENABLE_STOCK_WRITES: 'false',
    });
  });

  it.each([
    [
      'INFLOW_API_KEY=secret-value\nINFLOW_API_KEY=secret-value',
      /DUPLICATE_KEY/,
    ],
    ['UNAPPROVED_SECRET=secret-value', /KEY_NOT_ALLOWED/],
    ['INFLOW_ADAPTER_MANIFEST_HASH=stale-build', /KEY_NOT_ALLOWED/],
    ['INFLOW_PROBE_BUILD=stale-build', /KEY_NOT_ALLOWED/],
    ['export INFLOW_API_KEY=secret-value', /MALFORMED_LINE/],
    ['INFLOW_API_KEY=', /VALUE_INVALID/],
  ])('rejects duplicate, unapproved, or malformed input without leaking values', (
    source,
    code
  ) => {
    const parse = credentialModule.parseCredentialEnvironment as (
      input: string
    ) => Record<string, string>;
    let failure: unknown;
    try {
      parse(source);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(code);
    expect((failure as Error).message).not.toContain('secret-value');
  });

  it('validates required coordinator credentials without defaulting a write gate open', () => {
    expect(credentialModule.validateCoordinatorCredentialEnvironment)
      .toBeTypeOf('function');
    expect(credentialModule.installCoordinatorCredentialEnvironment)
      .toBeTypeOf('function');
    const validate =
      credentialModule.validateCoordinatorCredentialEnvironment as (
        values: Record<string, string>
      ) => void;
    const install =
      credentialModule.installCoordinatorCredentialEnvironment as (
        values: Record<string, string>,
        target: Record<string, string | undefined>
      ) => void;
    const values = {
      INFLOW_COMPANY_ID: 'company-1',
      INFLOW_API_KEY: 'provider-secret',
      INFLOW_COORDINATOR_HMAC_CURRENT_KID: 'current',
      INFLOW_COORDINATOR_HMAC_CURRENT_SECRET: 'h'.repeat(32),
      INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL:
        'https://hooks.zapier.invalid/run-ready',
      INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL:
        'https://hooks.zapier.invalid/terminal',
    };

    expect(() => validate(values)).not.toThrow();
    expect(() => validate({
      ...values,
      INFLOW_COORDINATOR_HMAC_CURRENT_SECRET: 'secret-value',
    })).toThrow(/HMAC_CURRENT_SECRET_INVALID/);
    expect(() => validate({
      ...values,
      INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES: 'yes',
    })).toThrow(/WRITE_GATE_INVALID/);
    expect(() => validate({
      ...values,
      INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES: 'yes',
    })).toThrow(/WRITE_GATE_INVALID/);
    expect(() => validate({
      ...values,
      INFLOW_ENABLE_SAFE_WRITES: '1',
    })).toThrow(/WRITE_GATE_INVALID/);
    expect(() => validate({
      ...values,
      INFLOW_ENABLE_STOCK_WRITES: 'TRUE',
    })).toThrow(/WRITE_GATE_INVALID/);
    expect(() => validate({
      ...values,
      INFLOW_ENABLE_SAFE_WRITES: 'true',
      INFLOW_ENABLE_STOCK_WRITES: 'false',
      INFLOW_ENABLE_PRICE_WRITES: 'false',
    })).not.toThrow();
    expect(() => validate({
      ...values,
      INFLOW_API_KEY: '',
    })).toThrow(/INFLOW_API_KEY_REQUIRED/);

    const target: Record<string, string | undefined> = {
      INFLOW_ADAPTER_MANIFEST_HASH: 'stale-adapter-build',
      INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES: 'true',
      INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES: 'true',
      INFLOW_ENABLE_STANDARD_WRITES: 'true',
      INFLOW_ENABLE_SAFE_WRITES: 'true',
      INFLOW_ENABLE_STOCK_WRITES: 'true',
      INFLOW_PROBE_BUILD: 'stale-probe-build',
      INFLOW_API_KEY: 'stale-secret',
      PATH: '/usr/bin',
    };
    install(values, target);
    expect(target).toMatchObject({
      PATH: '/usr/bin',
      INFLOW_API_KEY: 'provider-secret',
    });
    expect(target.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES)
      .toBeUndefined();
    expect(target.INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES)
      .toBeUndefined();
    expect(target.INFLOW_ENABLE_STANDARD_WRITES).toBeUndefined();
    expect(target.INFLOW_ENABLE_SAFE_WRITES).toBeUndefined();
    expect(target.INFLOW_ENABLE_STOCK_WRITES).toBeUndefined();
    expect(target.INFLOW_ADAPTER_MANIFEST_HASH).toBeUndefined();
    expect(target.INFLOW_PROBE_BUILD).toBeUndefined();
  });
});

function credentialContents(): string {
  return [
    'INFLOW_COMPANY_ID=company-1',
    'INFLOW_API_KEY=provider-secret',
    'INFLOW_COORDINATOR_HMAC_CURRENT_KID=current',
    `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${'h'.repeat(32)}`,
    'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://hooks.zapier.invalid/run-ready',
    'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://hooks.zapier.invalid/terminal',
  ].join('\n');
}

describe('coordinator credential file safety', () => {
  it('reads only an absolute, current-user-owned regular file with exact 0600 mode', () => {
    expect(credentialModule.readSecureCredentialEnvironment)
      .toBeTypeOf('function');
    const readSecure = credentialModule.readSecureCredentialEnvironment as (
      path: string
    ) => Record<string, string>;
    const directory = mkdtempSync('/tmp/inflow-credentials-');
    const file = join(directory, 'coordinator.env');
    try {
      writeFileSync(file, credentialContents(), { mode: 0o600 });
      expect(readSecure(file).INFLOW_COMPANY_ID).toBe('company-1');

      chmodSync(file, 0o640);
      expect(() => readSecure(file)).toThrow(/MODE_INVALID/);
      chmodSync(file, 0o600);

      const link = join(directory, 'coordinator-link.env');
      symlinkSync(file, link);
      expect(() => readSecure(link)).toThrow(/FILE_(OPEN|NOT_REGULAR)/);

      const hardlink = join(directory, 'coordinator-hardlink.env');
      linkSync(file, hardlink);
      expect(() => readSecure(file)).toThrow(/LINK_COUNT_INVALID/);
      expect(() => readSecure(hardlink)).toThrow(/LINK_COUNT_INVALID/);
      expect(() => readSecure('coordinator.env')).toThrow(/ABSOLUTE_REQUIRED/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a regular file owned by another uid when uid checks are available', () => {
    expect(credentialModule.validateCredentialFileMetadata)
      .toBeTypeOf('function');
    const validate = credentialModule.validateCredentialFileMetadata as (
      metadata: { isFile(): boolean; mode: number; nlink: number; uid: number },
      currentUid: number | undefined
    ) => void;

    expect(() => validate({
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      uid: 2000,
    }, 1000)).toThrow(/OWNER_INVALID/);
    expect(() => validate({
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      uid: 2000,
    }, undefined)).not.toThrow();
  });
});
