import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InflowConfig } from '../config.js';

import {
  launchManufacturingCanary,
  manufacturingCanaryFailureCode,
  parseManufacturingCanaryLaunchArguments,
  readSecureJsonMaterial,
  runManufacturingCanaryMain,
  type ManufacturingCanaryRuntimeModule,
} from './manufacturing-canary-launch.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function secureFile(name: string, body: string): { root: string; path: string } {
  const root = mkdtempSync('/tmp/inflow-manufacturing-canary-launch-');
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, body, { mode: 0o600 });
  return { root, path };
}

function credentialFile(): { root: string; path: string } {
  return secureFile('coordinator.env', [
    'INFLOW_COMPANY_ID=company-1',
    'INFLOW_API_KEY=provider-secret',
    'INFLOW_COORDINATOR_HMAC_CURRENT_KID=current',
    `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${'h'.repeat(32)}`,
    'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://hooks.zapier.invalid/run-ready',
    'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://hooks.zapier.invalid/terminal',
    'INFLOW_ENABLE_SAFE_WRITES=true',
    'INFLOW_ENABLE_STOCK_WRITES=true',
    'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES=true',
    'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES=true',
    'INFLOW_ENABLE_MANUFACTURING_WRITES=true',
    'INFLOW_ENABLE_PRICE_WRITES=true',
    'INFLOW_ENABLE_PRODUCT_GROUP_WRITES=true',
    'INFLOW_ENABLE_MO_SERIAL_WRITES=true',
    'INFLOW_ENABLE_STANDARD_WRITES=true',
    'INFLOW_ENABLE_LEGACY_WRITES=true',
  ].join('\n'));
}

function config() {
  return {
    companyId: 'company-1',
    apiKey: 'provider-secret',
    baseUrl: 'https://CloudApi.InflowInventory.com/',
    apiVersion: '2026-04-13',
    rateLimitPerMinute: 60,
    requestTimeoutMs: 30_000,
    maxRetries: 0,
    retryDelayMs: 1_000,
    readRetryBudgetMs: 30_000,
    debug: false,
    enableManufacturingWrites: false,
    stateDir: '/tmp/inflow-state',
    adapterManifestHash: 'adapter-sha',
    probeBuild: 'probe-sha',
    enableLegacyWrites: false,
    safeWritesEnabled: false,
    stockWritesEnabled: false,
    writeGates: {
      manufacturing: false,
      prices: false,
      'product-groups': false,
      'mo-serials': false,
      standard: false,
      'manufacturing-pick-batch-v1': false,
      'manufacturing-operation-completion-v1': false,
    },
  };
}

function pickArgs(files: {
  credential: string;
  scenario: string;
  approvals: string;
  runtimeMaterial: string;
}): string[] {
  return [
    '--mode', 'pick-batch',
    '--credential-file', files.credential,
    '--scenario', files.scenario,
    '--approvals', files.approvals,
    '--runtime-material', files.runtimeMaterial,
  ];
}

function operationCompletionArgs(files: {
  credential: string;
  fixture: string;
}): string[] {
  return [
    '--mode', 'operation-completion',
    '--credential-file', files.credential,
    '--resource-id', 'mo-canary-1',
    '--fixture', files.fixture,
    '--approval-nonce', 'approved-operation-completion-1',
  ];
}

function pickRuntime(overrides: Partial<ManufacturingCanaryRuntimeModule> = {}): ManufacturingCanaryRuntimeModule {
  return {
    loadConfig: vi.fn(() => config()),
    createInflowClient: vi.fn(() => ({ kind: 'client' })),
    tenantFingerprint: vi.fn(() => 'tenant-fingerprint'),
    runPickBatch: vi.fn(async () => ({
      status: 'approval-required',
      checkpoint: { state: 'stock-baselined', checkpointHash: 'checkpoint-hash' },
      stage: 'stock-move',
      stagePlan: { secretMaterial: 'must-not-escape' },
      message: 'provider-secret must-not-escape',
      attestationIssued: false,
      secretMaterial: 'must-not-escape',
    })),
    runFixture: vi.fn(async () => ({
      schemaVersion: 'manufacturing-pick-batch-fixture-command-result/v1',
      command: 'plan',
      stage: 'planned',
      manifestHash: 'manifest-hash',
    })),
    runOperationCompletion: vi.fn(async () => ({
      resourceId: 'operation-completion-resource',
      cleanupSucceeded: true,
      attestationIssued: true,
      passed: true,
      errors: [],
    })),
    ...overrides,
  };
}

