import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { canonicalHash } from '../core/canonical-json.js';
import { MutationJournal, type MutationJournalRecord } from '../core/mutation-journal.js';
import { priceSemantic, type ProductPriceState } from '../services/product-prices.js';
import { productWriteSemantic } from './safe-standard-writes.js';
import {
  mutationStatusEnvelope,
  reconcileMutation,
  registerStatusTools,
} from './status.js';

describe('mutation status reconciliation', () => {
  it('reconciles an ambiguous bounded product mutation without redispatch', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-product-status-'));
    await chmod(stateDir, 0o700);
    const journal = new MutationJournal(stateDir);
    const state = {
      productId: 'p-1', name: 'Product', sku: 'SKU', isActive: true, timestamp: 't-2',
      customFields: { custom1: 'https://admin.shopify.com/store/example/products/1', custom2: 'preserved' },
    };
    const adapterVersion = 'product/safe-v2';
    const desiredHash = canonicalHash(productWriteSemantic(state), `semantic/product/${adapterVersion}`);
    const record: MutationJournalRecord = {
      schemaVersion: 'mutation-journal/v1', operationId: 'op-product-1', tenantFingerprint: 'tenant',
      resourceType: 'product', resourceId: 'p-1', adapterVersion, desiredHash,
      state: 'unknown_after_write', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      affectedResources: [{ type: 'product', id: 'p-1' }], invalidationTags: ['product:p-1'],
      steps: [{ stepId: 'write', kind: 'apply', intentHash: desiredHash, plannedIds: [], state: 'unknown', updatedAt: new Date().toISOString(), invalidationTags: ['product:p-1'] }],
    };
    await journal.put(record);
    const client = { get: vi.fn(async () => ({ ...state })) } as unknown as InflowClient;
    const result = await reconcileMutation(client, journal, record);
    expect(client.get).toHaveBeenCalledWith('/products/p-1');
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: true, provenState: 'applied_verified' });
    expect(result.record.state).toBe('applied_verified');
  });

  it('advances an ambiguous supported mutation only after desired-state readback', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-status-'));
    await chmod(stateDir, 0o700);
    const journal = new MutationJournal(stateDir);
    const state: ProductPriceState = {
      productId: 'p-1', name: 'Product', sku: 'SKU', isActive: true, timestamp: 't-2',
      prices: [{ productPriceId: 'price-1', productId: 'p-1', pricingSchemeId: 'scheme-1', unitPrice: '12.00' }],
    };
    const adapterVersion = 'product-prices/v1';
    const desiredHash = canonicalHash(priceSemantic(state), `semantic/product-prices/${adapterVersion}`);
    const record: MutationJournalRecord = {
      schemaVersion: 'mutation-journal/v1', operationId: 'op-1', tenantFingerprint: 'tenant',
      resourceType: 'product-prices', resourceId: 'p-1', adapterVersion, desiredHash,
      state: 'unknown_after_write', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      affectedResources: [{ type: 'product', id: 'p-1' }], invalidationTags: ['prices:p-1'],
      steps: [{ stepId: 'write', kind: 'apply', intentHash: desiredHash, plannedIds: [], state: 'unknown', updatedAt: new Date().toISOString(), invalidationTags: ['prices:p-1'] }],
    };
    await journal.put(record);
    const client = { get: vi.fn(async () => ({ ...state })) } as unknown as InflowClient;
    const result = await reconcileMutation(client, journal, record);
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: true, provenState: 'applied_verified' });
    expect(result.record.state).toBe('applied_verified');
    expect(result.record.steps[0].state).toBe('verified');
    expect(mutationStatusEnvelope(result.record)).toMatchObject({
      schemaVersion: 'mutation/v1',
      applicationState: 'applied_verified',
      applied: true,
      verified: true,
      completedSteps: ['write'],
    });
  });

  it('reports status v2 with explicit product-manufacturing policy and the dedicated pick-batch gate', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-status-gates-'));
    await chmod(stateDir, 0o700);
    let statusHandler:
      | ((input: { probeApi: boolean }) => Promise<{
          content: Array<{ type: string; text: string }>;
        }>)
      | undefined;
    const server = {
      tool: vi.fn(
        (
          name: string,
          _description: string,
          _schema: unknown,
          handler: typeof statusHandler
        ) => {
          if (name === 'get_mcp_status') statusHandler = handler;
        }
      ),
    };
    const config = {
      companyId: 'company',
      apiKey: 'secret',
      baseUrl: 'https://example.test',
      apiVersion: '2026-04-13',
      rateLimitPerMinute: 20,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      retryDelayMs: 1,
      readRetryBudgetMs: 1_000,
      debug: false,
      stateDir,
      adapterManifestHash: 'adapter-sha',
      probeBuild: 'probe-sha',
      enableLegacyWrites: false,
      safeWritesEnabled: true,
      stockWritesEnabled: false,
      writeGates: {
        manufacturing: false,
        'manufacturing-pick-batch-v1': true,
        prices: true,
        'product-groups': true,
        'mo-serials': true,
        standard: true,
      },
    } satisfies InflowConfig;
    const client = {
      telemetrySnapshot: vi.fn(() => ({
        timeoutMs: 1_000,
        readRetryPolicy: { maxRetries: 0, baseDelayMs: 1 },
        mutationRetryPolicy: { maxRetries: 0 },
        rateLimiter: {
          capacity: 20,
          availableTokens: 20,
          queued: 0,
          refillPerSecond: 1 / 3,
          scope: 'process-local',
        },
      })),
    } as unknown as InflowClient;
    registerStatusTools(server as never, client, config);

    expect(statusHandler).toBeTypeOf('function');
    const result = await statusHandler!({ probeApi: false });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.schemaVersion).toBe('mcp-status/v2');
    expect(payload.legacyBypassActive).toBe(true);
    expect(payload.gates).not.toHaveProperty('manufacturing');
    expect(payload.gates).toHaveProperty('manufacturing-pick-batch-v1');
    expect(payload.gates['manufacturing-pick-batch-v1']).toMatchObject({
      domain: 'manufacturing-pick-batch-v1',
      masterEnabled: true,
      stockEnabled: false,
      coordinatorEnvironmentEnabled: true,
      enabled: false,
    });
    expect(payload.gates.prices).toMatchObject({
      domain: 'prices',
      environmentEnabled: true,
      attestationState: 'deprecated',
      enabled: false,
      deprecated: true,
      reasonCode: 'DEPRECATED_GATE_IGNORED',
      replacement: 'INFLOW_ENABLE_SAFE_WRITES',
    });
    expect(payload.writePolicies.safe).toMatchObject({
      mode: 'preview-apply',
      previewsAvailable: true,
      legacyWritesAffected: false,
      master: {
        environmentVariable: 'INFLOW_ENABLE_SAFE_WRITES',
        environmentEnabled: true,
        effectiveApplyEnabled: true,
      },
      stock: {
        environmentVariable: 'INFLOW_ENABLE_STOCK_WRITES',
        environmentEnabled: false,
        effectiveApplyEnabled: false,
      },
    });
    expect(payload.writePolicies.safe.operations.set_product_prices).toMatchObject({
      classification: 'ordinary',
      staticSupport: true,
      idempotency: 'replacement-optional',
      effectiveApplyEnabled: true,
    });
    expect(payload.writePolicies.safe.operations.set_product).toMatchObject({
      classification: 'ordinary',
      staticSupport: true,
      idempotency: 'create-only',
      effectiveApplyEnabled: true,
    });
    expect(payload.writePolicies.safe.operations.reconcile_manufacturing_order_serials).toMatchObject({
      classification: 'stock',
      staticSupport: false,
      effectiveApplyEnabled: false,
    });
    expect(payload.writePolicies.safe.operations['manufacturing-pick-batch-v1']).toMatchObject({
      classification: 'coordinator',
      staticSupport: true,
      effectiveApplyEnabled: false,
    });
    expect(payload.writePolicies.productManufacturing).toMatchObject({
      mode: 'explicit-confirmation',
      previewRequired: true,
      masterGateRequired: true,
      effectiveApplyEnabled: true,
      confirmationScope: 'full-preview-state',
      trustBoundary: 'caller-asserted-scope-confirmation',
      humanIdentityAuthenticated: false,
    });
    expect(payload.deprecatedGates.manufacturing).toMatchObject({
      status: 'retired-for-product-manufacturing',
      replacement: 'writePolicies.productManufacturing',
    });
    expect(payload.deprecatedGates.standard).toMatchObject({
      status: 'deprecated-disabled',
      replacement: 'per-operation classification under writePolicies.safe.operations',
    });
  });
});
