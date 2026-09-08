import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { Product } from '../types/inflow.js';
import {
  assertManufacturingApiVersion,
  buildDesiredProduct,
  manufacturingConfigHash,
  normalizeDecimal,
  normalizeManufacturingProduct,
  registerProductManufacturingTools,
  validateComponentsAndCycles,
  validateDesiredLocally,
} from './product-manufacturing.js';

function product(overrides: Partial<Product> = {}): Product {
  return {
    productId: 'parent',
    name: 'Parent',
    isActive: true,
    isManufacturable: false,
    timestamp: 'ts-1',
    autoAssemble: false,
    includeQuantityBuildable: false,
    itemBoms: [
      {
        itemBomId: 'bom-1',
        productId: 'parent',
        childProductId: 'child-1',
        childProduct: {
          productId: 'child-1',
          name: 'Child One',
          sku: 'C1',
          isActive: true,
        },
        quantity: { standardQuantity: '1.00', uomQuantity: '1.00' },
        timestamp: 'bom-ts-1',
      },
    ],
    productOperations: [],
    ...overrides,
  };
}

function mockClient(initial: Product, children: Record<string, Product> = {}) {
  let current = structuredClone(initial);
  const get = vi.fn(async (path: string) => {
    const id = path.split('/').at(-1)!;
    if (id === current.productId) return structuredClone(current);
    const child = children[id];
    if (!child) throw new Error(`missing ${id}`);
    return structuredClone(child);
  });
  const put = vi.fn(async (_path: string, body: Partial<Product>) => {
    current = {
      ...current,
      ...structuredClone(body),
      timestamp: 'ts-2',
      itemBoms: body.itemBoms ?? current.itemBoms,
      productOperations: body.productOperations ?? current.productOperations,
    };
    return structuredClone(current);
  });
  const prepareMutation = vi.fn(async (
    _method: string,
    path: string,
    options: { body: Partial<Product> }
  ) => ({
    dispatch: () => put(path, options.body),
  }));
  return {
    client: { get, put, prepareMutation } as unknown as InflowClient,
    get,
    put,
    prepareMutation,
    current: () => current,
  };
}

function config(stateDir: string, apiVersion = '2026-04-13', safeWritesEnabled = true): InflowConfig {
  return {
    companyId: 'company',
    apiKey: 'secret',
    baseUrl: 'https://api.test',
    apiVersion,
    rateLimitPerMinute: 60,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryDelayMs: 1,
    readRetryBudgetMs: 1_000,
    debug: false,
    stateDir,
    adapterManifestHash: 'a'.repeat(64),
    probeBuild: 'b'.repeat(64),
    enableLegacyWrites: false,
    safeWritesEnabled,
    stockWritesEnabled: false,
    writeGates: {
      manufacturing: false,
      'manufacturing-pick-batch-v1': false,
      prices: false,
      'product-groups': false,
      'mo-serials': false,
      standard: false,
    },
  };
}

async function registeredHarness(
  initial: Product,
  children: Record<string, Product> = {},
  apiVersion = '2026-04-13',
  safeWritesEnabled = true
) {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-manufacturing-tool-'));
  await chmod(stateDir, 0o700);
  const fixture = mockClient(initial, children);
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: any) => Promise<any>
    ) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerProductManufacturingTools(server, fixture.client, config(stateDir, apiVersion, safeWritesEnabled));
  return {
    ...fixture,
    handler: handlers.set_product_manufacturing_config!,
    handlers,
    stateDir,
  };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

function applyInput(preview: Record<string, any>, extra: Record<string, unknown>) {
  return {
    ...extra,
    dryRun: false,
    previewToken: preview.previewToken,
    idempotencyKey: preview.idempotencyKey,
    expectedSemanticHash: preview.currentSemanticHash,
    expectedWriteShapeHash: preview.currentWriteShapeHash,
    expectedEntityTimestamp: preview.entityTimestamp,
    expectedDesiredHash: preview.desiredHash,
    confirmation: {
      scope: preview.confirmationScope,
      confirmationHash: preview.confirmationHash,
    },
  };
}

