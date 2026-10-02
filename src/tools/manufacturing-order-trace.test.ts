import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { createTempStateDir } from '../core/temp-state.fixtures.js';
import type { ManufacturingOrder } from '../types/inflow.js';
import { registerManufacturingOrderTraceTools } from './manufacturing-order-trace.js';

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

async function harness() {
  const stateDir = await createTempStateDir('inflow-mo-serial-tool-');
  const order: ManufacturingOrder = {
    manufacturingOrderId: 'mo-1',
    manufacturingOrderNumber: 'MO-1',
    status: 'Open',
    timestamp: 'ts-1',
    lines: [{
      manufacturingOrderLineId: 'line-1',
      productId: 'product-1',
      quantity: { standardQuantity: '1', serialNumbers: ['SERIAL-OLD'] },
      timestamp: 'line-ts-1',
    }],
    pickLines: [],
    pickMatchings: [],
    putLines: [],
  };
  let current: Record<string, any> = structuredClone(order);
  const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
    correlationId: 'correlation-serials',
    dispatch: async () => {
      current = { ...current, ...options.body, timestamp: 'ts-2' };
      return current;
    },
  }));
  const client = {
    get: vi.fn(async () => structuredClone(current)),
    prepareMutation,
  } as unknown as InflowClient;
  const config: InflowConfig = {
    companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
    rateLimitPerMinute: 60, requestTimeoutMs: 1_000, maxRetries: 0, retryDelayMs: 1,
    readRetryBudgetMs: 1_000, debug: false, stateDir,
    adapterManifestHash: 'a'.repeat(64), probeBuild: 'b'.repeat(64),
    safeWritesEnabled: true, stockWritesEnabled: true, enableLegacyWrites: false,
    writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
  };
  let handler: (args: any) => Promise<any> = async () => undefined;
  const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
    if (name === 'reconcile_manufacturing_order_serials') handler = callback;
  } } as unknown as McpServer;
  registerManufacturingOrderTraceTools(server, client, config);
  return { handler, prepareMutation };
}

describe('manufacturing-order serial reconciliation', () => {
  it('binds an idempotency key and applies through a prepared PUT once gates are open', async () => {
    const fixture = await harness();
    const request = {
      manufacturingOrderId: 'mo-1',
      mode: 'patch',
      outputLines: [{ manufacturingOrderLineId: 'line-1', serialNumbers: ['SERIAL-NEW'] }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));
    expect(preview.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    await fixture.handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    });
    expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
    expect(fixture.prepareMutation.mock.calls[0][0]).toBe('PUT');
    expect(fixture.prepareMutation.mock.calls[0][1]).toBe('/manufacturing-orders');
  });
});
