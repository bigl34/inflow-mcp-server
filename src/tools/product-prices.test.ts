import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { Product } from '../types/inflow.js';
import { registerProductPriceTools } from './product-prices.js';

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-price-tool-'));
  await chmod(stateDir, 0o700);
  let current: Product = {
    productId: 'product-1',
    name: 'Product',
    sku: 'SKU-1',
    isActive: false,
    timestamp: 'ts-1',
    prices: [{
      productPriceId: 'price-1',
      productId: 'product-1',
      pricingSchemeId: 'scheme-1',
      unitPrice: '10',
      fixedMarkup: null,
      priceType: 'Fixed',
      timestamp: 'price-ts-1',
    }],
  };
  const put = vi.fn(async (_path: string, body: Partial<Product>) => {
    current = { ...current, ...structuredClone(body), timestamp: 'ts-2' };
    return structuredClone(current);
  });
  const client = {
    get: vi.fn(async () => structuredClone(current)),
    prepareMutation: vi.fn(async (_method: string, path: string, options: { body: Partial<Product> }) => ({
      dispatch: () => put(path, options.body),
    })),
  } as unknown as InflowClient;
  const config: InflowConfig = {
    companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
    rateLimitPerMinute: 60, requestTimeoutMs: 1_000, maxRetries: 0, retryDelayMs: 1,
    readRetryBudgetMs: 1_000, debug: false, stateDir,
    adapterManifestHash: 'a'.repeat(64), probeBuild: 'b'.repeat(64),
    safeWritesEnabled: true, stockWritesEnabled: false, enableLegacyWrites: false,
    writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
  };
  let handler: (args: any) => Promise<any> = async () => undefined;
  const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
    if (name === 'set_product_prices') handler = callback;
  } } as unknown as McpServer;
  registerProductPriceTools(server, client, config);
  return { config, handler, put };
}

function applyInput(preview: Record<string, any>) {
  return {
    productId: 'product-1',
    mode: 'patch',
    prices: [{ productPriceId: 'price-1', pricingSchemeId: 'scheme-1', unitPrice: '12', priceType: 'Fixed' }],
    dryRun: false,
    previewToken: preview.previewToken,
    expectedSemanticHash: preview.currentSemanticHash,
    expectedWriteShapeHash: preview.currentWriteShapeHash,
    expectedEntityTimestamp: preview.entityTimestamp,
    expectedDesiredHash: preview.desiredHash,
  };
}

describe('safe product-price writes', () => {
  it('applies a deterministic replacement without a per-domain attestation or idempotency key', async () => {
    const fixture = await harness();
    const preview = payload(await fixture.handler({
      productId: 'product-1', mode: 'patch',
      prices: [{ productPriceId: 'price-1', pricingSchemeId: 'scheme-1', unitPrice: '12', priceType: 'Fixed' }],
      dryRun: true,
    }));
    expect(preview.idempotencyKey).toBeUndefined();

    const applied = payload(await fixture.handler(applyInput(preview)));
    expect(applied).toMatchObject({ applicationState: 'applied_verified', applied: true, verified: true });
    expect(fixture.put).toHaveBeenCalledTimes(1);
  });

  it('rejects an existing preview after the master gate closes', async () => {
    const fixture = await harness();
    const preview = payload(await fixture.handler({
      productId: 'product-1', mode: 'patch',
      prices: [{ productPriceId: 'price-1', pricingSchemeId: 'scheme-1', unitPrice: '12', priceType: 'Fixed' }],
      dryRun: true,
    }));
    fixture.config.safeWritesEnabled = false;

    await expect(fixture.handler(applyInput(preview))).rejects.toThrow(/SAFE_WRITES_DISABLED/);
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('requires idempotency only when a patch adds a new price row', async () => {
    const fixture = await harness();
    const preview = payload(await fixture.handler({
      productId: 'product-1', mode: 'patch',
      prices: [{ pricingSchemeId: 'scheme-2', unitPrice: '20', priceType: 'Fixed' }],
      dryRun: true,
    }));

    expect(preview.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