describe('manufacturing normalization and hashing', () => {
  it('returns real BOM rows even when the derived manufacturable flag is false', () => {
    const envelope = normalizeManufacturingProduct(product());
    expect(envelope.isManufacturable).toBe(false);
    expect(envelope.componentCount).toBe(1);
    expect(envelope.components[0]).toMatchObject({
      itemBomId: 'bom-1',
      childProductId: 'child-1',
      childProductName: 'Child One',
      quantity: '1',
      uomQuantity: '1',
      uom: null,
    });
  });

  it('canonicalizes decimal values without floating-point conversion', () => {
    expect(normalizeDecimal('00012.3400')).toBe('12.34');
    expect(normalizeDecimal('.5000')).toBe('0.5');
    expect(normalizeDecimal('-0.000')).toBe('0');
    expect(() => normalizeDecimal('1e3')).toThrow(/Invalid decimal/);
  });

  it('ignores row IDs, timestamps, names, and ordering in the config hash', () => {
    const first = normalizeManufacturingProduct(product());
    const second = normalizeManufacturingProduct(
      product({
        timestamp: 'other',
        itemBoms: [
          {
            itemBomId: 'other-id',
            childProductId: 'child-1',
            childProduct: { productId: 'child-1', name: 'Renamed' },
            quantity: { standardQuantity: '1.0000' },
            timestamp: 'other-row-ts',
          },
        ],
      })
    );
    expect(manufacturingConfigHash(first)).toBe(manufacturingConfigHash(second));
  });

  it('includes the display-unit quantity in the config hash', () => {
    const first = normalizeManufacturingProduct(product());
    const second = normalizeManufacturingProduct(
      product({
        itemBoms: [
          {
            childProductId: 'child-1',
            quantity: {
              standardQuantity: '1',
              uomQuantity: '0.5',
              uom: 'Box',
            },
          },
        ],
      })
    );
    expect(manufacturingConfigHash(first)).not.toBe(
      manufacturingConfigHash(second)
    );
  });

  it('fails closed on older API versions', () => {
    expect(() => assertManufacturingApiVersion('2025-06-24')).toThrow(
      /UNSUPPORTED_API_VERSION/
    );
    expect(() => assertManufacturingApiVersion('2026-04-13')).not.toThrow();
  });

  it('keeps the existing BOM read available under the rollback API version', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    const get = vi.fn(async () =>
      product({ itemBoms: [], productOperations: undefined })
    );
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-manufacturing-rollback-'));
    await chmod(stateDir, 0o700);
    registerProductManufacturingTools(
      server,
      { get } as unknown as InflowClient,
      config(stateDir, '2025-06-24')
    );

    await expect(
      handlers.get_bill_of_materials({ productId: 'parent' })
    ).resolves.toBeTruthy();
    expect(get).toHaveBeenCalledWith('/products/parent', {
      include: ['itemBoms'],
    });
    await expect(
      handlers.compare_product_boms({ productIds: ['a', 'b'] })
    ).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
    await expect(
      handlers.set_product_manufacturing_config({
        productId: 'parent',
        mode: 'patch',
        dryRun: true,
      })
    ).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
  });
});