describe('manufacturing canary launcher arguments', () => {
  it('strictly accepts only the complete mode-specific surfaces', () => {
    expect(parseManufacturingCanaryLaunchArguments([
      '--mode', 'fixture',
      '--credential-file', '/secure/credentials.env',
      '--command', 'seed-stock',
      '--manifest', '/secure/manifest.json',
      '--approval', '/secure/approval.json',
      '--state-dir', '/secure/state',
      '--owner-id', 'operator-1',
    ])).toMatchObject({ mode: 'fixture', command: 'seed-stock' });

    expect(() => parseManufacturingCanaryLaunchArguments([
      '--mode', 'unknown', '--credential-file', '/secure/credentials.env',
    ])).toThrow('CANARY_LAUNCH_MODE_INVALID');
    expect(() => parseManufacturingCanaryLaunchArguments([
      '--mode', 'pick-batch', '--credential-file', '/secure/credentials.env',
      '--scenario', '/secure/scenario.json', '--approvals', '/secure/approvals.json',
      '--runtime-material', '/secure/runtime.json', '--command', 'plan',
    ])).toThrow('CANARY_LAUNCH_ARGUMENT_UNKNOWN');
    expect(() => parseManufacturingCanaryLaunchArguments([
      '--mode', 'pick-batch', '--mode', 'pick-batch',
      '--credential-file', '/secure/credentials.env',
    ])).toThrow('CANARY_LAUNCH_ARGUMENT_DUPLICATE');
  });
});

describe('secure canary material handling', () => {
  it('rejects relative, non-owner-only, and oversized JSON material', async () => {
    const credential = credentialFile();
    const scenario = secureFile('scenario.json', '{}');
    const approvals = secureFile('approvals.json', '{}');
    const runtimeMaterial = secureFile('runtime.json', '{}');
    const runtime = pickRuntime();
    const base = {
      credential: credential.path,
      scenario: scenario.path,
      approvals: approvals.path,
      runtimeMaterial: runtimeMaterial.path,
    };

    await expect(launchManufacturingCanary(pickArgs({ ...base, scenario: 'scenario.json' }), {
      importRuntime: async () => runtime,
    })).rejects.toMatchObject({ code: 'CANARY_MATERIAL_ABSOLUTE_REQUIRED' });

    chmodSync(approvals.path, 0o640);
    await expect(launchManufacturingCanary(pickArgs(base), {
      importRuntime: async () => runtime,
    })).rejects.toMatchObject({ code: 'CANARY_MATERIAL_MODE_INVALID' });
    chmodSync(approvals.path, 0o600);

    writeFileSync(runtimeMaterial.path, JSON.stringify({ data: 'x'.repeat(256 * 1024) }), { mode: 0o600 });
    await expect(launchManufacturingCanary(pickArgs(base), {
      importRuntime: async () => runtime,
    })).rejects.toMatchObject({ code: 'CANARY_MATERIAL_TOO_LARGE' });
    expect(runtime.runPickBatch).not.toHaveBeenCalled();
  });
});

