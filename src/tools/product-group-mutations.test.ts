import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InflowApiError, type InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { Product, ProductGroup } from '../types/inflow.js';
import { registerProductGroupMutationTools } from './product-group-mutations.js';

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-group-write-'));
  await chmod(stateDir, 0o700);
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
    handlers[name] = handler;
  } } as unknown as McpServer;
  const state = {
    group: {
      productGroupId: 'g-1', name: 'Group', isActive: true, timestamp: 't-1',
      options: [{ productGroupOptionId: 'o-1', name: 'Colour', lineNum: 0, optionValues: [
        { productGroupOptionValueId: 'v-1', value: 'Red', lineNum: 0 },
        { productGroupOptionValueId: 'v-2', value: 'Galaxy', lineNum: 1 },
        { productGroupOptionValueId: 'v-3', value: 'Blue Camouflage', lineNum: 2 },
      ] }],
      productVariants: [{ productVariantId: 'g-1_existing', productGroupId: 'g-1', productId: 'existing', variantOption: { 'o-1': 'v-1' } }],
    } as ProductGroup,
    products: new Map<string, Product>([['existing', { productId: 'existing', name: 'Red product', sku: 'SKU-RED', isActive: true }]]),
    onCreate: undefined as (() => void) | undefined,
    failGroupResponse: false,
  };
  let revision = 1;
  const get = vi.fn(async (path: string) => {
    if (path === '/product-groups/g-1') {
      const group = structuredClone(state.group);
      group.productVariants = group.productVariants?.map((row) => ({ ...row, product: structuredClone(state.products.get(row.productId!)) }));
      return group;
    }
    const product = state.products.get(path.replace('/products/', ''));
    if (!product) throw new InflowApiError('not found', 404);
    return structuredClone(product);
  });
  const dispatched: Array<{ path: string; body: any }> = [];
  const prepareMutation = vi.fn(async (_method: string, path: string, options: { body: any }) => {
    const body = structuredClone(options.body);
    return { dispatch: async () => {
      dispatched.push({ path, body });
      if (path === '/products') {
        const prior = state.products.get(body.productId);
        state.products.set(body.productId, { ...prior, ...body, timestamp: `p-${revision++}` });
        if (!prior) state.onCreate?.();
        return;
      }
      if (path !== '/product-groups') throw new Error(`unexpected write ${path}`);
      if (body.timestamp !== state.group.timestamp) throw new InflowApiError('stale group', 409);
      state.group = { ...body, timestamp: `t-${++revision}` };
      if (state.failGroupResponse) throw new Error('lost group response');
    } };
  });
  const client = { get, prepareMutation } as unknown as InflowClient;
  const config: InflowConfig = {
    companyId: 'company', apiKey: 'test-only', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
    rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
    readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: 'a'.repeat(64), probeBuild: 'b'.repeat(64),
    enableLegacyWrites: false, writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    safeWritesEnabled: true, stockWritesEnabled: false,
  };
  registerProductGroupMutationTools(server, client, config);
  async function call(tool: string, input: any) {
    const response = await handlers[tool](input);
    return JSON.parse(response.content[0].text);
  }
  return { state, config, dispatched, call };
}

function applyInput(input: any, preview: any) {
  return { ...input, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
    expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
    expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash };
}

const variantInput = {
  productGroupId: 'g-1',
  variants: [
    { name: 'Galaxy product', sku: 'SKU-GALAXY', isActive: true, selection: [{ productGroupOptionId: 'o-1', productGroupOptionValueId: 'v-2' }] },
    { name: 'Blue Camouflage product', sku: 'SKU-CAMO', isActive: true, selection: [{ productGroupOptionId: 'o-1', productGroupOptionValueId: 'v-3' }] },
  ],
};

