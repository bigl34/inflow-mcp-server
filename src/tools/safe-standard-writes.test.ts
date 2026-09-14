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

describe('product create readback', () => {
  async function harness(values: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-product-create-readback-'));
    await chmod(stateDir, 0o700);
    let handler: (args: any) => Promise<any> = async () => undefined;
    let current: Record<string, unknown> | undefined;
    const dispatch = vi.fn();
    const client = {
      get: vi.fn(async () => structuredClone(current)),
      prepareMutation: vi.fn(async (_method: string, _path: string, options: { body: Record<string, unknown> }) => ({
        dispatch: async () => {
          dispatch();
          current = {
            description: '', sku: 'INFL000581', categoryId: 'default-category', isActive: true,
            ...options.body,
            customFields: {
              ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom${index + 1}`, ''])),
              ...options.body.customFields as Record<string, unknown>,
            },
            ...overrides, timestamp: 't-created',
          };
          return current;
        },
      })),
    };
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    registerSafeStandardWriteTools(server, client as unknown as InflowClient, config);
    const request = { mode: 'replace', values: { name: 'Tool Kit Bag - NOS', ...values } };
    const call = async (args: Record<string, unknown>) => JSON.parse((await handler(args)).content[0].text);
    const preview = (args = request, idempotencyKey?: string) => call({ ...args, idempotencyKey, dryRun: true });
    const apply = (proof: any, args = request) => call({
      ...args, dryRun: false, previewToken: proof.previewToken, idempotencyKey: proof.idempotencyKey,
      expectedDesiredHash: proof.desiredHash, expectedSemanticHash: proof.currentSemanticHash,
      expectedWriteShapeHash: proof.currentWriteShapeHash, expectedEntityTimestamp: proof.entityTimestamp,
    });
    return {
      client, dispatch, request, preview, apply, journal: new MutationJournal(stateDir),
      setCurrent: (value: Record<string, unknown>) => { current = value; },
      getCurrent: () => structuredClone(current!),
    };
  }

  it('accepts provider defaults without adding them to a name-only create request', async () => {
    const fixture = await harness();
    const preview = await fixture.preview();
    const result = await fixture.apply(preview);
    expect(result).toMatchObject({
      applicationState: 'applied_verified', verified: true, resourceId: preview.resourceId,
      actual: { name: 'Tool Kit Bag - NOS', sku: 'INFL000581', isActive: true },
    });
    expect(fixture.client.prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: preview.resourceId, name: 'Tool Kit Bag - NOS' },
    });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect((await fixture.journal.get(preview.operationId))?.state).toBe('applied_verified');
  });

  it.each([
    [{}, { name: 'Wrong product' }],
    [{}, { productId: 'wrong-id' }],
    [{ sku: 'EXPLICIT' }, { sku: 'GENERATED' }],
    [{ categoryId: 'explicit-category' }, { categoryId: 'default-category' }],
    [{ description: null }, { description: '' }],
    [{ description: '' }, { description: 'unexpected' }],
    [{ isActive: false }, { isActive: true }],
    [{ cost: 0 }, { cost: 1 }],
    [{ customFields: { custom1: 'expected' } }, { customFields: { custom1: 'wrong' } }],
    [{ customFields: { custom1: 'expected' } }, { customFields: {} }],
    [{ customFields: { custom1: 'expected' } }, { customFields: null }],
  ])('rejects mismatched explicit create fields %j / %j', async (values, overrides) => {
    const fixture = await harness(values, overrides);
    const result = await fixture.apply(await fixture.preview());
    expect(result).toMatchObject({
      applicationState: 'applied_unverified', verified: false, error: { code: 'VERIFICATION_MISMATCH' },
    });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves matching explicit null, empty, zero, false, and custom-field values', async () => {
    const fixture = await harness({
      description: null, sku: '', cost: 0, isActive: false, customFields: { custom1: '' },
    });
    expect(await fixture.apply(await fixture.preview())).toMatchObject({
      applicationState: 'applied_verified', verified: true,
    });
  });

  it('accepts provider-added custom-field siblings while verifying the supplied field', async () => {
    const fixture = await harness({ customFields: { custom1: 'expected' } });
    expect(await fixture.apply(await fixture.preview())).toMatchObject({
      applicationState: 'applied_verified', verified: true,
      actual: { customFields: { custom1: 'expected', custom2: '', custom10: '' } },
    });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps full verification for changes to an existing product', async () => {
    const fixture = await harness({}, { description: 'unexpected collateral change' });
    fixture.setCurrent({ productId: 'existing', name: 'Product', description: 'keep', sku: 'OLD', timestamp: 't-1' });
    const request = { productId: 'existing', mode: 'patch', values: { name: 'Product', sku: 'NEW' } };
    const result = await fixture.apply(await fixture.preview(request), request);
    expect(result).toMatchObject({
      applicationState: 'applied_unverified', verified: false, error: { code: 'VERIFICATION_MISMATCH' },
    });
  });

  it('binds explicit null field presence to the signed create preview', async () => {
    const fixture = await harness();
    const preview = await fixture.preview();
    const changed = { ...fixture.request, values: { ...fixture.request.values, description: null } };
    await expect(fixture.apply(preview, changed)).rejects.toThrow('PREVIEW_TOKEN_SCOPE_MISMATCH');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
  });

  it('rejects a changed create field mask for an existing idempotency key', async () => {
    const fixture = await harness({}, { name: 'Not yet consistent' });
    const preview = await fixture.preview();
    await fixture.apply(preview);
    fixture.client.prepareMutation.mockClear();
    const changed = { ...fixture.request, values: { ...fixture.request.values, description: null } };
    await expect(fixture.preview(changed, preview.idempotencyKey)).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires the same input scope when only the idempotency mapping exists (missing=%s)', async (missing) => {
    const fixture = await harness();
    const preview = await fixture.preview();
    const token = JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString('utf8'));
    await fixture.journal.putIdempotency(token.idempotencyKeyHash, {
      operationId: preview.operationId, desiredHash: preview.desiredHash, plannedIds: token.plannedIds,
      ...(missing ? {} : { inputHash: token.sourceHashes.mutationInput }),
    });
    expect(await fixture.journal.get(preview.operationId)).toBeUndefined();
    const changed = { ...fixture.request, values: { ...fixture.request.values, description: null } };
    await expect(fixture.preview(missing ? fixture.request : changed, preview.idempotencyKey))
      .rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
  });

  it('refuses legacy journal replay until the original input scope is recovered', async () => {
    const fixture = await harness({}, { name: 'Not yet consistent' });
    const preview = await fixture.preview();
    await fixture.apply(preview);
    await fixture.journal.update(preview.operationId, ({ inputHash: _inputHash, ...record }) => record);
    fixture.client.prepareMutation.mockClear();
    const recoveryPreview = await fixture.preview(fixture.request, preview.idempotencyKey);
    await expect(fixture.apply(recoveryPreview)).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
  });

  it('recovers an existing failed create through idempotent readback without another dispatch', async () => {
    const fixture = await harness({}, { name: 'Not yet consistent' });
    const originalPreview = await fixture.preview();
    const original = await fixture.apply(originalPreview);
    expect(original.applicationState).toBe('applied_unverified');
    fixture.setCurrent({ ...fixture.getCurrent(), name: fixture.request.values.name });
    fixture.client.prepareMutation.mockClear();
    fixture.dispatch.mockClear();
    const recoveryPreview = await fixture.preview(fixture.request, originalPreview.idempotencyKey);
    expect(recoveryPreview).toMatchObject({
      operationId: original.operationId, resourceId: original.resourceId, desiredHash: original.desiredHash,
    });
    const recovered = await fixture.apply(recoveryPreview);
    expect(recovered).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(recovered.warnings).toContain('Idempotent replay performed readback only; desired state was verified without redispatch');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const record = await fixture.journal.get(original.operationId);
    expect(record?.state).toBe('applied_verified');
    expect(record?.steps[0].state).toBe('verified');
  });

  it.each(['patch', 'replace'])('retains caller-supplied ID create intent on %s-mode recovery', async (mode) => {
    const fixture = await harness({}, { name: 'Not yet consistent' });
    const request = { ...fixture.request, productId: 'supplied-id', mode };
    const preview = await fixture.preview(request);
    const original = await fixture.apply(preview, request);
    expect(original.applicationState).toBe('applied_unverified');
    fixture.setCurrent({ ...fixture.getCurrent(), name: fixture.request.values.name });
    fixture.client.prepareMutation.mockClear();
    fixture.dispatch.mockClear();
    const recoveryPreview = await fixture.preview(request, preview.idempotencyKey);
    expect(recoveryPreview).toMatchObject({
      operationId: original.operationId, resourceId: 'supplied-id', desiredHash: original.desiredHash,
    });
    expect(await fixture.apply(recoveryPreview, request)).toMatchObject({
      applicationState: 'applied_verified', verified: true,
    });
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});

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
