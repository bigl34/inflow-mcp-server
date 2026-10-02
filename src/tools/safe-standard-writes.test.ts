import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { canonicalHash } from '../core/canonical-json.js';
import { MutationJournal } from '../core/mutation-journal.js';
import { createTempStateDir } from '../core/temp-state.fixtures.js';
import { productObservedSemantic, registerSafeStandardWriteTools } from './safe-standard-writes.js';
import { customFieldDefinitionsList } from './custom-field-kinds.fixtures.js';

describe('product create readback', () => {
  async function harness(values: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
    const stateDir = await createTempStateDir('inflow-product-create-readback-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    let current: Record<string, unknown> | undefined;
    const dispatch = vi.fn();
    const client = { getList: customFieldDefinitionsList(),
      get: vi.fn(async () => structuredClone(current)),
      prepareMutation: vi.fn(async (_method: string, _path: string, options: { body: Record<string, unknown> }) => ({
        dispatch: async () => {
          dispatch();
          current = {
            description: '', sku: 'TEST-COMPONENT-004', categoryId: 'default-category', isActive: true,
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
    const request = { mode: 'replace', values: { name: 'Fixture Component D', ...values } };
    const call = async (args: Record<string, unknown>) => JSON.parse((await handler(args)).content[0].text);
    const preview = (args = request, idempotencyKey?: string) => call({ ...args, idempotencyKey, dryRun: true });
    const apply = (proof: any, args = request) => call({
      ...args, dryRun: false, previewToken: proof.previewToken, idempotencyKey: proof.idempotencyKey,
      expectedDesiredHash: proof.desiredHash, expectedSemanticHash: proof.currentSemanticHash,
      expectedWriteShapeHash: proof.currentWriteShapeHash, expectedEntityTimestamp: proof.entityTimestamp,
    });
    return {
      client, dispatch, request, preview, apply, journal: new MutationJournal(stateDir), stateDir,
      setCurrent: (value: Record<string, unknown>) => { current = value; },
      getCurrent: () => structuredClone(current!),
    };
  }

  const PALLET_FIELDS = {
    description: 'Wooden pallets, warehouse ground use',
    categoryId: 'pallet-category',
  };

  it('verifies a create that supplies description and categoryId alongside provider defaults', async () => {
    const fixture = await harness(PALLET_FIELDS);
    const preview = await fixture.preview();
    expect(preview.sourceHashes).toEqual({ mutationInput: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const result = await fixture.apply(preview);
    expect(result).toMatchObject({
      applicationState: 'applied_verified', verified: true, resourceId: preview.resourceId,
      desired: { ...PALLET_FIELDS, sku: null, isActive: null, customFields: null },
      actual: {
        ...PALLET_FIELDS, name: 'Fixture Component D', sku: 'TEST-COMPONENT-004', isActive: true,
        customFields: { custom1: '', custom10: '' },
      },
    });
    expect(fixture.client.prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: preview.resourceId, name: 'Fixture Component D', ...PALLET_FIELDS },
    });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(await fixture.journal.get(preview.operationId)).toMatchObject({
      state: 'applied_verified', inputHash: preview.sourceHashes.mutationInput,
    });
  });

  it('verifies an explicitly inactive create with description and categoryId', async () => {
    const fixture = await harness({ ...PALLET_FIELDS, isActive: false });
    expect(await fixture.apply(await fixture.preview())).toMatchObject({
      applicationState: 'applied_verified', verified: true,
      actual: { ...PALLET_FIELDS, isActive: false, sku: 'TEST-COMPONENT-004' },
    });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it('recovers a legacy create record once its input scope is restored from the original request', async () => {
    const fixture = await harness(PALLET_FIELDS, { name: 'Not yet consistent' });
    const originalPreview = await fixture.preview();
    const original = await fixture.apply(originalPreview);
    expect(original.applicationState).toBe('applied_unverified');
    // Journals written before input-scope binding carry no inputHash on the
    // record or its idempotency mapping.
    const legacy = await fixture.journal.update(original.operationId, ({ inputHash: _inputHash, ...record }) => record);
    const mappingPath = join(fixture.stateDir, 'idempotency', `${legacy.idempotencyKeyHash}.json`);
    const { inputHash: _mappingInputHash, ...legacyMapping } = JSON.parse(await readFile(mappingPath, 'utf8'));
    await writeFile(mappingPath, JSON.stringify(legacyMapping));
    fixture.setCurrent({ ...fixture.getCurrent(), name: fixture.request.values.name });
    fixture.client.prepareMutation.mockClear();
    fixture.dispatch.mockClear();
    await expect(fixture.preview(fixture.request, originalPreview.idempotencyKey)).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');

    await fixture.journal.restoreInputScope(original.operationId, originalPreview.sourceHashes.mutationInput);
    const recoveryPreview = await fixture.preview(fixture.request, originalPreview.idempotencyKey);
    expect(recoveryPreview).toMatchObject({
      operationId: original.operationId, resourceId: original.resourceId, desiredHash: original.desiredHash,
    });
    const recovered = await fixture.apply(recoveryPreview);
    expect(recovered).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(recovered.warnings).toContain('Idempotent replay performed readback only; desired state was verified without redispatch');
    expect(fixture.client.prepareMutation).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(await fixture.journal.get(original.operationId)).toMatchObject({
      state: 'applied_verified', inputHash: originalPreview.sourceHashes.mutationInput,
    });
  });

  it('accepts provider defaults without adding them to a name-only create request', async () => {
    const fixture = await harness();
    const preview = await fixture.preview();
    const result = await fixture.apply(preview);
    expect(result).toMatchObject({
      applicationState: 'applied_verified', verified: true, resourceId: preview.resourceId,
      actual: { name: 'Fixture Component D', sku: 'TEST-COMPONENT-004', isActive: true },
    });
    expect(fixture.client.prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: preview.resourceId, name: 'Fixture Component D' },
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
    [{ weight: 0 }, { weight: 1 }],
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
      description: null, sku: '', weight: 0, isActive: false, customFields: { custom1: '' },
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
    const stateDir = await createTempStateDir('inflow-standard-preview-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', weight: 12.5, timestamp: 't-1' })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({ productId: 'p-1', mode: 'patch', values: { weight: 13.75 }, dryRun: true });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.applicationState).toBe('preview');
    expect(preview.diff.operations).toContainEqual(expect.objectContaining({ path: '/weight', before: '12.5', after: '13.75' }));
    expect(client.get).toHaveBeenCalledWith('/products/p-1', undefined);
  });

  it('deep-merges product custom-field patches while preserving sibling and falsy values', async () => {
    const stateDir = await createTempStateDir('inflow-standard-custom-fields-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
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

  const CUSTOM_FIELD_ADAPTERS: Array<[string, string, string, string, Record<string, unknown>]> = [
    ['set_sales_order', 'sales-order', 'salesOrderId', 'so-1', { customerId: 'c-1', orderNumber: 'SO-1' }],
    ['set_purchase_order', 'purchase-order', 'purchaseOrderId', 'po-1', { vendorId: 'v-1', orderNumber: 'PO-1' }],
    ['set_customer', 'customer', 'customerId', 'c-1', { name: 'Customer' }],
    ['set_vendor', 'vendor', 'vendorId', 'v-1', { name: 'Vendor' }],
    ['set_stock_adjustment', 'stock-adjustment', 'stockAdjustmentId', 'sa-1', { locationId: 'l-1', lines: [] }],
    ['set_stock_transfer', 'stock-transfer', 'stockTransferId', 'st-1', { fromLocationId: 'l-1', toLocationId: 'l-2', lines: [] }],
    ['set_manufacturing_order', 'manufacturing-order', 'manufacturingOrderId', 'mo-1', { primaryFinishedProductId: 'p-1', lines: [] }],
  ];

  it.each(CUSTOM_FIELD_ADAPTERS)('deep-merges %s custom-field patches while preserving sibling and falsy values', async (tool, resourceType, idField, id, fields) => {
    const stateDir = await createTempStateDir('inflow-standard-custom-fields-generic-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === tool) handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
      [idField]: id, ...fields, timestamp: 't-1',
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
      [idField]: id, mode: 'patch',
      values: { customFields: { custom1: 'https://admin.shopify.com/store/example/orders/1', custom5: null, custom6: '' } },
      dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.customFields).toEqual({
      custom1: 'https://admin.shopify.com/store/example/orders/1',
      custom2: 'keep', custom3: 0, custom4: false, custom5: null, custom6: '',
    });
    expect(preview.diff.operations).toEqual([
      expect.objectContaining({ path: '/customFields/custom1', before: '', after: 'https://admin.shopify.com/store/example/orders/1' }),
      expect.objectContaining({ op: 'add', path: '/customFields/custom6', after: '' }),
    ]);
    const tokenPayload = JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString());
    expect(tokenPayload.adapterVersion).toBe(`${resourceType}/safe-v5`);
  });

  it('keeps adapters without a customFields projection on safe-v2', async () => {
    const stateDir = await createTempStateDir('inflow-standard-no-custom-fields-version-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_stock_count') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
      stockCountId: 'sc-1', locationId: 'l-1', timestamp: 't-1', remarks: '',
    })) } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const response = await handler({ stockCountId: 'sc-1', mode: 'patch', values: { remarks: 'counted' }, dryRun: true });
    const preview = JSON.parse(response.content[0].text);
    const tokenPayload = JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString());
    expect(tokenPayload.adapterVersion).toBe('stock-count/safe-v2');
  });

  it('keeps whole-object custom-field semantics in replace mode on a non-product adapter', async () => {
    const stateDir = await createTempStateDir('inflow-standard-replace-custom-fields-so-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_sales_order') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
      salesOrderId: 'so-1', customerId: 'c-1', timestamp: 't-1', customFields: { custom1: '', custom2: 'do-not-merge' },
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
      salesOrderId: 'so-1', mode: 'replace', values: { customerId: 'c-1', customFields: { custom1: 'replacement' } }, dryRun: true,
    });
    const preview = JSON.parse(response.content[0].text);
    expect(preview.desired.customFields).toEqual({ custom1: 'replacement' });
  });

  it.each([
    ['set_product', 'productId', null],
    ['set_product', 'productId', [[]]],
    ['set_product', 'productId', 'not-an-object'],
    ['set_product', 'productId', 7],
    ['set_sales_order', 'salesOrderId', null],
    ['set_sales_order', 'salesOrderId', [[]]],
    ['set_sales_order', 'salesOrderId', 'not-an-object'],
    ['set_sales_order', 'salesOrderId', 7],
  ])(
    'rejects non-object %s custom-field patch containers: %j',
    async (tool, idField, customFieldsCase) => {
      const customFields = Array.isArray(customFieldsCase) ? customFieldsCase[0] : customFieldsCase;
      const stateDir = await createTempStateDir('inflow-standard-invalid-custom-fields-');
      let handler: (args: any) => Promise<any> = async () => undefined;
      const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
        if (name === tool) handler = callback;
      } } as unknown as McpServer;
      const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({ [idField]: 'x-1', name: 'Row', customerId: 'c-1', timestamp: 't-1', customFields: {} })) } as unknown as InflowClient;
      const config: InflowConfig = {
        companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
        rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
        readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
        enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
        writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
      };
      registerSafeStandardWriteTools(server, client, config);
      expect(Array.isArray(customFieldsCase) ? Array.isArray(customFields) : true).toBe(true);
      await expect(handler({ [idField]: 'x-1', mode: 'patch', values: { customFields }, dryRun: true }))
        .rejects.toThrow('INVALID_CUSTOM_FIELDS');
    }
  );

  it('keeps whole-object custom-field semantics in replace mode', async () => {
    const stateDir = await createTempStateDir('inflow-standard-replace-custom-fields-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
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
    const stateDir = await createTempStateDir('inflow-standard-empty-custom-fields-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
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
    const stateDir = await createTempStateDir('inflow-standard-gate-close-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(),
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
    const stateDir = await createTempStateDir('inflow-standard-product-apply-');
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
    const client = { getList: customFieldDefinitionsList(),
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
    const stateDir = await createTempStateDir('inflow-standard-product-sku-apply-');
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
    const client = { getList: customFieldDefinitionsList(),
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
    const stateDir = await createTempStateDir('inflow-standard-product-replace-apply-');
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
    const client = { getList: customFieldDefinitionsList(),
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
    const stateDir = await createTempStateDir('inflow-standard-product-stale-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, unknown> = {
      productId: 'p-1', name: 'Product', timestamp: 't-1', customFields: { custom1: '', custom2: 'keep' },
      providerOnlyState: 'before',
    };
    const prepareMutation = vi.fn();
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => current), prepareMutation } as unknown as InflowClient;
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
    const stateDir = await createTempStateDir('inflow-standard-projection-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', total: 50, timestamp: 't-1' })) } as unknown as InflowClient;
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
    const stateDir = await createTempStateDir('inflow-standard-create-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(),} as InflowClient;
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
    const stateDir = await createTempStateDir('inflow-standard-idempotency-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async (path: string) => path.endsWith('/existing')
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
    const stateDir = await createTempStateDir('inflow-standard-compat-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(),} as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: false, stockWritesEnabled: false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const adjustmentPreview = await handlers.get('set_stock_adjustment')!({ mode: 'replace', values: {
      locationId: 'loc-1', adjustmentReasonId: 'reason-1', remarks: 'damage', lines: [{ productId: 'p-1', quantity: { standardQuantity: -2, uomQuantity: -2 } }],
    }, dryRun: true });
    const adjustmentResult = JSON.parse(adjustmentPreview.content[0].text);
    expect(adjustmentResult.desired.lines[0].stockAdjustmentLineId).toMatch(/^[a-f0-9-]{36}$/);
    const purchasePreview = await handlers.get('set_purchase_order')!({ mode: 'replace', values: {
      vendorId: 'vendor-1', orderRemarks: 'new order', lines: [{ productId: 'p-1', quantity: { standardQuantity: 3, uomQuantity: 3 }, unitPrice: 12.5 }],
    }, dryRun: true });
    const purchaseResult = JSON.parse(purchasePreview.content[0].text);
    expect(purchaseResult.desired.lines[0].purchaseOrderLineId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(handlers.get('set_stock_adjustment')!({ mode: 'replace', values: {
      locationId: 'loc-1', reasonId: 'reason-1', items: [],
    }, dryRun: true })).rejects.toThrow('UNSUPPORTED_WRITABLE_FIELDS: items,reasonId');
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
      const stateDir = await createTempStateDir('inflow-standard-product-owned-');
      let handler: (args: any) => Promise<any> = async () => undefined;
      const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
        if (name === 'set_product') handler = callback;
      } } as unknown as McpServer;
      const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({ productId: 'p-1', name: 'Product', timestamp: 't-1' })) } as unknown as InflowClient;
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
    const stateDir = await createTempStateDir('inflow-safe-receive-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
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
    const stateDir = await createTempStateDir('inflow-safe-unreceive-');
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
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => current) } as unknown as InflowClient;
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
    const stateDir = await createTempStateDir('inflow-safe-receipt-unsupported-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({
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

  it('applies purchase-order receipts once both runtime gates are open', async () => {
    const stateDir = await createTempStateDir('inflow-safe-receipt-apply-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    let current: Record<string, any> = { purchaseOrderId: 'po-1', vendorId: 'v-1', timestamp: 'po-t-1', receiveLines: [], unstockLines: [] };
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-receipt',
      dispatch: async () => {
        current = { ...current, ...options.body, timestamp: 'po-t-2' };
        return current;
      },
    }));
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => structuredClone(current)), prepareMutation } as unknown as InflowClient;
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
    const applied = JSON.parse((await handler({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    })).content[0].text);
    expect(prepareMutation).toHaveBeenCalledTimes(1);
    expect(prepareMutation.mock.calls[0][0]).toBe('PUT');
    expect(prepareMutation.mock.calls[0][1]).toBe('/purchase-orders');
    expect(current.receiveLines).toHaveLength(1);
  });

  it('keeps an already-absent webhook delete behind the master safe-write gate', async () => {
    const stateDir = await createTempStateDir('inflow-safe-webhook-absent-');
    const handlers = new Map<string, (args: any) => Promise<any>>();
    const server = { tool(name: string, _description: string, _schema: unknown, callback: (args: any) => Promise<any>) {
      handlers.set(name, callback);
    } } as unknown as McpServer;
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const prepareMutation = vi.fn();
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => { throw notFound; }), prepareMutation } as unknown as InflowClient;
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
    })).rejects.toThrow('SAFE_WRITES_DISABLED');
    expect(prepareMutation).not.toHaveBeenCalled();
  });
});