describe('credentialed pick-batch launch', () => {
  it('installs credentials before runtime import/config and maps JSON without leaking material', async () => {
    const credential = credentialFile();
    const scenario = secureFile('scenario.json', JSON.stringify({ scenario: 'safe' }));
    const approvals = secureFile('approvals.json', JSON.stringify({ approvals: ['safe'] }));
    const runtimeMaterial = secureFile('runtime.json', JSON.stringify({ stockMove: { intents: {} } }));
    const environment: Record<string, string | undefined> = {
      INFLOW_API_KEY: 'stale-secret',
      INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES: 'true',
      INFLOW_ADAPTER_MANIFEST_HASH: 'deployed-adapter-sha',
      INFLOW_PROBE_BUILD: 'deployed-probe-sha',
      PATH: '/usr/bin',
    };
    const order: string[] = [];
    const runtime = pickRuntime({
      loadConfig: vi.fn(() => {
        order.push('config');
        expect(environment.INFLOW_API_KEY).toBe('provider-secret');
        expect(environment.INFLOW_ADAPTER_MANIFEST_HASH).toBeUndefined();
        expect(environment.INFLOW_PROBE_BUILD).toBeUndefined();
        for (const name of [
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
        ]) {
          expect(environment[name]).toBe('false');
        }
        expect(environment.INFLOW_RATE_LIMIT).toBe('20');
        expect(environment.INFLOW_MAX_RETRIES).toBe('0');
        return config();
      }),
      runPickBatch: vi.fn(async (env, dependencies) => {
        order.push('runner');
        expect(dependencies.loadConfig()).toEqual(config());
        expect(env.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_SCENARIO_JSON)
          .toBe(JSON.stringify({ scenario: 'safe' }));
        expect(env.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_APPROVALS_JSON)
          .toBe(JSON.stringify({ approvals: ['safe'] }));
        expect(env.INFLOW_MANUFACTURING_PICK_BATCH_CANARY_RUNTIME_MATERIAL_JSON)
          .toBe(JSON.stringify({ stockMove: { intents: {} } }));
        return {
          status: 'approval-required',
          checkpoint: { state: 'stock-baselined', checkpointHash: 'checkpoint-hash' },
          stage: 'stock-move',
          stagePlan: { body: 'provider-secret' },
          message: 'provider-secret',
          attestationIssued: false,
        };
      }),
    });

    const result = await launchManufacturingCanary(pickArgs({
      credential: credential.path,
      scenario: scenario.path,
      approvals: approvals.path,
      runtimeMaterial: runtimeMaterial.path,
    }), {
      environment,
      importRuntime: async () => {
        order.push('import');
        expect(environment.INFLOW_API_KEY).toBe('provider-secret');
        return runtime;
      },
    });

    expect(order).toEqual(['import', 'config', 'runner']);
    expect(environment.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES).toBe('false');
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(result).toEqual({
      schemaVersion: 'manufacturing-canary-launch-result/v1',
      mode: 'pick-batch',
      status: 'approval-required',
      checkpointState: 'stock-baselined',
      checkpointHash: 'checkpoint-hash',
      stage: 'stock-move',
      attestationIssued: false,
    });
  });

  it('refuses to run while any safe, stock, or coordinator production gate is open', async () => {
    const credential = credentialFile();
    const scenario = secureFile('scenario.json', '{}');
    const approvals = secureFile('approvals.json', '{}');
    const runtimeMaterial = secureFile('runtime.json', '{}');
    const openConfigs: InflowConfig[] = [
      { ...config(), safeWritesEnabled: true },
      { ...config(), stockWritesEnabled: true },
      {
        ...config(),
        writeGates: { ...config().writeGates, 'manufacturing-pick-batch-v1': true },
      },
    ];
    for (const openConfig of openConfigs) {
      const runtime = pickRuntime({ loadConfig: vi.fn(() => openConfig) });
      await expect(launchManufacturingCanary(pickArgs({
        credential: credential.path,
        scenario: scenario.path,
        approvals: approvals.path,
        runtimeMaterial: runtimeMaterial.path,
      }), { importRuntime: async () => runtime })).rejects.toMatchObject({
        code: 'CANARY_WRITE_GATE_MUST_BE_CLOSED',
      });
      expect(runtime.runPickBatch).not.toHaveBeenCalled();
    }
  });
});