describe('product-group writes', () => {
  it('preserves existing values and variants when patching in a new colour', async () => {
    const f = await fixture();
    const baseline = structuredClone(f.state.group);
    const input = { productGroupId: 'g-1', mode: 'patch', options: [{ productGroupOptionId: 'o-1', name: 'Colour', optionValues: [{ name: 'Gold' }] }] };
    const preview = await f.call('set_product_group_config', { ...input, dryRun: true });
    expect(preview.desired.options[0].optionValues).toHaveLength(4);
    expect(preview.desired.options[0].optionValues[3]).toMatchObject({ value: 'Gold', lineNum: 3 });
    const result = await f.call('set_product_group_config', applyInput(input, preview));
    expect(result.applicationState).toBe('applied_verified');
    expect(f.state.group.productVariants).toEqual(baseline.productVariants);
    expect(f.state.group.options![0].optionValues!.slice(0, 3)).toEqual(baseline.options![0].optionValues);
    expect(f.dispatched[0].body.options[0].optionValues[3]).not.toHaveProperty('name');
    const replay = await f.call('set_product_group_config', applyInput(input, preview));
    expect(replay.applicationState).toBe('applied_verified');
    expect(f.dispatched).toHaveLength(1);
  });

  it('creates two stocked products, preserves the existing member and replays without new writes', async () => {
    const f = await fixture();
    const preview = await f.call('create_product_group_variants', { ...variantInput, dryRun: true });
    for (const row of preview.desired.plannedProducts) {
      expect(row.productVariantId).toBe(`g-1_${row.productId}`);
    }
    expect(f.dispatched).toHaveLength(0);
    const result = await f.call('create_product_group_variants', applyInput(variantInput, preview));
    expect(result.applicationState).toBe('applied_verified');
    expect(f.state.group.productVariants).toHaveLength(3);
    expect(f.state.products.get('existing')!.sku).toBe('SKU-RED');
    expect(f.dispatched.filter((row) => row.path === '/products')).toHaveLength(2);
    expect(f.dispatched.filter((row) => row.path === '/products').every((row) => row.body.itemType === 'StockedProduct')).toBe(true);
    const replay = await f.call('create_product_group_variants', applyInput(variantInput, preview));
    expect(replay.applicationState).toBe('applied_verified');
    expect(f.dispatched).toHaveLength(3);
  });

  it('preserves a concurrent group edit and deactivates unattached products', async () => {
    const f = await fixture();
    const preview = await f.call('create_product_group_variants', { ...variantInput, dryRun: true });
    f.state.onCreate = () => { f.state.group.name = 'Concurrent edit'; f.state.group.timestamp = 't-concurrent'; };
    const result = await f.call('create_product_group_variants', applyInput(variantInput, preview));
    expect(result.applicationState).not.toBe('applied_verified');
    expect(f.state.group.name).toBe('Concurrent edit');
    expect(f.state.group.productVariants).toHaveLength(1);
    expect(f.dispatched.filter((row) => row.path === '/product-groups')).toHaveLength(0);
    expect([...f.state.products.values()].filter((row) => row.productId !== 'existing').every((row) => row.isActive === false)).toBe(true);
  });

  it('refuses verified success when the immutable product type differs', async () => {
    const f = await fixture();
    const preview = await f.call('create_product_group_variants', { ...variantInput, dryRun: true });
    f.state.onCreate = () => {
      for (const product of f.state.products.values()) {
        if (product.productId !== 'existing') product.itemType = 'Service';
      }
    };
    const result = await f.call('create_product_group_variants', applyInput(variantInput, preview));
    expect(result.applicationState).toBe('partial_applied');
    expect(result.verified).toBe(false);
    expect(f.dispatched).toHaveLength(3);
  });

  it('reconciles a lost successful attachment response without deactivating attached products', async () => {
    const f = await fixture();
    const preview = await f.call('create_product_group_variants', { ...variantInput, dryRun: true });
    f.state.failGroupResponse = true;
    const result = await f.call('create_product_group_variants', applyInput(variantInput, preview));
    expect(result.applicationState).toBe('applied_verified');
    expect([...f.state.products.values()].every((row) => row.isActive)).toBe(true);
    expect(f.dispatched).toHaveLength(3);
  });

  it('keeps the master write gate and duplicate-selection checks', async () => {
    const f = await fixture();
    const preview = await f.call('create_product_group_variants', { ...variantInput, dryRun: true });
    f.config.safeWritesEnabled = false;
    await expect(f.call('create_product_group_variants', applyInput(variantInput, preview))).rejects.toThrow('SAFE_WRITES_DISABLED');
    expect(f.dispatched).toHaveLength(0);
    await expect(f.call('create_product_group_variants', { ...variantInput, variants: [variantInput.variants[0], { ...variantInput.variants[0], sku: 'Different' }], dryRun: true })).rejects.toThrow('DUPLICATE_VARIANT_COMBINATION');
  });
});