describe('provider custom-field coercion', () => {
  const PROVIDER_DATE = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/;

  function coerceCustomFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
    return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => {
      if (typeof value === 'boolean') return [key, value ? 'True' : 'False'];
      const isoDate = typeof value === 'string' ? PROVIDER_DATE.exec(value) : null;
      if (isoDate) return [key, `${isoDate[2]}/${isoDate[3]}/${isoDate[1]} 00:00:00`];
      return [key, value];
    }));
  }

  async function harness(
    initial: Record<string, unknown>,
    readbackOverride?: (body: Record<string, any>) => Record<string, unknown>,
    options: { tool?: string; getList?: (path: string) => Promise<unknown>; stockWrites?: boolean } = {}
  ) {
    const tool = options.tool ?? 'set_product';
    const stateDir = await createTempStateDir('inflow-product-custom-field-coercion-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === tool) handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> | undefined = Object.keys(initial).length ? { ...initial } : undefined;
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-coercion',
      dispatch: async () => {
        const merged: Record<string, any> = { ...(current ?? {}), ...options.body, timestamp: 't-2' };
        current = {
          ...merged,
          customFields: readbackOverride ? readbackOverride(options.body) : coerceCustomFields(merged.customFields),
        };
        return current;
      },
    }));
    const getList = vi.fn(options.getList ?? customFieldDefinitionsList());
    const client = { getList,
      get: vi.fn(async () => current ? { ...current, customFields: { ...current.customFields } } : undefined),
      prepareMutation,
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: options.stockWrites ?? false,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const call = async (args: Record<string, unknown>) => JSON.parse((await handler(args)).content[0].text);
    const apply = (request: Record<string, unknown>, preview: any) => call({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    });
    return { call, apply, prepareMutation, getList, journal: new MutationJournal(stateDir), getCurrent: () => current };
  }

  const EXISTING = {
    productId: 'p-1', name: 'Fixture Component E', sku: 'TEST-COMPONENT-005', isActive: true, timestamp: 't-1',
    customFields: { custom1: '', custom2: '', custom3: '', custom4: '', custom5: 'True' },
  };

  it('verifies a patch whose checkbox booleans and ISO date come back as provider text', async () => {
    const fixture = await harness(EXISTING);
    const request = {
      productId: 'p-1', mode: 'patch',
      values: { customFields: { custom3: true, custom5: false, custom4: '2026-09-18T00:00:00.000Z' } },
    };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.applicationState).toBe('preview');
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(applied.error).toBeUndefined();
    expect(fixture.prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: {
        productId: 'p-1', name: 'Fixture Component E', timestamp: 't-1',
        customFields: { custom1: '', custom2: '', custom3: true, custom4: '2026-09-18T00:00:00.000Z', custom5: false },
      },
    });
    expect(fixture.getCurrent()?.customFields).toEqual({
      custom1: '', custom2: '', custom3: 'True', custom4: '09/18/2026 00:00:00', custom5: 'False',
    });
    expect((await fixture.journal.get(preview.operationId))?.state).toBe('applied_verified');
  });

  it('treats an already-coerced checkbox as unchanged when the patch repeats it as a boolean', async () => {
    const fixture = await harness(EXISTING);
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom5: true } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.applicationState).toBe('preview');
    expect(preview.diff.operations).toEqual([]);
    expect(preview.currentSemanticHash).toBe(preview.desiredHash);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'no_op', verified: true });
    expect(fixture.prepareMutation).not.toHaveBeenCalled();
  });

  it('verifies a create whose checkbox boolean comes back as provider text', async () => {
    const fixture = await harness({});
    const request = { mode: 'replace', values: { name: 'Fixture Component D', customFields: { custom3: true } } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'create-coercion-1' });
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'create-coercion-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent()?.customFields).toEqual({ custom3: 'True' });
  });

  it('still reports a mismatch when the provider stores a different checkbox or date value', async () => {
    const wrongCheckbox = await harness(EXISTING, () => ({ ...EXISTING.customFields, custom3: 'False' }));
    const checkboxRequest = { productId: 'p-1', mode: 'patch', values: { customFields: { custom3: true } } };
    const checkboxPreview = await wrongCheckbox.call({ ...checkboxRequest, dryRun: true });
    const checkboxApplied = await wrongCheckbox.apply(checkboxRequest, checkboxPreview);
    expect(checkboxApplied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });

    const wrongDate = await harness(EXISTING, () => ({ ...EXISTING.customFields, custom4: '09/19/2026 00:00:00' }));
    const dateRequest = { productId: 'p-1', mode: 'patch', values: { customFields: { custom4: '2026-09-18T00:00:00.000Z' } } };
    const datePreview = await wrongDate.call({ ...dateRequest, dryRun: true });
    const dateApplied = await wrongDate.apply(dateRequest, datePreview);
    expect(dateApplied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  it('keeps text custom fields verbatim so a case-only edit is still a real write', async () => {
    const fixture = await harness({ ...EXISTING, customFields: { ...EXISTING.customFields, custom1: 'True' } });
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'true' } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toEqual([{ op: 'replace', path: '/customFields/custom1', before: 'True', after: 'true' }]);
    expect(preview.currentSemanticHash).not.toBe(preview.desiredHash);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
    expect(fixture.getCurrent()?.customFields.custom1).toBe('true');
  });

  it('keeps a text custom field holding a date-shaped value verbatim', async () => {
    const fixture = await harness({ ...EXISTING, customFields: { ...EXISTING.customFields, custom1: '09/18/2026 00:00:00' } });
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: '2026-09-18' } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toHaveLength(1);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
  });

  it('does not let a text value verify against a different text value the provider kept', async () => {
    const fixture = await harness(EXISTING, () => ({ ...EXISTING.customFields, custom1: 'TRUE' }));
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom1: 'true' } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  it.each([
    ['-', false, true],
    ['   FALSE', false, true],
    ['Yes', true, true],
    ['FALSE', false, false],
    ['False', false, false],
  ])('checkbox pre-state %j with desired %j dispatches=%j', async (preState, desired, dispatches) => {
    const fixture = await harness({ ...EXISTING, customFields: { ...EXISTING.customFields, custom3: preState } });
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom3: desired } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    const applied = await fixture.apply(request, preview);
    if (dispatches) {
      expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
      expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
      expect(fixture.getCurrent()?.customFields.custom3).toBe(desired ? 'True' : 'False');
    } else {
      expect(applied).toMatchObject({ applicationState: 'no_op' });
      expect(fixture.prepareMutation).not.toHaveBeenCalled();
    }
  });

  it('treats a bare calendar date and the ISO midnight form of the same day as unchanged', async () => {
    const fixture = await harness({ ...EXISTING, customFields: { ...EXISTING.customFields, custom4: '2025-10-10' } });
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom4: '2025-10-10T00:00:00.000Z' } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toEqual([]);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'no_op' });
  });

  it('leaves impossible calendar dates and non-midnight timestamps verbatim', async () => {
    const fixture = await harness({ ...EXISTING, customFields: { ...EXISTING.customFields, custom4: '02/31/2026 00:00:00' } });
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom4: '2026-02-31' } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toHaveLength(1);
    const timed = await harness(EXISTING, () => ({ ...EXISTING.customFields, custom4: '09/18/2026 00:00:00' }));
    const timedRequest = { productId: 'p-1', mode: 'patch', values: { customFields: { custom4: '2026-09-18T14:02:11.657Z' } } };
    const timedPreview = await timed.call({ ...timedRequest, dryRun: true });
    const timedApplied = await timed.apply(timedRequest, timedPreview);
    expect(timedApplied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  it('verifies a replace-mode product write whose checkbox comes back as provider text', async () => {
    const fixture = await harness(EXISTING);
    const request = {
      productId: 'p-1', mode: 'replace',
      values: { name: 'Fixture Component E', sku: 'TEST-COMPONENT-005', isActive: true, customFields: { custom1: '', custom3: true, custom4: '2026-09-18T00:00:00.000Z' } },
    };
    const preview = await fixture.call({ ...request, dryRun: true });
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent()?.customFields).toEqual({ custom1: '', custom3: 'True', custom4: '09/18/2026 00:00:00' });
  });

  it('applies the same canonicalisation to sales-order checkbox and date custom fields', async () => {
    const order = {
      salesOrderId: 'so-1', customerId: 'c-1', orderNumber: 'SO-1', timestamp: 't-1', lines: [],
      customFields: { custom1: '', custom4: 'https://admin.shopify.com/store/example/orders/1', custom7: '' },
    };
    const fixture = await harness(order, undefined, { tool: 'set_sales_order', stockWrites: true });
    const request = {
      salesOrderId: 'so-1', mode: 'patch',
      values: { customFields: { ...order.customFields, custom1: true, custom7: '2026-09-18T00:00:00.000Z' } },
    };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'so-coercion-1' });
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'so-coercion-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent()?.customFields).toEqual({
      custom1: 'True', custom4: 'https://admin.shopify.com/store/example/orders/1', custom7: '09/18/2026 00:00:00',
    });
    expect(JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString()).adapterVersion).toBe('sales-order/safe-v5');
  });

  it('sends every current sales-order custom field in the PUT body when the patch names only one', async () => {
    const order = {
      salesOrderId: 'so-1', customerId: 'c-1', orderNumber: 'SO-1', timestamp: 't-1', lines: [],
      customFields: { custom1: '', custom4: 'https://admin.shopify.com/store/example/orders/1', custom7: '09/18/2026 00:00:00', custom10: '1234567890' },
    };
    const fixture = await harness(order, undefined, { tool: 'set_sales_order', stockWrites: true });
    const request = { salesOrderId: 'so-1', mode: 'patch', values: { customFields: { custom1: true } } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'so-partial-patch-1' });
    expect(preview.desired.customFields).toEqual({ ...order.customFields, custom1: true });
    expect(preview.diff.operations).toEqual([
      expect.objectContaining({ path: '/customFields/custom1', before: '', after: true }),
    ]);
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'so-partial-patch-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
    expect(fixture.prepareMutation.mock.calls[0][2].body.customFields).toEqual({ ...order.customFields, custom1: true });
    expect(fixture.getCurrent()?.customFields).toEqual({ ...order.customFields, custom1: 'True' });
    expect(JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString()).adapterVersion).toBe('sales-order/safe-v5');
  });

  it('fails closed when the tenant custom-field definitions cannot be read', async () => {
    const fixture = await harness(EXISTING, undefined, { getList: async () => { throw new Error('HTTP 503'); } });
    await expect(fixture.call({ productId: 'p-1', mode: 'patch', values: { customFields: { custom3: true } }, dryRun: true }))
      .rejects.toThrow(/^CUSTOM_FIELD_DEFINITIONS_UNAVAILABLE: HTTP 503/);
    expect(fixture.prepareMutation).not.toHaveBeenCalled();
  });

  it('reads the tenant custom-field definitions once per process window', async () => {
    const fixture = await harness(EXISTING);
    const request = { productId: 'p-1', mode: 'patch', values: { customFields: { custom3: true } } };
    const preview = await fixture.call({ ...request, dryRun: true });
    await fixture.apply(request, preview);
    expect(fixture.getList).toHaveBeenCalledTimes(1);
    expect(fixture.getList).toHaveBeenCalledWith('/custom-field-definitions', { pagination: { count: 100 } });
  });
});

