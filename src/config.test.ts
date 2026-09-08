import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.INFLOW_ADAPTER_MANIFEST_HASH;
  delete process.env.INFLOW_PROBE_BUILD;
  delete process.env.INFLOW_ENABLE_SAFE_WRITES;
  delete process.env.INFLOW_ENABLE_STOCK_WRITES;
  delete process.env.INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('loadConfig manufacturing defaults', () => {
  it('defaults to API 2026-04-13 with manufacturing writes disabled', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    delete process.env.INFLOW_API_VERSION;
    delete process.env.INFLOW_ENABLE_MANUFACTURING_WRITES;
    delete process.env.INFLOW_ADAPTER_MANIFEST_HASH;
    delete process.env.INFLOW_PROBE_BUILD;
    const config = loadConfig();
    expect(config.apiVersion).toBe('2026-04-13');
    expect(config.enableManufacturingWrites).toBe(false);
    expect(config.safeWritesEnabled).toBe(false);
    expect(config.stockWritesEnabled).toBe(false);
    expect(config.adapterManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(config.probeBuild).toMatch(/^[a-f0-9]{64}$/);
  });

  it('opens the master and stock gates only for the exact true value', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    process.env.INFLOW_ENABLE_SAFE_WRITES = 'true';
    process.env.INFLOW_ENABLE_STOCK_WRITES = 'TRUE';
    let config = loadConfig();
    expect(config.safeWritesEnabled).toBe(true);
    expect(config.stockWritesEnabled).toBe(false);

    process.env.INFLOW_ENABLE_STOCK_WRITES = 'true';
    config = loadConfig();
    expect(config.safeWritesEnabled).toBe(true);
    expect(config.stockWritesEnabled).toBe(true);
  });

  it('retains old domain variables as diagnostics without opening safe gates', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    process.env.INFLOW_ENABLE_PRICE_WRITES = 'true';
    process.env.INFLOW_ENABLE_PRODUCT_GROUP_WRITES = 'true';
    process.env.INFLOW_ENABLE_MO_SERIAL_WRITES = 'true';
    process.env.INFLOW_ENABLE_STANDARD_WRITES = 'true';
    const config = loadConfig();
    expect(config.safeWritesEnabled).toBe(false);
    expect(config.stockWritesEnabled).toBe(false);
    expect(config.writeGates).toMatchObject({
      prices: true,
      'product-groups': true,
      'mo-serials': true,
      standard: true,
    });
  });

  it('retains the API rollback override and explicit write gate', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    process.env.INFLOW_API_VERSION = '2025-06-24';
    process.env.INFLOW_ENABLE_MANUFACTURING_WRITES = 'true';
    const config = loadConfig();
    expect(config.apiVersion).toBe('2025-06-24');
    expect(config.enableManufacturingWrites).toBe(true);
  });

  it('keeps the manufacturing pick-batch coordinator gate distinct and closed by default', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    delete process.env.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES;
    expect(loadConfig().writeGates['manufacturing-pick-batch-v1']).toBe(false);

    process.env.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES = 'true';
    expect(loadConfig().writeGates['manufacturing-pick-batch-v1']).toBe(true);
  });

  it('keeps automatic operation completion behind its own default-off gate', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    expect(
      loadConfig().writeGates['manufacturing-operation-completion-v1']
    ).toBe(false);

    process.env.INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES =
      'true';
    expect(
      loadConfig().writeGates['manufacturing-operation-completion-v1']
    ).toBe(true);
  });

  it('rejects stale deployment assertions instead of trusting them', () => {
    process.env.INFLOW_COMPANY_ID = 'company';
    process.env.INFLOW_API_KEY = 'key';
    process.env.INFLOW_PROBE_BUILD = 'stale-build';
    expect(() => loadConfig()).toThrow('INFLOW_PROBE_BUILD_MISMATCH');
  });
});
