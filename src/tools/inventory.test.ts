import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import { createTempStateDir } from '../core/temp-state.fixtures.js';
import { customFieldDefinitionsList } from './custom-field-kinds.fixtures.js';
import { registerInventoryTools } from './inventory.js';

function capture(): { handlers: Record<string, (args: any) => Promise<any>>; server: McpServer } {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { handlers, server };
}

describe('upsert_stock_adjustment', () => {
  it('sends API-shaped lines with quantity objects instead of flat items', async () => {
    const { handlers, server } = capture();
    const put = vi.fn(async (_path: string, body: unknown) => body);
    const client = { put, get: vi.fn(), getList: vi.fn() } as unknown as InflowClient;
    registerInventoryTools(server, client);

    await handlers.upsert_stock_adjustment({
      id: 'adj-1',
      adjustmentDate: '2026-09-17T12:00:00.000Z',
      locationId: 'loc-1',
      reasonId: 'reason-1',
      items: [
        { id: 'line-1', productId: 'prod-1', quantity: 2 },
        { productId: 'prod-2', quantity: -1, serialNumbers: ['S1'] },
      ],
      remarks: 'note',
    });

    expect(put).toHaveBeenCalledTimes(1);
    const [path, body] = put.mock.calls[0] as [string, any];
    expect(path).toBe('/stock-adjustments');
    expect(body.items).toBeUndefined();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toEqual({
      stockAdjustmentLineId: 'line-1',
      productId: 'prod-1',
      quantity: { standardQuantity: '2', uomQuantity: '2', uom: '', serialNumbers: [] },
    });
    expect(body.lines[1].stockAdjustmentLineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.lines[1].quantity).toEqual({ standardQuantity: '-1', uomQuantity: '-1', uom: '', serialNumbers: ['S1'] });
  });
});

describe('standard write semantic readback', () => {
  it('ignores advanced nested row timestamps when verifying readback', async () => {
    const { registerSafeStandardWriteTools } = await import('./safe-standard-writes.js');
    const stateDir = await createTempStateDir('inflow-nested-timestamp-');
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = { tool(name: string, _d: string, _s: unknown, handler: (args: any) => Promise<any>) { handlers[name] = handler; } } as unknown as McpServer;
    let current: Record<string, any> = {
      stockAdjustmentId: 'adj-1', locationId: 'loc-1', adjustmentReasonId: 'reason-1', remarks: '', isCancelled: false, timestamp: 'h-1',
      lines: [{ stockAdjustmentLineId: 'line-1', productId: 'p-1', quantity: { standardQuantity: '2', uomQuantity: '2', uom: '', serialNumbers: [] }, timestamp: 'l-1' }],
    };
    const prepareMutation = vi.fn(async (_m: string, _p: string, options: { body: Record<string, any> }) => ({
      correlationId: 'c-1',
      dispatch: async () => {
        current = { ...current, ...options.body, timestamp: 'h-2', lines: options.body.lines.map((line: any) => ({ ...line, timestamp: 'l-2' })) };
        return current;
      },
    }));
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => structuredClone(current)), prepareMutation } as unknown as InflowClient;
    const config = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1, readRetryBudgetMs: 1000, debug: false, stateDir,
      adapterManifestHash: '', probeBuild: '', enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: true,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    } as any;
    registerSafeStandardWriteTools(server, client, config);
    const request = { stockAdjustmentId: 'adj-1', mode: 'patch', values: { remarks: 'probe' } };
    const preview = JSON.parse((await handlers.set_stock_adjustment({ ...request, dryRun: true })).content[0].text);
    const applied = JSON.parse((await handlers.set_stock_adjustment({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.applicationState).toBe('applied_verified');
  });
});

describe('standard write create readback', () => {
  it('verifies a create against the requested fields with decimal-tolerant comparison', async () => {
    const { registerSafeStandardWriteTools } = await import('./safe-standard-writes.js');
    const stateDir = await createTempStateDir('inflow-create-readback-');
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = { tool(name: string, _d: string, _s: unknown, handler: (args: any) => Promise<any>) { handlers[name] = handler; } } as unknown as McpServer;
    let stored: Record<string, any> | undefined;
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const prepareMutation = vi.fn(async (_m: string, _p: string, options: { body: Record<string, any> }) => ({
      correlationId: 'c-1',
      dispatch: async () => {
        stored = {
          ...options.body, transferNumber: 'ST-000009', transferDate: '2026-09-18T12:00:00+00:00', status: 'open', timestamp: 'h-1',
          lines: options.body.lines.map((line: any) => ({ ...line, description: '', fromSublocation: '', toSublocation: '', lotId: null, timestamp: 'l-1', quantity: { ...line.quantity, standardQuantity: '1.0000', uomQuantity: '1.0000' } })),
        };
        return stored;
      },
    }));
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => { if (!stored) throw notFound; return structuredClone(stored); }), prepareMutation } as unknown as InflowClient;
    const config = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1, readRetryBudgetMs: 1000, debug: false, stateDir,
      adapterManifestHash: '', probeBuild: '', enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: true,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    } as any;
    registerSafeStandardWriteTools(server, client, config);
    const request = { mode: 'replace', values: {
      fromLocationId: 'loc-1', toLocationId: 'loc-2', remarks: 'probe',
      lines: [{ productId: 'p-1', quantity: { standardQuantity: '1', uomQuantity: '1', uom: '', serialNumbers: [] } }],
    } };
    const preview = JSON.parse((await handlers.set_stock_transfer({ ...request, dryRun: true })).content[0].text);
    const applied = JSON.parse((await handlers.set_stock_transfer({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.applicationState).toBe('applied_verified');
  });
});
