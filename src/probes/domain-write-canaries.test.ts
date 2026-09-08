import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InflowApiError, type InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { ManufacturingOrder, Product, ProductGroup } from '../types/inflow.js';
import {
  manufacturingOperationCompletionStateHash,
  planManufacturingRunBegin,
} from '../services/manufacturing-run-planner.js';
import {
  runApprovedMoSerialCanary,
  runApprovedOperationCompletionCanary,
  runApprovedProductGroupCanary,
} from './domain-write-canaries.js';

type CanaryClient = Pick<InflowClient, 'get' | 'put'>;

function concurrencyError(): InflowApiError {
  return new InflowApiError('Timestamp conflict', 409, {
    code: 'timestamp_conflict',
    message: 'The row version has changed',
  });
}

describe('domain release canaries', () => {
  it('fails closed before writing when the approved resource does not match', async () => {
    const put = vi.fn();
    await expect(runApprovedProductGroupCanary('group-1', {
      client: { get: vi.fn(), put } as unknown as CanaryClient,
      env: {
        INFLOW_CANARY_APPROVED: 'true',
        INFLOW_CANARY_RESOURCE_ID: 'different-group',
      },
    })).rejects.toThrow('INFLOW_CANARY_RESOURCE_ID');
    expect(put).not.toHaveBeenCalled();
  });

  it('proves the product-group matrix, restores the group, and only deactivates the residual product', async () => {
    let group: ProductGroup = {
      productGroupId: 'group-1',
      name: '__CANARY_GROUP__',
      isActive: false,
      options: [],
      productVariants: [],
      timestamp: 'group-ts-1',
    };
    const products = new Map<string, Product>();
    let groupRevision = 1;
    let productRevision = 0;

    const get = vi.fn(async (path: string) => {
      if (path === '/product-groups/group-1') return structuredClone(group);
      if (path.startsWith('/products/')) {
        const product = products.get(path.slice('/products/'.length));
        if (!product) throw new Error(`missing ${path}`);
        return structuredClone(product);
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const put = vi.fn(async (path: string, raw: unknown) => {
      const body = structuredClone(raw) as Record<string, unknown>;
      if (path === '/product-groups') {
        if (body.timestamp !== group.timestamp) throw concurrencyError();
        groupRevision += 1;
        group = { ...(body as ProductGroup), timestamp: `group-ts-${groupRevision}` };
        return structuredClone(group);
      }
      if (path === '/products') {
        const productId = String(body.productId);
        const existing = products.get(productId);
        productRevision += 1;
        const product = {
          ...(existing ?? {}),
          ...body,
          productId,
          name: String(body.name ?? existing?.name ?? '__CANARY_VARIANT_PRODUCT__'),
          timestamp: `product-ts-${productRevision}`,
        } as Product;
        products.set(productId, product);
        return structuredClone(product);
      }
      throw new Error(`unexpected PUT ${path}`);
    });
    const uuids = [
      'product-1', 'option-a', 'value-a1', 'value-a2', 'variant-1',
      'option-b', 'value-b1', 'stale-option', 'stale-value',
    ];

    const result = await runApprovedProductGroupCanary('group-1', {
      client: { get, put } as unknown as CanaryClient,
      env: {
        INFLOW_CANARY_APPROVED: 'true',
        INFLOW_CANARY_RESOURCE_ID: 'group-1',
        INFLOW_CANARY_PRODUCT_GROUP_FIXTURE: JSON.stringify({
          expectedTimestamp: 'group-ts-1',
          expectedName: '__CANARY_GROUP__',
          productName: '__CANARY_VARIANT_PRODUCT__',
          productSku: 'CANARY-VARIANT-SKU',
        }),
      },
      uuid: () => uuids.shift()!,
    });

    expect(result).toMatchObject({
      evidenceType: 'release-canary/v1',
      passed: true,
      staleTimestampRejected: true,
      fullArrayPreserved: true,
      deterministicIdsRetained: true,
      productCompensationVerified: true,
      cleanupSucceeded: true,
    });
    expect(result).not.toHaveProperty('attestationIssued');
    expect(group).toMatchObject({
      productGroupId: 'group-1',
      name: '__CANARY_GROUP__',
      isActive: false,
      options: [],
      productVariants: [],
    });
    expect(products.get('product-1')).toMatchObject({ isActive: false });
    const groupBodies = put.mock.calls
      .filter(([path]) => path === '/product-groups')
      .map(([, body]) => body as ProductGroup);
    expect(groupBodies.length).toBeGreaterThan(4);
    expect(groupBodies.every((body) => Boolean(body.timestamp) && Array.isArray(body.options) && Array.isArray(body.productVariants))).toBe(true);
    expect(put.mock.calls.some(([path]) => path === '/products/product-1')).toBe(false);
  });

  it('proves serial add/swap/remove, stale rejection, preservation, and net-zero stock restoration', async () => {
    let order: ManufacturingOrder = {
      manufacturingOrderId: 'mo-1',
      manufacturingOrderNumber: 'MO-CANARY-1',
      status: 'open',
      isCompleted: false,
      isCancelled: false,
      remarks: '',
      timestamp: 'mo-ts-1',
      lines: [{
        manufacturingOrderLineId: 'line-1',
        parentManufacturingOrderLineId: null,
        productId: 'component-1',
        quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
      }],
      pickLines: [{
        manufacturingOrderPickLineId: 'pick-1',
        productId: 'component-1',
        locationId: 'location-1',
        sublocation: 'A1',
        quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
      }],
      pickMatchings: [{
        manufacturingOrderPickMatchingId: 'matching-1',
        manufacturingOrderLineId: 'line-1',
        manufacturingOrderPickLineId: 'pick-1',
        matchedQuantity: '1',
      }],
      putLines: [],
    };
    let revision = 1;
    const inventoryProduct = (): Product => {
      const picked = new Set((order.pickLines ?? []).flatMap((row) => row.quantity?.serialNumbers ?? []));
      return {
        productId: 'component-1',
        name: '__CANARY_SERIAL_COMPONENT__',
        isActive: false,
        inventoryLines: ['CANARY-SERIAL-A', 'CANARY-SERIAL-B'].map((serial) => ({
          serial,
          locationId: 'location-1',
          sublocation: 'A1',
          quantityOnHand: picked.has(serial) ? '0' : '1',
        })),
      };
    };
    const get = vi.fn(async (path: string) => {
      if (path === '/manufacturing-orders/mo-1') return structuredClone(order);
      if (path === '/products/component-1') return structuredClone(inventoryProduct());
      throw new Error(`unexpected GET ${path}`);
    });
    const put = vi.fn(async (path: string, raw: unknown) => {
      if (path !== '/manufacturing-orders') throw new Error(`unexpected PUT ${path}`);
      const body = structuredClone(raw) as ManufacturingOrder;
      if (body.timestamp !== order.timestamp) throw concurrencyError();
      revision += 1;
      order = { ...body, timestamp: `mo-ts-${revision}` };
      return structuredClone(order);
    });
    let id = 0;

    const result = await runApprovedMoSerialCanary('mo-1', {
      client: { get, put } as unknown as CanaryClient,
      env: {
        INFLOW_CANARY_APPROVED: 'true',
        INFLOW_CANARY_RESOURCE_ID: 'mo-1',
        INFLOW_CANARY_MO_SERIAL_FIXTURE: JSON.stringify({
          expectedTimestamp: 'mo-ts-1',
          lineId: 'line-1',
          pickLineId: 'pick-1',
          productId: 'component-1',
          serialA: 'CANARY-SERIAL-A',
          serialB: 'CANARY-SERIAL-B',
          locationId: 'location-1',
          sublocation: 'A1',
          expectedRemarks: '',
        }),
      },
      uuid: () => `generated-${++id}`,
    });

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
      evidenceType: 'release-canary/v1',
      passed: true,
      addWorked: true,
      swapWorked: true,
      removeWorked: true,
      inventoryMovementVerified: true,
      staleTimestampRejected: true,
      concurrentUnrelatedEditPreserved: true,
      netZeroReversalVerified: true,
      cleanupSucceeded: true,
    });
    expect(result).not.toHaveProperty('attestationIssued');
    expect(order).toMatchObject({
      remarks: '',
      lines: expect.any(Array),
      pickLines: [expect.objectContaining({ quantity: expect.objectContaining({ serialNumbers: [] }) })],
      pickMatchings: [expect.objectContaining({ manufacturingOrderPickMatchingId: 'matching-1' })],
    });
    expect(inventoryProduct().inventoryLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ serial: 'CANARY-SERIAL-A', quantityOnHand: '1' }),
      expect.objectContaining({ serial: 'CANARY-SERIAL-B', quantityOnHand: '1' }),
    ]));
    expect(put.mock.calls.every(([path]) => path === '/manufacturing-orders')).toBe(true);
  });

  it('proves exact operation completion and records the provider-retained operation date as inert cleanup residue', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-operation-canary-'));
    const beginInput = {
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2' as const,
        companyId: 'company-1',
        finishedProductId: 'output-product',
        sourceSerial: 'CANARY-SERIAL-1',
        finishedSerial: 'CANARY-SERIAL-1',
        parentRunHash: null,
        parentRawLineId: null,
      },
      locationId: 'location-1',
      remarks: 'operation completion canary',
    };
    const begin = planManufacturingRunBegin(beginInput);
    let order: ManufacturingOrder = {
      manufacturingOrderId: begin.manufacturingOrderId,
      manufacturingOrderNumber: 'MO-CANARY-OP-1',
      primaryFinishedProductId: 'output-product',
      locationId: 'location-1',
      status: 'inProgress',
      isCancelled: false,
      isCompleted: false,
      completedDate: null,
      remarks: `${beginInput.remarks}\n${begin.coordinatorMarker}`,
      timestamp: 'mo-ts-1',
      providerExtension: { preserved: true },
      lines: [{
        manufacturingOrderLineId: begin.rootLineId,
        manufacturingOrderId: begin.manufacturingOrderId,
        parentManufacturingOrderLineId: null,
        productId: 'output-product',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: [],
        },
        manufacturingOrderLines: [{
          manufacturingOrderLineId: 'source-line',
          manufacturingOrderId: begin.manufacturingOrderId,
          parentManufacturingOrderLineId: begin.rootLineId,
          productId: 'source-product',
          quantity: {
            standardQuantity: '1',
            uomQuantity: '1',
            serialNumbers: [],
          },
          manufacturingOrderLines: [],
          manufacturingOrderOperations: [],
        }],
        manufacturingOrderOperations: [{
          manufacturingOrderOperationId: 'assembly-operation',
          manufacturingOrderLineId: begin.rootLineId,
          operationTypeId: '00000000-0000-4000-8000-000000000201',
          lineNum: 1,
          completedDate: null,
          trackTime: true,
          manufacturingOrderOperationTimesheets: [],
          providerExtension: 'preserved',
        }],
      }],
      pickLines: [{
        manufacturingOrderPickLineId: 'source-pick',
        manufacturingOrderId: begin.manufacturingOrderId,
        productId: 'source-product',
        locationId: 'location-1',
        sublocation: '',
        quantity: {
          standardQuantity: '1',
          uomQuantity: '1',
          serialNumbers: ['CANARY-SERIAL-1'],
        },
      }],
      pickMatchings: [{
        manufacturingOrderPickMatchingId: 'source-matching',
        manufacturingOrderId: begin.manufacturingOrderId,
        manufacturingOrderLineId: 'source-line',
        manufacturingOrderPickLineId: 'source-pick',
        matchedQuantity: '1',
        serial: 'CANARY-SERIAL-1',
      }],
      putLines: [],
    };
    let outputInventory: Product['inventoryLines'] = [];
    let sourceInventory: Product['inventoryLines'] = [];
    const outputProduct = (): Product => ({
      productId: 'output-product',
      name: '__CANARY_OUTPUT__',
      isActive: true,
      trackSerials: true,
      inventoryLines: structuredClone(outputInventory),
    });
    const sourceProduct = (): Product => ({
      productId: 'source-product',
      name: '__CANARY_SOURCE__',
      isActive: true,
      trackSerials: true,
      inventoryLines: structuredClone(sourceInventory),
    });
    let revision = 1;
    const get = vi.fn(async (path: string) => {
      if (path === `/manufacturing-orders/${begin.manufacturingOrderId}`) {
        return structuredClone(order);
      }
      if (path === '/products/output-product') {
        return outputProduct();
      }
      if (path === '/products/source-product') {
        return sourceProduct();
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const put = vi.fn(async (path: string, raw: unknown) => {
      if (path !== '/manufacturing-orders') {
        throw new Error(`unexpected PUT ${path}`);
      }
      const body = structuredClone(raw) as ManufacturingOrder;
      if (body.timestamp !== order.timestamp) {
        throw new InflowApiError('HTTP 409: Conflict', 409);
      }
      revision += 1;
      const retainedCompletedDates = new Map(
        (order.lines ?? []).flatMap((line) =>
          (line.manufacturingOrderOperations ?? []).map((operation) => [
            operation.manufacturingOrderOperationId,
            operation.completedDate,
          ] as const)
        )
      );
      for (const line of body.lines ?? []) {
        for (const operation of line.manufacturingOrderOperations ?? []) {
          if (operation.completedDate == null) {
            operation.completedDate =
              retainedCompletedDates.get(
                operation.manufacturingOrderOperationId
              ) ?? null;
          }
        }
      }
      order = { ...body, timestamp: `mo-ts-${revision}` };
      if (body.isCompleted && order.putLines?.[0]) {
        delete (
          order.putLines[0] as Partial<
            NonNullable<ManufacturingOrder['putLines']>[number]
          >
        ).manufacturingOrderLineId;
      }
      outputInventory = body.isCompleted
        ? [{
            serial: 'CANARY-SERIAL-1',
            locationId: 'location-1',
            sublocation: '',
            quantityOnHand: '1',
          }]
        : [];
      sourceInventory =
        !body.isCompleted && (body.pickLines?.length ?? 0) === 0
          ? [{
              serial: 'CANARY-SERIAL-1',
              locationId: 'location-1',
              sublocation: '',
              quantityOnHand: '1',
            }]
          : [];
      return structuredClone(order);
    });
    const config: InflowConfig = {
      companyId: 'company-1',
      apiKey: 'api-key',
      baseUrl: 'https://example.test',
      apiVersion: '2026-04-13',
      rateLimitPerMinute: 60,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      retryDelayMs: 1,
      readRetryBudgetMs: 1_000,
      debug: false,
      safeWritesEnabled: false,
      stockWritesEnabled: false,
      enableManufacturingWrites: false,
      stateDir,
      adapterManifestHash: 'adapter-sha',
      probeBuild: 'probe-sha',
      enableLegacyWrites: false,
      writeGates: {
        manufacturing: false,
        'manufacturing-pick-batch-v1': false,
        'manufacturing-operation-completion-v1': false,
        prices: false,
        'product-groups': false,
        'mo-serials': false,
        standard: false,
      },
    };
    const expectedPreStateHash =
      manufacturingOperationCompletionStateHash(order);

    try {
      const result = await runApprovedOperationCompletionCanary(
        begin.manufacturingOrderId,
        {
          client: { get, put } as unknown as CanaryClient,
          config,
          env: {
            INFLOW_CANARY_APPROVED: 'true',
            INFLOW_CANARY_RESOURCE_ID: begin.manufacturingOrderId,
            INFLOW_CANARY_APPROVAL_NONCE: 'operation-canary-approval',
            INFLOW_CANARY_OPERATION_COMPLETION_JSON: JSON.stringify({
              schemaVersion:
                'manufacturing-operation-completion-canary-fixture/v1',
              beginInput,
              expectedTimestamp: 'mo-ts-1',
              expectedPreStateHash,
              staleTimestamp: 'mo-ts-stale',
              staleExpectedRejection: {
                statusCode: 409,
                code: null,
              },
              sourceProductId: 'source-product',
              output: {
                serialNumber: 'CANARY-SERIAL-1',
                locationId: 'location-1',
                sublocation: '',
              },
              approvedInertArtifactIds: [
                begin.manufacturingOrderId,
                'output-product',
                'source-product',
              ],
            }),
          },
        }
      );

      expect(result).toMatchObject({
        passed: true,
        exactAssemblyShape: true,
        trackTimePreserved: true,
        timesheetsPreserved: true,
        operationsCompleted: true,
        outputSerial: true,
        putAway: true,
        orderCompleted: true,
        unknownFieldsPreserved: true,
        staleRowversionNoWrite: true,
        responseLossReadback: true,
        partialWriteQuarantine: true,
        inventoryMovement: true,
        exactReadback: true,
        cleanupSucceeded: true,
        attestationIssued: true,
        errors: [],
      });
      expect(outputInventory).toEqual([]);
      expect(order.status).toBe('open');
      expect(sourceInventory).toEqual([
        {
          serial: 'CANARY-SERIAL-1',
          locationId: 'location-1',
          sublocation: '',
          quantityOnHand: '1',
        },
      ]);
      expect(order.isCompleted).toBe(false);
      expect(
        order.lines?.[0]?.manufacturingOrderOperations?.[0]?.completedDate
      ).not.toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
