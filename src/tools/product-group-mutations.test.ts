import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { registerProductGroupMutationTools } from './product-group-mutations.js';

describe('product-group variant saga preview', () => {
  it('uses planned variant IDs as new rows instead of existing-row selectors', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-group-preview-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'create_product_group_variants') handler = callback;
    } } as unknown as McpServer;
    const prepareMutation = vi.fn();
    const client = { get: vi.fn(async () => ({
      productGroupId: 'g-1', name: 'Group', timestamp: 't-1',
      options: [{ productGroupOptionId: 'o-1', name: 'Colour', optionValues: [{ productGroupOptionValueId: 'v-1', name: 'Red' }] }],
      productVariants: [],
    })), prepareMutation } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: 'a'.repeat(64), probeBuild: 'b'.repeat(64),
      enableLegacyWrites: false, writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
      safeWritesEnabled: true, stockWritesEnabled: false,
    };
    registerProductGroupMutationTools(server, client, config);
    const response = await handler({
      productGroupId: 'g-1',
      variants: [{ name: 'Red product', sku: 'SKU-RED', isActive: false, selection: [{ productGroupOptionId: 'o-1', productGroupOptionValueId: 'v-1' }] }],
      dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.applicationState).toBe('preview');
    expect(preview.idempotencyKey).toBeTruthy();
    expect(preview.desired.plannedProducts[0].productVariantId).toBe(preview.desired.productVariants[0].productVariantId);

    await expect(handler({
      productGroupId: 'g-1',
      variants: [{ name: 'Red product', sku: 'SKU-RED', isActive: false, selection: [{ productGroupOptionId: 'o-1', productGroupOptionValueId: 'v-1' }] }],
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/OPERATION_UNSUPPORTED/);
    expect(prepareMutation).not.toHaveBeenCalled();
  });
});