describe('desired-state merge', () => {
  it('patches a component by childProductId and reuses row metadata', () => {
    const desired = buildDesiredProduct(product(), {
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: '2' }],
    });
    expect(desired.itemBoms?.[0]).toMatchObject({
      itemBomId: 'bom-1',
      timestamp: 'bom-ts-1',
      childProductId: 'child-1',
      quantity: { standardQuantity: '2' },
    });
  });

  it('requires an explicit display quantity when changing a non-identity UOM ratio', () => {
    const current = product({
      itemBoms: [
        {
          itemBomId: 'bom-1',
          childProductId: 'child-1',
          quantity: {
            standardQuantity: '1',
            uomQuantity: '0.5',
            uom: 'Box',
            serialNumbers: ['definition-metadata'],
          },
          timestamp: 'bom-ts-1',
        },
      ],
    });
    expect(() =>
      buildDesiredProduct(current, {
        productId: 'parent',
        mode: 'patch',
        components: [
          { itemBomId: 'bom-1', childProductId: 'child-1', quantity: '2' },
        ],
      })
    ).toThrow(/uomQuantity is required/);

    const preserved = buildDesiredProduct(current, {
      productId: 'parent',
      mode: 'patch',
      components: [
        {
          itemBomId: 'bom-1',
          childProductId: 'child-1',
          quantity: '2',
          uomQuantity: '1',
        },
      ],
    });
    expect(preserved.itemBoms?.[0]?.quantity).toEqual({
      standardQuantity: '2',
      uomQuantity: '1',
      uom: 'Box',
      serialNumbers: ['definition-metadata'],
    });

    const cleared = buildDesiredProduct(current, {
      productId: 'parent',
      mode: 'patch',
      components: [
        { itemBomId: 'bom-1', childProductId: 'child-1', quantity: '2', uom: null },
      ],
    });
    expect(cleared.itemBoms?.[0]?.quantity?.uom).toBe('');
  });

  it('resets the display quantity when clearing a UOM without changing quantity', () => {
    const current = product({
      itemBoms: [
        {
          itemBomId: 'bom-1',
          childProductId: 'child-1',
          quantity: {
            standardQuantity: '12',
            uomQuantity: '1',
            uom: 'Box',
          },
        },
      ],
    });
    const desired = buildDesiredProduct(current, {
      productId: 'parent',
      mode: 'patch',
      components: [
        {
          itemBomId: 'bom-1',
          childProductId: 'child-1',
          quantity: '12',
          uom: null,
        },
      ],
    });
    expect(desired.itemBoms?.[0]?.quantity).toMatchObject({
      standardQuantity: '12',
      uomQuantity: '12',
      uom: '',
    });
  });

  it('requires an explicit display quantity when adding a UOM', () => {
    expect(() =>
      buildDesiredProduct(product({ itemBoms: [] }), {
        productId: 'parent',
        mode: 'patch',
        components: [
          { childProductId: 'child-1', quantity: '12', uom: 'Box' },
        ],
      })
    ).toThrow(/uomQuantity is required/);

    expect(
      buildDesiredProduct(product({ itemBoms: [] }), {
        productId: 'parent',
        mode: 'patch',
        components: [
          {
            childProductId: 'child-1',
            quantity: '12',
            uomQuantity: '1',
            uom: 'Box',
          },
        ],
      }).itemBoms?.[0]?.quantity
    ).toMatchObject({ standardQuantity: '12', uomQuantity: '1', uom: 'Box' });
  });

  it('rejects non-positive display quantities', () => {
    expect(() =>
      validateDesiredLocally('parent', buildDesiredProduct(product({ itemBoms: [] }), {
        productId: 'parent',
        mode: 'patch',
        components: [
          {
            childProductId: 'child-1',
            quantity: '1',
            uomQuantity: '0',
          },
        ],
      }))
    ).toThrow(/positive finite/);
  });

  it('rejects a differing display quantity without a UOM', () => {
    expect(() =>
      validateDesiredLocally('parent', buildDesiredProduct(product({ itemBoms: [] }), {
        productId: 'parent',
        mode: 'patch',
        components: [
          {
            childProductId: 'child-1',
            quantity: '12',
            uomQuantity: '1',
          },
        ],
      }))
    ).toThrow(/without a UOM/);
  });

  it('preserves unmentioned operation fields and honors supported clears', () => {
    const current = product({
      productOperations: [
        {
          productOperationId: 'op-1',
          productId: 'parent',
          operationTypeId: 'type-1',
          lineNum: 4,
          cost: '1.25',
          estimatedPerHourCost: '20',
          estimatedSeconds: '60',
          instructions: 'Old',
          trackTime: true,
          timestamp: 'op-ts-1',
        },
      ],
    });
    const preserved = buildDesiredProduct(current, {
      productId: 'parent',
      mode: 'patch',
      productOperations: [
        {
          productOperationId: 'op-1',
          operationTypeId: 'type-1',
          instructions: 'New',
        },
      ],
    });
    expect(preserved.productOperations?.[0]).toMatchObject({
      lineNum: 4,
      cost: '1.25',
      estimatedPerHourCost: '20',
      estimatedSeconds: '60',
      instructions: 'New',
      trackTime: true,
      timestamp: 'op-ts-1',
    });

    const cleared = buildDesiredProduct(current, {
      productId: 'parent',
      mode: 'patch',
      productOperations: [
        {
          productOperationId: 'op-1',
          operationTypeId: 'type-1',
          cost: null,
          instructions: '',
          trackTime: false,
        },
      ],
    });
    expect(cleared.productOperations?.[0]?.cost).toBeNull();
    expect(cleared.productOperations?.[0]?.trackTime).toBe(false);
    expect(cleared.productOperations?.[0]?.instructions).toBe('');
  });

  it('replace preserves operations when they are omitted and clears them when [] is supplied', () => {
    const current = product({
      productOperations: [
        {
          productOperationId: 'op-1',
          operationTypeId: 'type-1',
          lineNum: 1,
        },
      ],
    });
    expect(
      buildDesiredProduct(current, {
        productId: 'parent',
        mode: 'replace',
        components: [],
      }).productOperations
    ).toHaveLength(1);
    expect(
      buildDesiredProduct(current, {
        productId: 'parent',
        mode: 'replace',
        components: [],
        productOperations: [],
      }).productOperations
    ).toEqual([]);
  });

  it('rejects unknown removals and duplicate resulting child products', async () => {
    expect(() =>
      buildDesiredProduct(product(), {
        productId: 'parent',
        mode: 'patch',
        removeItemBomIds: ['missing'],
      })
    ).toThrow(/Unknown itemBomId removal/);

    expect(() =>
      validateDesiredLocally(
        'parent',
        buildDesiredProduct(product(), {
          productId: 'parent',
          mode: 'replace',
          components: [
            { childProductId: 'child-1', quantity: 1 },
            { childProductId: 'child-1', quantity: 2 },
          ],
        })
      )
    ).toThrow(/Duplicate child products/);
  });
});

