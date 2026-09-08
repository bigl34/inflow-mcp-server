import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { canonicalHash } from '../core/canonical-json.js';
import { MutationJournal } from '../core/mutation-journal.js';
import { productObservedSemantic, registerSafeStandardWriteTools } from './safe-standard-writes.js';

describe('safe standard write previews', () => {
  it('keeps the observed-product numeric hash contract in sync with the backfill coordinator', () => {
    expect(canonicalHash(
      productObservedSemantic({ cost: 12.5, quantity: 2, timestamp: 'volatile' }),
      'source/product-observed/v1',
    )).toBe('3893d36e3b02479bf0ed30387baea7626c94faa87e2829e7c4a79857b7929c19');
  });

  it('canonicalizes realistic fractional provider numbers without dispatching', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-preview-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', cost: 12.5, timestamp: 't-1' })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({ productId: 'p-1', mode: 'patch', values: { cost: 13.75 }, dryRun: true });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.applicationState).toBe('preview');
    expect(preview.diff.operations).toContainEqual(expect.objectContaining({ path: '/cost', before: '12.5', after: '13.75' }));
    expect(client.get).toHaveBeenCalledWith('/products/p-1', undefined);
  });

  it('deep-merges product custom-field patches while preserving sibling and falsy values', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-custom-fields-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({
      productId: 'p-1', name: 'Product', timestamp: 't-1',
      customFields: { custom1: '', custom2: 'keep', custom3: 0, custom4: false, custom5: null },
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({
      productId: 'p-1', mode: 'patch',
      values: { customFields: { custom1: 'https://admin.shopify.com/store/example/products/1', custom5: null, custom6: '' } },
      dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.customFields).toEqual({
      custom1: 'https://admin.shopify.com/store/example/products/1',
      custom2: 'keep', custom3: 0, custom4: false, custom5: null, custom6: '',
    });
    expect(preview.diff.operations).toEqual([
      expect.objectContaining({ path: '/customFields/custom1', before: '', after: 'https://admin.shopify.com/store/example/products/1' }),
      expect.objectContaining({ op: 'add', path: '/customFields/custom6', after: '' }),
    ]);
  });

  it.each([null, [], 'not-an-object', 7])(
    'rejects non-object product custom-field patch containers: %j',
    async (customFields) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-invalid-custom-fields-'));
      await chmod(stateDir, 0o700);
      let handler: (args: any) => Promise<any> = async () => undefined;
      const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
        if (name === 'set_product') handler = callback;
      } } as unknown as McpServer;
      const client = { get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', timestamp: 't-1', customFields: {} })) } as unknown as InflowClient;
      const config: InflowConfig = {
        companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
        rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
        readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
        enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
        writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
      };
      registerSafeStandardWriteTools(server, client, config);
      await expect(handler({ productId: 'p-1', mode: 'patch', values: { customFields }, dryRun: true }))
        .rejects.toThrow('INVALID_CUSTOM_FIELDS');
    }
  );

  it('keeps whole-object custom-field semantics in replace mode', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-replace-custom-fields-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({
      productId: 'p-1', name: 'Before', timestamp: 't-1', customFields: { custom1: '', custom2: 'do-not-merge' },
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({
      productId: 'p-1', mode: 'replace', values: { name: 'After', customFields: { custom1: 'replacement' } }, dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.customFields).toEqual({ custom1: 'replacement' });
  });

  it.each([undefined, null])('patches product custom fields when the provider current value is %s', async (currentCustomFields) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-empty-custom-fields-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({
      productId: 'p-1', name: 'Product', timestamp: 't-1', customFields: currentCustomFields,
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({ productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'url' } }, dryRun: true });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.customFields).toEqual({ custom1: 'url' });
  });

  it('keeps the master gate authoritative after preview and before dispatch', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-gate-close-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = {
      get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', timestamp: 't-1', customFields: { custom1: '' } })),
      prepareMutation: vi.fn(),
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'url' } } };
    const previewResponse = await handler({ ...request, dryRun: true });
    const preview = JSON.parse(previewResponse.content[0].text);
    await expect(handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow('SAFE_WRITES_DISABLED');
    expect(client.prepareMutation).not.toHaveBeenCalled();
  });

  it('applies a merged product custom-field patch, verifies readback, and journals success', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-product-apply-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> = {
      productId: 'p-1', name: 'Product', sku: 'SKU', isActive: true, timestamp: 't-1',
      customFields: { custom1: '', custom2: 'keep', custom3: false },
    };
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-1',
      dispatch: async () => {
        current = { ...current, ...options.body, timestamp: 't-2' };
        return current;
      },
    }));
    const client = {
      get: vi.fn(async () => ({ ...current, customFields: { ...current.customFields } })),
      prepareMutation,
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'https://admin.shopify.com/store/example/products/1' } } };
    const preview = JSON.parse((await handler({ ...request, dryRun: true })).content[0].text);
    expect(preview.sourceHashes.productObserved).toMatch(/^[a-f0-9]{64}$/);
    const applied = JSON.parse((await handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: {
        productId: 'p-1',
        name: 'Product',
        timestamp: 't-1',
        customFields: { custom1: 'https://admin.shopify.com/store/example/products/1', custom2: 'keep', custom3: false },
      },
    });
    const journalRecord = await new MutationJournal(stateDir).get(preview.operationId);
    expect(journalRecord?.state).toBe('applied_verified');
  });

  it('sends a minimal SKU-only product patch while verifying the full desired state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-product-sku-apply-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> = {
      productId: 'p-1', name: 'Product', description: 'keep', sku: 'OLD-SKU', isActive: true,
      timestamp: 't-1', customFields: { custom1: 'keep' },
    };
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-sku-1',
      dispatch: async () => {
        current = { ...current, ...options.body, timestamp: 't-2' };
        return current;
      },
    }));
    const client = {
      get: vi.fn(async () => ({ ...current, customFields: { ...current.customFields } })),
      prepareMutation,
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const request = { productId: 'p-1', mode: 'patch', values: { sku: 'NEW-SKU' } };
    const preview = JSON.parse((await handler({ ...request, dryRun: true })).content[0].text);
    expect(preview.desired).toMatchObject({
      productId: 'p-1', name: 'Product', description: 'keep', sku: 'NEW-SKU', isActive: true,
      customFields: { custom1: 'keep' },
    });
    const applied = JSON.parse((await handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: 'p-1', name: 'Product', timestamp: 't-1', sku: 'NEW-SKU' },
    });
    expect(current).toMatchObject({
      productId: 'p-1', name: 'Product', description: 'keep', sku: 'NEW-SKU', isActive: true,
      customFields: { custom1: 'keep' }, timestamp: 't-2',
    });
    const journalRecord = await new MutationJournal(stateDir).get(preview.operationId);
    expect(journalRecord?.state).toBe('applied_verified');
  });

  it('keeps the complete desired product body for replace mode', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-product-replace-apply-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> = {
      productId: 'p-1', name: 'Before', description: 'remove', sku: 'OLD-SKU', timestamp: 't-1',
    };
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-replace-1',
      dispatch: async () => {
        current = { ...options.body, timestamp: 't-2' };
        return current;
      },
    }));
    const client = {
      get: vi.fn(async () => ({ ...current })),
      prepareMutation,
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const request = { productId: 'p-1', mode: 'replace', values: { name: 'After', sku: 'NEW-SKU' } };
    const preview = JSON.parse((await handler({ ...request, dryRun: true })).content[0].text);
    const applied = JSON.parse((await handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: 'p-1', name: 'After', sku: 'NEW-SKU', timestamp: 't-1' },
    });
  });

  it('rejects a stale product preview before preparing a dispatch', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-product-stale-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, unknown> = {
      productId: 'p-1', name: 'Product', timestamp: 't-1', customFields: { custom1: '', custom2: 'keep' },
      providerOnlyState: 'before',
    };
    const prepareMutation = vi.fn();
    const client = { get: vi.fn(async () => current), prepareMutation } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'url' } } };
    const preview = JSON.parse((await handler({ ...request, dryRun: true })).content[0].text);
    current = { ...current, providerOnlyState: 'after' };
    await expect(handler({
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow('PREVIEW_TOKEN_SCOPE_MISMATCH');
    expect(prepareMutation).not.toHaveBeenCalled();
  });

  it('rejects provider/read-only fields outside the product writable projection', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-projection-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', total: 50, timestamp: 't-1' })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    await expect(handler({ productId: 'p-1', mode: 'patch', values: { total: 99 }, dryRun: true }))
      .rejects.toThrow('UNSUPPORTED_WRITABLE_FIELDS: total');
  });

  it('validates required create fields before producing a preview token', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-create-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = {} as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    await expect(handler({ mode: 'replace', values: { sku: 'SKU-1' }, dryRun: true }))
      .rejects.toThrow('MISSING_REQUIRED_CREATE_FIELDS: name');
  });

  it('requires idempotency for ordinary creates but not deterministic replacements', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-idempotency-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { get: vi.fn(async (path: string) => path.endsWith('/existing')
      ? { productId: 'existing', name: 'Before', timestamp: 't-1' }
      : undefined) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const create = JSON.parse((await handlers.get('set_product')!({
      mode: 'replace', values: { name: 'Created' }, dryRun: true,
    })).content[0].text);
    const replacement = JSON.parse((await handlers.get('set_product')!({
      productId: 'existing', mode: 'replace', values: { name: 'After' }, dryRun: true,
    })).content[0].text);
    expect(create.idempotencyKey).toBeTruthy();
    expect(replacement.idempotencyKey).toBeUndefined();
  });

  it('accepts the canonical stock-adjustment and purchase-order compatibility projections', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-compat-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = {} as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    await expect(handlers.get('set_stock_adjustment')!({ mode: 'replace', values: {
      locationId: 'loc-1', adjustmentReasonId: 'reason-1', remarks: 'damage', items: [{ productId: 'p-1', quantity: -2 }],
    }, dryRun: true })).resolves.toBeDefined();
    const purchasePreview = await handlers.get('set_purchase_order')!({ mode: 'replace', values: {
      vendorId: 'vendor-1', orderRemarks: 'new order', lines: [{ productId: 'p-1', quantity: { standardQuantity: 3, uomQuantity: 3 }, unitPrice: 12.5 }],
    }, dryRun: true });
    const purchaseResult = JSON.parse(purchasePreview.content[0].text);
    expect(purchaseResult.desired.lines[0].purchaseOrderLineId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(handlers.get('set_stock_adjustment')!({ mode: 'replace', values: {
      locationId: 'loc-1', reasonId: 'reason-1', items: [],
    }, dryRun: true })).rejects.toThrow('UNSUPPORTED_WRITABLE_FIELDS: reasonId');
    await expect(handlers.get('set_purchase_order')!({ mode: 'replace', values: {
      vendorId: 'vendor-1', remarks: 'wrong alias',
    }, dryRun: true })).rejects.toThrow('UNSUPPORTED_WRITABLE_FIELDS: remarks');
  });

  it.each([
    'defaultPrice', 'prices', 'productGroupId', 'itemBoms',
    'manufacturingConfig', 'productOperations', 'autoAssemble',
    'includeQuantityBuildable', 'productVariant',
  ])(
    'rejects product field %s because a dedicated safe tool owns it',
    async (field) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'inflow-standard-product-owned-'));
      await chmod(stateDir, 0o700);
      let handler: (args: any) => Promise<any> = async () => undefined;
      const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
        if (name === 'set_product') handler = callback;
      } } as unknown as McpServer;
      const client = { get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', timestamp: 't-1' })) } as unknown as InflowClient;
      const config: InflowConfig = {
        companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
        rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
        readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
        enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: true,
        writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
      };
      registerSafeStandardWriteTools(server, client, config);
      await expect(handler({ productId: 'p-1', mode: 'patch', values: { [field]: [] }, dryRun: true }))
        .rejects.toThrow('OPERATION_UNSUPPORTED: generic product writes cannot change fields owned by dedicated price, group, or BOM tools');
    }
  );

  it('plans exact additive PO receipt rows with stable generated receive-line IDs', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-safe-receive-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({
      purchaseOrderId: 'po-1', vendorId: 'v-1', timestamp: 'po-t-1',
      receiveLines: [{ purchaseOrderReceiveLineId: 'rl-existing', productId: 'p-1', quantity: { standardQuantity: '1.0000', uomQuantity: '1.0000' }, receiveDate: '2026-08-01', timestamp: 'rl-t-1' }],
      unstockLines: [{ id: 'unstock-1', timestamp: 'us-t-1' }],
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handlers.get('set_purchase_order_receipts')!({
      purchaseOrderId: 'po-1', action: 'receive',
      receiveLines: [{ productId: 'p-2', quantity: { standardQuantity: '2.0000', uomQuantity: '2.0000' } }],
      dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.idempotencyKey).toBeTruthy();
    expect(preview.desired.receiveLines).toHaveLength(2);
    expect(preview.desired.receiveLines).toContainEqual(expect.objectContaining({
      purchaseOrderReceiveLineId: 'rl-existing', productId: 'p-1', receiveDate: '2026-08-01',
    }));
    const added = preview.desired.receiveLines.find((row: Record<string, unknown>) => row.productId === 'p-2');
    expect(added.purchaseOrderReceiveLineId).toMatch(/^[a-f0-9-]{36}$/);
    expect(preview.desired.unstockLines).toEqual([{ id: 'unstock-1' }]);
  });

  it('removes only exact PO receive-line IDs and preserves the full remaining replacement', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-safe-unreceive-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const current = {
      purchaseOrderId: 'po-1', vendorId: 'v-1', timestamp: 'po-t-1',
      receiveLines: [
        { purchaseOrderReceiveLineId: 'rl-1', productId: 'p-1', quantity: { standardQuantity: '1', uomQuantity: '1' } },
        { purchaseOrderReceiveLineId: 'rl-2', productId: 'p-2', quantity: { standardQuantity: '2', uomQuantity: '2' } },
      ],
      unstockLines: [{ id: 'unstock-1' }],
    };
    const client = { get: vi.fn(async () => current) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handlers.get('set_purchase_order_receipts')!({
      purchaseOrderId: 'po-1', action: 'unreceive',
      receiveLines: [{ purchaseOrderReceiveLineId: 'rl-1' }], dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.receiveLines).toEqual([
      expect.objectContaining({ purchaseOrderReceiveLineId: 'rl-2', productId: 'p-2' }),
    ]);
    expect(preview.desired.unstockLines).toEqual([{ id: 'unstock-1' }]);
  });

  it('fails closed for broad, line-derived, LIFO, or mixed receipt selectors', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-safe-receipt-unsupported-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { get: vi.fn(async () => ({
      purchaseOrderId: 'po-1', timestamp: 'po-t-1', receiveLines: [
        { purchaseOrderReceiveLineId: 'rl-1', productId: 'p-1', quantity: { standardQuantity: '1', uomQuantity: '1' } },
      ], unstockLines: [],
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const handler = handlers.get('set_purchase_order_receipts')!;
    await expect(handler({ purchaseOrderId: 'po-1', action: 'receive', receiveLines: [{ productId: 'p-1', quantity: { standardQuantity: '1', uomQuantity: '1' } }], receiveAll: true, dryRun: true }))
      .rejects.toThrow('OPERATION_UNSUPPORTED: receiveAll');
    await expect(handler({ purchaseOrderId: 'po-1', action: 'receive', receiveLines: [{ purchaseOrderLineId: 'pol-1', quantity: { standardQuantity: '1', uomQuantity: '1' } }], dryRun: true }))
      .rejects.toThrow('must use exact productId+quantity fields');
    await expect(handler({ purchaseOrderId: 'po-1', action: 'unreceive', receiveLines: [{ productId: 'p-1', quantity: 1 }], dryRun: true }))
      .rejects.toThrow('must use exact purchaseOrderReceiveLineId fields');
    await expect(handler({ purchaseOrderId: 'po-1', action: 'unreceive', receiveLines: [{ purchaseOrderReceiveLineId: 'missing' }], dryRun: true }))
      .rejects.toThrow('RECEIVE_LINE_NOT_FOUND: missing');
  });

  it('keeps an implemented stock adapter closed until its operation release canary changes static support', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-safe-receipt-static-closure-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const current = { purchaseOrderId: 'po-1', vendorId: 'v-1', timestamp: 'po-t-1', receiveLines: [], unstockLines: [] };
    const prepareMutation = vi.fn();
    const client = { get: vi.fn(async () => current), prepareMutation } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: true,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const handler = handlers.get('set_purchase_order_receipts')!;
    const request = {
      purchaseOrderId: 'po-1', action: 'receive',
      receiveLines: [{ productId: 'p-1', quantity: { standardQuantity: '1', uomQuantity: '1' } }],
    };
    const preview = JSON.parse((await handler({ ...request, dryRun: true })).content[0].text);
    await expect(handler({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow('OPERATION_UNSUPPORTED');
    expect(prepareMutation).not.toHaveBeenCalled();
  });

  it('keeps an already-absent webhook delete behind its release gate', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-safe-webhook-absent-'));
    await chmod(stateDir, 0o700);
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const prepareMutation = vi.fn();
    const client = { get: vi.fn(async () => { throw notFound; }), prepareMutation } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const handler = handlers.get('remove_webhook')!;
    const preview = JSON.parse((await handler({ webhookId: 'wh-1', dryRun: true })).content[0].text);
    await expect(handler({
      webhookId: 'wh-1', dryRun: false, previewToken: preview.previewToken,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow('OPERATION_UNSUPPORTED');
    expect(prepareMutation).not.toHaveBeenCalled();
  });
});
