import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from './client/inflow.js';
import type { InflowConfig } from './config.js';
import { LEGACY_WRITE_REPLACEMENTS, registerAllTools } from './registry.js';

interface CapturedTool {
  description?: string;
  callback?: (...args: any[]) => unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function testConfig(): InflowConfig {
  return {
    companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
    rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1, readRetryBudgetMs: 1000, debug: false,
    stateDir: '/tmp/inflow-registry-test', adapterManifestHash: 'test', probeBuild: 'test', enableLegacyWrites: false,
    safeWritesEnabled: false, stockWritesEnabled: false,
    writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
  };
}

describe('generated tool manifest', () => {
  it('registers every new surface and every stable safe write name exactly once', () => {
    const names: string[] = [];
    const server = { tool(name: string) { names.push(name); } } as unknown as McpServer;
    registerAllTools(server, {} as InflowClient, testConfig());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'list_operation_types', 'get_operation_type', 'get_mcp_status', 'get_mutation_status',
      'copy_product_manufacturing_config', 'audit_product_group_manufacturing', 'calculate_bom_requirements',
      'get_manufacturing_order_trace', 'reconcile_manufacturing_order_serials',
      'get_product_prices', 'set_product_prices', 'set_product_group_config', 'create_product_group_variants',
      'set_product', 'set_sales_order', 'set_purchase_order', 'set_purchase_order_receipts',
      'set_customer', 'set_vendor', 'set_stock_adjustment', 'set_stock_transfer', 'set_stock_count',
      'set_manufacturing_order', 'set_taxing_scheme', 'set_webhook', 'remove_webhook',
    ]));
  });

  it('keeps every legacy write callable with a prominent warning and structured bypass telemetry', async () => {
    const tools = new Map<string, CapturedTool>();
    const server = {
      tool(name: string, ...args: any[]) {
        tools.set(name, {
          description: args.find((arg) => typeof arg === 'string'),
          callback: typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined,
        });
        return {};
      },
    } as unknown as McpServer;
    const client = {
      put: vi.fn().mockResolvedValue({ productId: 'product-1', name: 'Telemetry Product' }),
    } as unknown as InflowClient;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = testConfig();

    registerAllTools(server, client, config);

    for (const [legacyTool, replacement] of Object.entries(LEGACY_WRITE_REPLACEMENTS)) {
      const registered = tools.get(legacyTool);
      expect(registered?.description).toContain('HIGH RISK: BYPASSES INFLOW_ENABLE_SAFE_WRITES');
      expect(registered?.description).toContain(`Use ${replacement} instead`);
      expect(registered?.callback).toBeTypeOf('function');
    }

    await tools.get('upsert_product')!.callback!({ name: 'Telemetry Product' });
    expect(stderr).toHaveBeenCalledTimes(1);
    const event = JSON.parse(String(stderr.mock.calls[0]![0]));
    expect(event).toEqual(expect.objectContaining({
      level: 'warn',
      severity: 'high',
      event: 'inflow_legacy_immediate_write_invoked',
      deprecated: true,
      tool: 'upsert_product',
      safeReplacement: 'set_product',
      bypassesSafeWriteGate: true,
      bypassedGate: 'INFLOW_ENABLE_SAFE_WRITES',
      gateEffect: 'not_enforced',
    }));
    expect(event).not.toHaveProperty('arguments');

    stderr.mockClear();
    config.apiVersion = '2026-01-01';
    await expect(Promise.resolve().then(() => tools.get('set_product_prices')!.callback!({
      productId: 'product-1',
      mode: 'patch',
      dryRun: true,
    }))).rejects.toThrow('UNSUPPORTED_API_VERSION');
    expect(stderr).not.toHaveBeenCalled();
    expect(tools.get('set_product_prices')?.description).not.toContain('BYPASSES INFLOW_ENABLE_SAFE_WRITES');
  });
});