describe('provider product scalar field shapes', () => {
  const PROVIDER_PRODUCT_KEYS = new Set([
    'productId', 'name', 'description', 'sku', 'categoryId', 'isActive', 'weight', 'customFields', 'timestamp',
  ]);

  function providerProduct(body: Record<string, unknown>): Record<string, unknown> {
    const stored = Object.fromEntries(Object.entries(body).filter(([key]) => PROVIDER_PRODUCT_KEYS.has(key)));
    if (typeof stored.weight === 'number' || typeof stored.weight === 'string') {
      stored.weight = Number(stored.weight).toFixed(4);
    }
    return stored;
  }

  async function harness(initial: Record<string, unknown>, readbackOverride?: (stored: Record<string, any>) => Record<string, unknown>) {
    const stateDir = await createTempStateDir('inflow-product-scalar-shapes-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === 'set_product') handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> | undefined = Object.keys(initial).length ? { ...initial } : undefined;
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-scalar',
      dispatch: async () => {
        const stored = providerProduct({ ...(current ?? {}), ...options.body, timestamp: 't-2' });
        current = readbackOverride ? readbackOverride(stored) : stored;
        return current;
      },
    }));
    const client = {
      getList: vi.fn(customFieldDefinitionsList()),
      get: vi.fn(async () => current ? { ...current } : undefined),
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
    const call = async (args: Record<string, unknown>) => JSON.parse((await handler(args)).content[0].text);
    const apply = (request: Record<string, unknown>, preview: any) => call({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    });
    return { call, apply, prepareMutation, client, getCurrent: () => current };
  }

  const EXISTING = {
    productId: 'p-1', name: 'Fixture Component E', sku: 'TEST-COMPONENT-005', isActive: true, weight: '0.0000', timestamp: 't-1',
    customFields: { custom1: '', custom2: '' },
  };

  it('verifies a weight patch that the provider echoes as four-decimal text', async () => {
    const fixture = await harness(EXISTING);
    const request = { productId: 'p-1', mode: 'patch', values: { weight: 2.5 } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toEqual([{ op: 'replace', path: '/weight', before: '0', after: '2.5' }]);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(applied.error).toBeUndefined();
    expect(fixture.prepareMutation).toHaveBeenCalledWith('PUT', '/products', {
      body: { productId: 'p-1', name: 'Fixture Component E', timestamp: 't-1', weight: '2.5' },
    });
    expect(fixture.getCurrent()?.weight).toBe('2.5000');
  });

  it('treats a weight patch equal to the stored four-decimal weight as unchanged', async () => {
    const fixture = await harness({ ...EXISTING, weight: '2.5000' });
    const request = { productId: 'p-1', mode: 'patch', values: { weight: '2.5' } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toEqual([]);
    expect(preview.currentSemanticHash).toBe(preview.desiredHash);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'no_op', verified: true });
    expect(fixture.prepareMutation).not.toHaveBeenCalled();
  });

  it('still reports a mismatch when the provider stores a different weight', async () => {
    const fixture = await harness(EXISTING, (stored) => ({ ...stored, weight: '2.6000' }));
    const request = { productId: 'p-1', mode: 'patch', values: { weight: 2.5 } };
    const preview = await fixture.call({ ...request, dryRun: true });
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  it('verifies a create carrying weight and then treats the same weight as unchanged on patch', async () => {
    const fixture = await harness({});
    const request = { mode: 'replace', values: { name: 'Fixture Component D', weight: 1.25 } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'create-weight-1' });
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'create-weight-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent()?.weight).toBe('1.2500');
    const repeat = { productId: applied.resourceId, mode: 'patch', values: { weight: 1.25 } };
    const repeatPreview = await fixture.call({ ...repeat, dryRun: true });
    expect(repeatPreview.diff.operations).toEqual([]);
    expect(await fixture.apply(repeat, repeatPreview)).toMatchObject({ applicationState: 'no_op' });
    expect(fixture.prepareMutation).toHaveBeenCalledTimes(1);
  });

  it('keeps sku text verbatim so a leading-zero change is still a real write that must read back exactly', async () => {
    const fixture = await harness({ ...EXISTING, sku: '123' }, (stored) => ({ ...stored, sku: '123' }));
    const request = { productId: 'p-1', mode: 'patch', values: { sku: '0123' } };
    const preview = await fixture.call({ ...request, dryRun: true });
    expect(preview.diff.operations).toEqual([{ op: 'replace', path: '/sku', before: '123', after: '0123' }]);
    const applied = await fixture.apply(request, preview);
    expect(applied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  const REJECTION = 'OPERATION_UNSUPPORTED: the product PUT ignores these fields, so generic product writes reject them: ';

  it.each([
    ['cost', 12.5, 'include=cost'],
    ['barcode', '0000000000000', 'productBarcodes[]'],
    ['reorderPoint', 5, 'reorderSettings[]'],
    ['reorderQuantity', 10, 'reorderSettings[]'],
    ['weightUnit', 'kg', 'company-wide'],
  ])('rejects a %s patch before preview and points at where the value really lives', async (field, value, pointer) => {
    const fixture = await harness(EXISTING);
    const rejection = fixture.call({ productId: 'p-1', mode: 'patch', values: { [field]: value }, dryRun: true });
    await expect(rejection).rejects.toThrow(`${REJECTION}${field} (${field}: `);
    await expect(rejection).rejects.toThrow(pointer);
  });

  it('rejects a create carrying cost and barcode and names both in one sorted list', async () => {
    const fixture = await harness({});
    await expect(fixture.call({ mode: 'replace', values: { name: 'Fixture Component D', cost: 12.5, barcode: '0000000000000' }, dryRun: true, idempotencyKey: 'create-unsupported-1' }))
      .rejects.toThrow(`${REJECTION}barcode,cost (barcode: `);
  });

  it('reads the plain product, omits the provider-dropped fields from the projection, and bumps the adapter version', async () => {
    const fixture = await harness(EXISTING);
    const preview = await fixture.call({ productId: 'p-1', mode: 'patch', values: { weight: 2.5 }, dryRun: true });
    expect(fixture.client.get).toHaveBeenCalledWith('/products/p-1', undefined);
    expect(Object.keys(preview.before).sort()).toEqual(['categoryId', 'customFields', 'description', 'isActive', 'name', 'productId', 'sku', 'weight']);
    expect(JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString()).adapterVersion).toBe('product/safe-v5');
  });
});

describe('provider decimal echoes on the other standard adapters', () => {
  const SCALES: Record<string, number> = {
    exchangeRate: 10, discount: 2, unitPrice: 5, subTotal: 5, standardQuantity: 4, uomQuantity: 4,
  };

  function echoDecimals(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map((row) => echoDecimals(row));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([child, nested]) => [child, echoDecimals(nested, child)]));
    }
    const scale = key ? SCALES[key] : undefined;
    if (scale !== undefined && (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)))) {
      return Number(value).toFixed(scale);
    }
    return value;
  }

  async function harness(tool: string, initial: Record<string, unknown>) {
    const stateDir = await createTempStateDir('inflow-standard-decimal-echo-');
    let handler: (args: any) => Promise<any> = async () => undefined;
    const server = { tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
      if (name === tool) handler = callback;
    } } as unknown as McpServer;
    let current: Record<string, any> = { ...initial };
    const prepareMutation = vi.fn(async (_method: string, _path: string, options: { body: Record<string, any> }) => ({
      correlationId: 'correlation-decimal-echo',
      dispatch: async () => {
        current = echoDecimals({ ...current, ...options.body, timestamp: 't-2' }) as Record<string, any>;
        return current;
      },
    }));
    const client = {
      getList: vi.fn(customFieldDefinitionsList()),
      get: vi.fn(async () => structuredClone(current)),
      prepareMutation,
    } as unknown as InflowClient;
    const config: InflowConfig = {
      companyId: 'company', apiKey: 'secret', baseUrl: 'https://api.test', apiVersion: '2026-04-13',
      rateLimitPerMinute: 60, requestTimeoutMs: 1000, maxRetries: 0, retryDelayMs: 1,
      readRetryBudgetMs: 1000, debug: false, stateDir, adapterManifestHash: '', probeBuild: '',
      enableLegacyWrites: false, safeWritesEnabled: true, stockWritesEnabled: true,
      writeGates: { manufacturing: false, prices: false, 'product-groups': false, 'mo-serials': false, standard: false },
    };
    registerSafeStandardWriteTools(server, client, config);
    const call = async (args: Record<string, unknown>) => JSON.parse((await handler(args)).content[0].text);
    const apply = (request: Record<string, unknown>, preview: any) => call({
      ...request, dryRun: false, previewToken: preview.previewToken, idempotencyKey: preview.idempotencyKey ?? 'decimal-echo',
      expectedSemanticHash: preview.currentSemanticHash, expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp, expectedDesiredHash: preview.desiredHash,
    });
    const adapterVersion = (preview: any) => JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString()).adapterVersion;
    return { call, apply, prepareMutation, adapterVersion, getCurrent: () => current };
  }

  it('verifies a customer discount the provider echoes at two decimals', async () => {
    const fixture = await harness('set_customer', { customerId: 'c-1', name: 'Acme', discount: '0.00', timestamp: 't-1', customFields: {} });
    const request = { customerId: 'c-1', mode: 'patch', values: { discount: 5 } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'customer-discount-1' });
    expect(preview.diff.operations).toEqual([{ op: 'replace', path: '/discount', before: '0', after: '5' }]);
    expect(fixture.adapterVersion(preview)).toBe('customer/safe-v5');
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'customer-discount-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent().discount).toBe('5.00');
  });

  it('verifies a sales-order exchange rate the provider echoes at ten decimals and treats a repeat as unchanged', async () => {
    const order = { salesOrderId: 'so-1', customerId: 'c-1', orderNumber: 'SO-1', exchangeRate: '1.0000000000', lines: [], timestamp: 't-1', customFields: {} };
    const fixture = await harness('set_sales_order', order);
    const request = { salesOrderId: 'so-1', mode: 'patch', values: { exchangeRate: 1.25 } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'so-rate-1' });
    expect(fixture.adapterVersion(preview)).toBe('sales-order/safe-v5');
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'so-rate-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent().exchangeRate).toBe('1.2500000000');
    const repeat = await fixture.call({ ...request, values: { exchangeRate: '1.25' }, dryRun: true, idempotencyKey: 'so-rate-2' });
    expect(repeat.diff.operations).toEqual([]);
    expect(await fixture.apply(request, { ...repeat, idempotencyKey: 'so-rate-2' })).toMatchObject({ applicationState: 'no_op' });
  });

  it('verifies nested sales-order line quantities and prices the provider echoes at four and five decimals', async () => {
    const line = { salesOrderLineId: 'l-1', productId: 'p-1', quantity: { standardQuantity: '1.0000', uomQuantity: '1.0000', uom: 'ea' }, unitPrice: '12.50000' };
    const order = { salesOrderId: 'so-1', customerId: 'c-1', orderNumber: 'SO-1', lines: [line], timestamp: 't-1', customFields: {} };
    const fixture = await harness('set_sales_order', order);
    const request = {
      salesOrderId: 'so-1', mode: 'patch',
      values: { lines: [{ salesOrderLineId: 'l-1', productId: 'p-1', quantity: { standardQuantity: 2, uomQuantity: 2, uom: 'ea' }, unitPrice: 12.5 }] },
    };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'so-lines-1' });
    expect(preview.diff.operations.map((operation: { path: string }) => operation.path).sort())
      .toEqual(['/lines/0/quantity/standardQuantity', '/lines/0/quantity/uomQuantity']);
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'so-lines-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(fixture.getCurrent().lines[0]).toMatchObject({ quantity: { standardQuantity: '2.0000', uomQuantity: '2.0000' }, unitPrice: '12.50000' });
  });

  it('verifies a stock-adjustment line quantity the provider echoes at four decimals', async () => {
    const adjustment = {
      stockAdjustmentId: 'sa-1', locationId: 'loc-1', timestamp: 't-1', customFields: {},
      lines: [{ stockAdjustmentLineId: 'al-1', productId: 'p-1', quantity: { standardQuantity: '-1.0000', uomQuantity: '-1.0000', uom: 'ea' } }],
    };
    const fixture = await harness('set_stock_adjustment', adjustment);
    const request = {
      stockAdjustmentId: 'sa-1', mode: 'patch',
      values: { lines: [{ stockAdjustmentLineId: 'al-1', productId: 'p-1', quantity: { standardQuantity: -2, uomQuantity: -2, uom: 'ea' } }] },
    };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'sa-lines-1' });
    expect(fixture.adapterVersion(preview)).toBe('stock-adjustment/safe-v5');
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'sa-lines-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_verified', verified: true });
  });

  it('still reports a mismatch when the provider stores a different decimal', async () => {
    const fixture = await harness('set_vendor', { vendorId: 'v-1', name: 'Supplier', discount: '0.00', timestamp: 't-1', customFields: {} });
    const request = { vendorId: 'v-1', mode: 'patch', values: { discount: 5 } };
    const preview = await fixture.call({ ...request, dryRun: true, idempotencyKey: 'vendor-discount-1' });
    fixture.prepareMutation.mockImplementationOnce(async () => ({
      correlationId: 'correlation-drift',
      dispatch: async () => ({ vendorId: 'v-1', name: 'Supplier', discount: '4.00', timestamp: 't-2', customFields: {} }),
    }));
    const applied = await fixture.apply(request, { ...preview, idempotencyKey: 'vendor-discount-1' });
    expect(applied).toMatchObject({ applicationState: 'applied_unverified', error: { code: 'VERIFICATION_MISMATCH' } });
  });

  it('leaves the adapters without decimal fields on their previous version', async () => {
    const fixture = await harness('set_stock_count', { stockCountId: 'sc-1', locationId: 'loc-1', remarks: '', timestamp: 't-1' });
    const preview = await fixture.call({ stockCountId: 'sc-1', mode: 'patch', values: { remarks: 'counted' }, dryRun: true, idempotencyKey: 'sc-1' });
    expect(fixture.adapterVersion(preview)).toBe('stock-count/safe-v2');
  });
});