describe('credentialed fixture launch', () => {
  it('builds the client and maps the non-secret runtime identity and fixture arguments', async () => {
    const credential = credentialFile();
    const manifest = secureFile('manifest.json', '{}');
    const approval = secureFile('approval.json', '{}');
    const client = { kind: 'inflow-client' };
    const runFixture = vi.fn(async () => ({
      schemaVersion: 'manufacturing-pick-batch-fixture-command-result/v1' as const,
      command: 'seed-stock' as const,
      stage: 'stock-seeded' as const,
      manifestHash: 'manifest-hash',
      nextApproval: { stage: 'handoff' as const, stagePlanHash: 'stage-plan-hash' },
      secret: 'provider-secret',
    }));
    const createInflowClient = vi.fn(() => client);
    const fingerprint = vi.fn(() => 'tenant-fingerprint');
    const runtime = pickRuntime({ runFixture, createInflowClient, tenantFingerprint: fingerprint });

    const result = await launchManufacturingCanary([
      '--mode', 'fixture',
      '--credential-file', credential.path,
      '--command', 'seed-stock',
      '--manifest', manifest.path,
      '--approval', approval.path,
      '--state-dir', '/tmp/fixture-state',
      '--owner-id', 'operator-1',
    ], { importRuntime: async () => runtime });

    expect(createInflowClient).toHaveBeenCalledWith(config());
    expect(fingerprint).toHaveBeenCalledWith(
      'company-1', 'provider-secret', 'cloudapi.inflowinventory.com',
    );
    expect(runFixture).toHaveBeenCalledWith({
      command: 'seed-stock',
      manifest: {},
      approval: {},
      client,
      stateDir: '/tmp/fixture-state',
      ownerId: 'operator-1',
      runtimeIdentity: {
        tenantFingerprint: 'tenant-fingerprint',
        baseHost: 'cloudapi.inflowinventory.com',
        apiVersion: '2026-04-13',
        probeBuild: 'probe-sha',
        adapterManifestHash: 'adapter-sha',
      },
    });
    expect(result).toEqual({
      schemaVersion: 'manufacturing-canary-launch-result/v1',
      mode: 'fixture',
      command: 'seed-stock',
      stage: 'stock-seeded',
      manifestHash: 'manifest-hash',
      nextApproval: { stage: 'handoff', stagePlanHash: 'stage-plan-hash' },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('executes the descriptor-validated fixture object even if the source path is swapped', async () => {
    const credential = credentialFile();
    const manifest = secureFile('manifest.json', JSON.stringify({ marker: 'validated' }));
    const replacement = secureFile('replacement.json', JSON.stringify({ marker: 'swapped' }));
    const runFixture = vi.fn(async (input) => {
      expect(input.manifest).toEqual({ marker: 'validated' });
      return {
        schemaVersion: 'manufacturing-pick-batch-fixture-command-result/v1' as const,
        command: 'plan' as const,
        stage: 'planned' as const,
        manifestHash: 'validated-manifest-hash',
      };
    });
    let materialReads = 0;

    const result = await launchManufacturingCanary([
      '--mode', 'fixture',
      '--credential-file', credential.path,
      '--command', 'plan',
      '--manifest', manifest.path,
      '--state-dir', '/tmp/fixture-state',
      '--owner-id', 'operator-1',
    ], {
      readJsonMaterial: (path) => {
        materialReads += 1;
        const validated = readSecureJsonMaterial(path);
        unlinkSync(path);
        symlinkSync(replacement.path, path);
        return validated;
      },
      importRuntime: async () => pickRuntime({ runFixture }),
    });

    expect(materialReads).toBe(1);
    expect(runFixture).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      mode: 'fixture',
      command: 'plan',
      manifestHash: 'validated-manifest-hash',
    });
  });
});

describe('credentialed operation-completion launch', () => {
  it('binds the approved resource and fixture to the closed-gate runtime', async () => {
    const credential = credentialFile();
    const fixture = secureFile(
      'operation-completion.json',
      JSON.stringify({
        schemaVersion: 'manufacturing-operation-completion-canary-fixture/v1',
        marker: 'safe',
      })
    );
    const client = { kind: 'inflow-client' };
    const runOperationCompletion = vi.fn(async () => ({
      resourceId: 'mo-canary-1',
      cleanupSucceeded: true,
      attestationIssued: true,
      passed: true,
      errors: [],
      secret: 'provider-secret',
    }));
    const runtime = pickRuntime({
      createInflowClient: vi.fn(() => client),
      runOperationCompletion,
    });

    const result = await launchManufacturingCanary(operationCompletionArgs({
      credential: credential.path,
      fixture: fixture.path,
    }), { importRuntime: async () => runtime });

    expect(runOperationCompletion).toHaveBeenCalledWith(
      'mo-canary-1',
      expect.objectContaining({
        client,
        config: config(),
        env: expect.objectContaining({
          INFLOW_CANARY_APPROVED: 'true',
          INFLOW_CANARY_RESOURCE_ID: 'mo-canary-1',
          INFLOW_CANARY_APPROVAL_NONCE:
            'approved-operation-completion-1',
          INFLOW_CANARY_OPERATION_COMPLETION_JSON: JSON.stringify({
            schemaVersion:
              'manufacturing-operation-completion-canary-fixture/v1',
            marker: 'safe',
          }),
        }),
      })
    );
    expect(result).toEqual({
      schemaVersion: 'manufacturing-canary-launch-result/v1',
      mode: 'operation-completion',
      resourceId: 'mo-canary-1',
      cleanupSucceeded: true,
      attestationIssued: true,
      passed: true,
      errorCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });
});

describe('sanitized command output', () => {
  it('emits only a stable fatal code and never the thrown error, secrets, or paths', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const exitCode = await runManufacturingCanaryMain([
      '--mode', 'pick-batch',
      '--credential-file', '/secure/credentials.env',
      '--scenario', '/secure/scenario.json',
      '--approvals', '/secure/approvals.json',
      '--runtime-material', '/secure/runtime.json',
    ], {
      readJsonMaterial: () => ({ raw: '{}', value: {} }),
      readCredentialEnvironment: () => {
        throw new Error('provider-secret /secret/path material-body');
      },
    }, { stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(`${JSON.stringify({
      event: 'manufacturing_canary_launch_fatal',
      code: 'MANUFACTURING_CANARY_LAUNCH_FAILED',
    })}\n`);
    expect(stderr.mock.calls.flat().join('')).not.toMatch(/provider-secret|secret\/path|material-body/);
    expect(manufacturingCanaryFailureCode({ code: 'CANARY_MATERIAL_MODE_INVALID' }))
      .toBe('CANARY_MATERIAL_MODE_INVALID');
  });
});
