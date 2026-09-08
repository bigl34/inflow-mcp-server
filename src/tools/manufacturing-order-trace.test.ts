import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { ManufacturingOrder } from '../types/inflow.js';
import { registerManufacturingOrderTraceTools } from './manufacturing-order-trace.js';

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mo-serial-tool-'));
  await chmod(stateDir, 0o700);
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
  const prepareMutation = vi.fn();
  const client = {
    get: vi.fn(async () => structuredClone(order)),
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
  it('binds an idempotency key but remains statically unsupported until its release canary passes', async () => {
    const fixture = await harness();
    const request = {
      manufacturingOrderId: 'mo-1',
      mode: 'patch',
      outputLines: [{ manufacturingOrderLineId: 'line-1', serialNumbers: ['SERIAL-NEW'] }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));
    expect(preview.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    await expect(fixture.handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/OPERATION_UNSUPPORTED/);
    expect(fixture.prepareMutation).not.toHaveBeenCalled();
  });
});
