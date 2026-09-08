import { describe, expect, it, vi } from 'vitest';

const entrypointModule = await import('./coordinator-http.js')
  .catch(() => ({})) as Record<string, any>;

describe('coordinator HTTP binary lifecycle', () => {
  it('gates background worker ticks on full readiness', async () => {
    expect(entrypointModule.runCoordinatorWorkerTick).toBeTypeOf('function');
    const runOne = vi.fn(async () => ({ outcome: 'idle' }));
    const deliverWebhook = vi.fn(async () => 'idle');
    await expect(entrypointModule.runCoordinatorWorkerTick({
      readiness: async () => ({ ready: false }),
      runOne,
      deliverWebhook,
    })).resolves.toBe('skipped_not_ready');
    expect(runOne).not.toHaveBeenCalled();
    expect(deliverWebhook).not.toHaveBeenCalled();

    await expect(entrypointModule.runCoordinatorWorkerTick({
      readiness: async () => ({ ready: true }),
      runOne,
      deliverWebhook,
    })).resolves.toBe('ran');
    expect(runOne).toHaveBeenCalledOnce();
    expect(deliverWebhook).toHaveBeenCalledOnce();
  });

  it('exports a separately startable HTTP entrypoint without importing MCP tools', () => {
    expect(entrypointModule.startManufacturingRunHttp).toBeTypeOf('function');
  });

  it('reports only bounded non-secret worker failure codes', () => {
    expect(entrypointModule.manufacturingWorkerFailureCode(
      Object.assign(new Error('WORKER_LEASE_HELD'), { code: 'SQLITE_BUSY' })
    )).toBe('SQLITE_BUSY');
    expect(entrypointModule.manufacturingWorkerFailureCode(
      new Error('WORKER_LEASE_HELD')
    )).toBe('WORKER_LEASE_HELD');
    expect(entrypointModule.manufacturingWorkerFailureCode(
      new Error('request failed with secret-bearing provider body')
    )).toBe('Error');
    expect(entrypointModule.manufacturingWorkerFailureCode('raw secret')).toBe('UNKNOWN');
  });
});
