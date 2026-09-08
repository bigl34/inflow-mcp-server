import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const launchModule = await import('./manufacturing-run-launch.js')
  .catch(() => ({})) as Record<string, unknown>;

function secureCredentialFile(): { directory: string; path: string } {
  const directory = mkdtempSync('/tmp/inflow-launch-');
  const path = join(directory, 'coordinator.env');
  writeFileSync(path, [
    'INFLOW_COMPANY_ID=company-1',
    'INFLOW_API_KEY=provider-secret',
    'INFLOW_COORDINATOR_HMAC_CURRENT_KID=current',
    `INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=${'h'.repeat(32)}`,
    'INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://hooks.zapier.invalid/run-ready',
    'INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://hooks.zapier.invalid/terminal',
  ].join('\n'), { mode: 0o600 });
  return { directory, path };
}

describe('manufacturing run live launcher', () => {
  it('reports only stable error codes and never echoes an arbitrary secret-bearing error', () => {
    expect(launchModule.runtimeFailureCode).toBeTypeOf('function');
    const errorCode = launchModule.runtimeFailureCode as (
      error: unknown
    ) => string;
    expect(errorCode(new Error('provider-secret was rejected')))
      .toBe('COORDINATOR_LAUNCH_FAILED');
    expect(errorCode({ code: 'CREDENTIAL_FILE_MODE_INVALID' }))
      .toBe('CREDENTIAL_FILE_MODE_INVALID');
  });

  it('validates a secure credential file without importing or starting the coordinator', async () => {
    expect(launchModule.launchManufacturingRun).toBeTypeOf('function');
    const launch = launchModule.launchManufacturingRun as (
      argv: string[],
      dependencies: Record<string, unknown>
    ) => Promise<{ mode: string }>;
    const file = secureCredentialFile();
    const importCoordinator = vi.fn(async () => ({
      startManufacturingRunHttp: vi.fn(),
    }));
    const environment: Record<string, string | undefined> = {
      INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES: 'true',
    };
    try {
      await expect(launch([
        '--credential-file',
        file.path,
        '--validate-only',
      ], {
        importCoordinator,
        environment,
      })).resolves.toEqual({
        mode: 'validated',
        credentialFile: file.path,
      });
      expect(importCoordinator).not.toHaveBeenCalled();
      expect(environment.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES)
        .toBe('true');
      expect(environment.INFLOW_API_KEY).toBeUndefined();
    } finally {
      rmSync(file.directory, { recursive: true, force: true });
    }
  });

  it('starts the existing lifecycle with only file credentials and closes once on SIGTERM', async () => {
    const launch = launchModule.launchManufacturingRun as (
      argv: string[],
      dependencies: Record<string, unknown>
    ) => Promise<{ mode: string; close(): Promise<void> }>;
    const file = secureCredentialFile();
    const closeRuntime = vi.fn(async () => undefined);
    const startManufacturingRunHttp = vi.fn(async () => ({
      server: { address: () => ({ address: '127.0.0.1', port: 8787 }) },
      close: closeRuntime,
    }));
    const importCoordinator = vi.fn(async () => ({
      startManufacturingRunHttp,
    }));
    const signals = new EventEmitter();
    const environment: Record<string, string | undefined> = {
      INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES: 'true',
      INFLOW_ENABLE_STANDARD_WRITES: 'true',
      INFLOW_API_KEY: 'stale-secret',
      PATH: '/usr/bin',
    };
    try {
      const runtime = await launch([
        '--credential-file',
        file.path,
      ], {
        importCoordinator,
        environment,
        signals,
      });

      expect(runtime.mode).toBe('live');
      expect(importCoordinator).toHaveBeenCalledOnce();
      expect(startManufacturingRunHttp).toHaveBeenCalledOnce();
      expect(environment.INFLOW_API_KEY).toBe('provider-secret');
      expect(environment.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES)
        .toBeUndefined();
      expect(environment.INFLOW_ENABLE_STANDARD_WRITES).toBeUndefined();

      signals.emit('SIGTERM');
      await vi.waitFor(() => expect(closeRuntime).toHaveBeenCalledOnce());
      await runtime.close();
      expect(closeRuntime).toHaveBeenCalledOnce();
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally {
      rmSync(file.directory, { recursive: true, force: true });
    }
  });
});