describe('explicit confirmation preview/apply workflow', () => {
  const child = product({
    productId: 'child-1',
    name: 'Child',
    timestamp: 'child-ts',
    itemBoms: [],
  });

  it('previews without PUT and exposes a closed full-scope confirmation', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child });
    const preview = payload(await fixture.handler({
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
      dryRun: true,
    }));

    expect(preview).toMatchObject({
      applicationState: 'preview',
      applied: false,
      resourceId: 'parent',
      confirmationScope: {
        schemaVersion: 'explicit-confirmation-scope/v1',
        tenantFingerprint: expect.stringMatching(/^[a-f0-9]{24}$/),
        baseHost: 'api.test',
        apiVersion: '2026-04-13',
        serverBuildIdentity: 'a'.repeat(64),
        operation: 'set_product_manufacturing_config',
        resourceType: 'product-manufacturing-config',
        resourceId: 'parent',
        mode: 'patch',
        currentSemanticHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        currentWriteShapeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        desiredHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceHashes: [],
      },
      confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects apply without confirmation even when the retired environment gate is true', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child });
    const preview = payload(await fixture.handler({
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
      dryRun: true,
    }));
    await expect(fixture.handler({
      ...applyInput(preview, {
        productId: 'parent',
        mode: 'patch',
        components: [{ childProductId: 'child-1', quantity: 2 }],
      }),
      confirmation: undefined,
    })).rejects.toThrow(/USER_CONFIRMATION_REQUIRED/);
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects malformed, shortened, and mismatched confirmation before PUT', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child });
    const request = {
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));

    for (const confirmation of [
      { scope: { ...preview.confirmationScope, extra: true }, confirmationHash: preview.confirmationHash },
      { scope: preview.confirmationScope, confirmationHash: preview.confirmationHash.slice(0, 12) },
      { scope: preview.confirmationScope, confirmationHash: preview.confirmationHash.toUpperCase() },
      { scope: preview.confirmationScope, confirmationHash: 'f'.repeat(64) },
    ]) {
      await expect(fixture.handler({
        ...applyInput(preview, request),
        confirmation,
      })).rejects.toThrow(/USER_CONFIRMATION_SCOPE_MISMATCH/);
    }
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('applies one narrow PUT with exact confirmation and verifies readback', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child });
    const request = {
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));
    const applied = payload(await fixture.handler(applyInput(preview, request)));

    expect(applied).toMatchObject({
      applicationState: 'applied_verified',
      applied: true,
      verified: true,
      confirmationValidated: true,
      confirmationHash: preview.confirmationHash,
    });
    expect(fixture.put).toHaveBeenCalledTimes(1);
    expect(fixture.put.mock.calls[0]![1]).toMatchObject({
      productId: 'parent',
      timestamp: 'ts-1',
    });
    expect(fixture.put.mock.calls[0]![1]).not.toHaveProperty('name');
    expect(fixture.put.mock.calls[0]![1]).not.toHaveProperty('isManufacturable');
  });

  it('requires exact confirmation before returning an apply no-op', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child });
    const request = {
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 1 }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));
    await expect(fixture.handler({
      ...applyInput(preview, request),
      confirmation: undefined,
    })).rejects.toThrow(/USER_CONFIRMATION_REQUIRED/);

    const result = payload(await fixture.handler(applyInput(preview, request)));
    expect(result).toMatchObject({
      applicationState: 'no_op',
      applied: false,
      verified: true,
      confirmationValidated: true,
    });
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('requires the master safe-write gate in addition to exact confirmation', async () => {
    const fixture = await registeredHarness(product(), { 'child-1': child }, '2026-04-13', false);
    const request = {
      productId: 'parent',
      mode: 'patch' as const,
      components: [{ childProductId: 'child-1', quantity: 2 }],
    };
    const preview = payload(await fixture.handler({ ...request, dryRun: true }));

    await expect(fixture.handler(applyInput(preview, request))).rejects.toThrow(
      /SAFE_WRITES_DISABLED/
    );
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects inactive components and indirect cycles during preview', async () => {
    const inactiveFixture = await registeredHarness(product(), {
      'child-1': product({
        productId: 'child-1',
        name: 'Inactive Child',
        isActive: false,
        itemBoms: [],
      }),
    });
    await expect(inactiveFixture.handler({
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
      dryRun: true,
    })).rejects.toThrow(/Inactive component/);

    const cycleFixture = await registeredHarness(product(), {
      'child-1': product({
        productId: 'child-1',
        name: 'Child',
        itemBoms: [{ childProductId: 'parent', quantity: { standardQuantity: '1' } }],
      }),
    });
    await expect(cycleFixture.handler({
      productId: 'parent',
      mode: 'patch',
      components: [{ childProductId: 'child-1', quantity: 2 }],
      dryRun: true,
    })).rejects.toThrow(/Indirect BOM cycle/);
  });
});
