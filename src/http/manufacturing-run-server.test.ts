import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const serverModule = await import('./manufacturing-run-server.js').catch(() => ({}));

const NOW = new Date('2026-07-24T10:00:00.000Z');
const VERSION = 'manufacturing-run-hmac/v1';
const SECRET = 'coordinator-current-secret-value';
let nonceCounter = 0;
const openServers: Server[] = [];

const notificationContext = {
  slackChannelId: 'C0000000001',
  slackThreadTs: '1700000000.000001',
  slackPermalink:
    'https://example.slack.com/archives/C1/p1700000000000000',
};

function encodedContextRemarks(remarks: string): string {
  const encoded = Buffer.from(JSON.stringify({
    schemaVersion: 'manufacturing-run-context/v1',
    notificationContext,
  })).toString('base64url');
  return `[manufacturing-run-context:v1:${encoded}]\n${remarks}`;
}

const snapshot = {
  operationId: 'operation-1',
  runHash: 'run-hash-1',
  manufacturingOrderId: 'mo-1',
  rootLineId: 'root-1',
  state: 'collecting',
  stateRevision: 1,
  retryMode: 'none',
  expectedComponents: [],
};

describe('production component resolver facade', () => {
  it('registers deterministic exact inventory from one location bucket', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const coordinator = {
      snapshot: () => ({
        ...snapshot,
        expectedComponents: [{
          rawLineId: 'line-1',
          productId: 'product-1',
          quantity: '2',
          disposition: 'missing',
        }],
      }),
      registerComponent: (input: unknown) => {
        registrations.push(input);
        return snapshot;
      },
    };
    const resolver = createResolver({
      coordinator,
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: () => ({
          artifact: {
            locationId: 'location-1',
            remarks: '',
            begin: {
              normalizedIdentity: {
                finishedSerial: 'SERIAL-SYNTHETIC-003',
              },
            },
          },
        }),
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'product-1',
              quantityAvailable: '2',
              quantityOnHand: '2',
              quantityAllocated: '0',
              quantityOnOrder: '0',
              locationSummaries: [{
                locationId: 'location-1',
                locationName: 'Main',
                quantityOnHand: '2',
                quantityAvailable: '2',
                sublocationSummaries: [{
                  sublocation: 'bay-a',
                  quantityOnHand: '2',
                  quantityAvailable: '2',
                }],
              }],
            }
          : ({
          name: 'Serialized component',
          trackSerials: true,
          inventoryLines: [
            {
              serial: 'SERIAL-B',
              locationId: 'location-1',
              sublocation: 'bay-a',
              quantityOnHand: '1',
            },
            {
              serial: 'SERIAL-A',
              locationId: 'location-1',
              sublocation: 'bay-a',
              quantityOnHand: '1',
            },
          ],
        }),
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await expect(resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
    })).resolves.toMatchObject({ operationId: 'operation-1' });
    expect(registrations).toEqual([{
      operationId: 'operation-1',
      rawLineId: 'line-1',
      productId: 'product-1',
      quantity: '2',
      locationId: 'location-1',
      sublocation: 'bay-a',
      serialized: true,
      serialNumbers: ['SERIAL-A', 'SERIAL-B'],
    }]);
  });

  it('uses aggregate availability for one unambiguous ordinary inventory bucket', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: unknown[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'battery-line',
            productId: 'battery-product',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? {
                artifact: {
                  locationId: 'location-1',
                  begin: {
                    normalizedIdentity: {
                      finishedSerial: 'FINISHED-1',
                    },
                  },
                },
              }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'battery-product',
              quantityOnHand: '14',
              quantityAvailable: '6',
              quantityAllocated: '8',
              quantityOnOrder: '0',
              locationSummaries: [],
            }
          : {
              name: 'Standard Battery - NOS',
              trackSerials: false,
              inventoryLines: [{
                locationId: 'location-1',
                quantityOnHand: '14',
              }],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'battery-line',
    });
    expect(registrations).toEqual([{
      operationId: 'operation-1',
      rawLineId: 'battery-line',
      productId: 'battery-product',
      quantity: '1',
      locationId: 'location-1',
      serialized: false,
      serialNumbers: [],
    }]);
    expect(blocks).toEqual([]);
  });

  it('fails closed when aggregate ordinary availability spans inventory buckets', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: any[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'battery-line',
            productId: 'battery-product',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'battery-product',
              quantityOnHand: '14',
              quantityAvailable: '6',
              quantityAllocated: '8',
              quantityOnOrder: '0',
              locationSummaries: [],
            }
          : {
              sku: 'INFL000057',
              name: 'Standard Battery - NOS',
              trackSerials: false,
              inventoryLines: [
                { locationId: 'location-1', quantityOnHand: '13' },
                { locationId: 'location-2', quantityOnHand: '1' },
              ],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'battery-line',
    });
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
        availableQuantity: '6',
        locationId: 'location-1',
      }),
    })]);
  });

  it('honors an explicit zero location projection over positive aggregate availability', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: any[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'battery-line',
            productId: 'battery-product',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'battery-product',
              quantityOnHand: '14',
              quantityAvailable: '6',
              quantityAllocated: '8',
              quantityOnOrder: '0',
              locationSummaries: [{
                locationId: 'location-1',
                quantityOnHand: '14',
                quantityAvailable: '0',
              }],
            }
          : {
              sku: 'INFL000057',
              name: 'Standard Battery - NOS',
              trackSerials: false,
              inventoryLines: [{
                locationId: 'location-1',
                quantityOnHand: '14',
              }],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'battery-line',
    });
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
        availableQuantity: '0',
      }),
    })]);
  });

  it.each([
    ['24', true],
    ['0', false],
  ] as const)(
    'resolves the immutably bound incident SERIAL with aggregate availability %s',
    async (aggregateAvailable, shouldRegister) => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: any[] = [];
    const rawLineId = '3473e2e1-f027-454f-a60f-cb6717d707fd';
    const sourceSerial = 'SERIAL-SYNTHETIC-003';
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId,
            productId: 'black-donor-product',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'source_serial_binding/v1'
            ? {
                artifact: {
                  schemaVersion: 'source_serial_binding/v1',
                  rawLineId,
                  productId: 'black-donor-product',
                  sourceSerial,
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  manufacturingOrderTimestamp: '2026-07-24T09:00:00.000Z',
                  inventoryLineTimestamp: '2026-07-24T08:00:00.000Z',
                  inventoryReadbackHash: 'binding-hash',
                },
              }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'black-donor-product',
              quantityOnHand: '27',
              quantityAvailable: aggregateAvailable,
              quantityAllocated: aggregateAvailable === '24' ? '3' : '27',
              quantityOnOrder: '0',
              // The live provider can omit this projection while retaining
              // the authoritative aggregate and inventory-line evidence.
              locationSummaries: [],
            }
          : {
              name: 'Black donor',
              trackSerials: true,
              inventoryLines: [
                {
                  serial: 'ANOTHER-SERIAL',
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '26',
                },
                {
                  serial: sourceSerial,
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                },
              ],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({ operationId: 'operation-1', rawLineId });
    if (shouldRegister) {
      expect(registrations).toEqual([{
        operationId: 'operation-1',
        rawLineId,
        productId: 'black-donor-product',
        quantity: '1',
        locationId: 'location-1',
        sublocation: 'bay-a',
        serialized: true,
        serialNumbers: [sourceSerial],
      }]);
      expect(blocks).toEqual([]);
    } else {
      expect(registrations).toEqual([]);
      expect(blocks).toEqual([expect.objectContaining({
        operationId: 'operation-1',
        rawLineId,
        blockerEvidence: expect.objectContaining({
          code: 'SOURCE_SERIAL_UNAVAILABLE',
          availableQuantity: '0',
          sourceSerial,
        }),
      })]);
    }
  });

  it('blocks a missing bound SERIAL without selecting an alternative serial or recursive child', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: any[] = [];
    const recursiveBegins: unknown[] = [];
    const rawLineId = '3473e2e1-f027-454f-a60f-cb6717d707fd';
    const sourceSerial = 'SERIAL-SYNTHETIC-003';
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId,
            productId: 'black-donor-product',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
        beginChildWithDependency: (input: unknown) => recursiveBegins.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'source_serial_binding/v1'
            ? {
                artifact: {
                  schemaVersion: 'source_serial_binding/v1',
                  rawLineId,
                  productId: 'black-donor-product',
                  sourceSerial,
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  manufacturingOrderTimestamp: '2026-07-24T09:00:00.000Z',
                  inventoryLineTimestamp: null,
                  inventoryReadbackHash: 'binding-hash',
                },
              }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'black-donor-product',
              quantityOnHand: '27',
              quantityAvailable: '24',
              quantityAllocated: '3',
              quantityOnOrder: '0',
              locationSummaries: [{
                locationId: 'location-1',
                locationName: 'Main',
                quantityOnHand: '27',
                quantityAvailable: '24',
                sublocationSummaries: [{
                  sublocation: 'bay-a',
                  quantityOnHand: '27',
                  quantityAvailable: '24',
                }],
              }],
            }
          : {
              sku: '<BLACK&>',
              name: 'Black donor',
              trackSerials: true,
              isManufacturable: true,
              itemBoms: [{ itemBomId: 'bom-1' }],
              inventoryLines: [{
                serial: 'ALTERNATIVE-SERIAL',
                locationId: 'location-1',
                sublocation: 'bay-a',
                quantityOnHand: '27',
              }],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId,
      recursiveChildren: [{
        sourceSerial: 'ALTERNATIVE-SOURCE-SERIAL',
        finishedSerial: 'ALTERNATIVE-SERIAL',
        locationId: 'location-1',
      }],
    });
    expect(registrations).toEqual([]);
    expect(recursiveBegins).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      operationId: 'operation-1',
      rawLineId,
      blockerEvidence: expect.objectContaining({
        code: 'SOURCE_SERIAL_UNAVAILABLE',
        sku: '<BLACK&>',
        productId: 'black-donor-product',
        rawLineId,
        requiredQuantity: '1',
        availableQuantity: '24',
        locationId: 'location-1',
        sourceSerial,
        detail: expect.stringContaining('no alternative serial was considered'),
        slackMessage: expect.stringContaining('SKU: &lt;BLACK&amp;&gt;.'),
      }),
    })]);
  });

  it('rejects allocated on-hand inventory when authoritative available quantity is short', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: unknown[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: 'product-1',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'product-1',
              quantityOnHand: '2',
              quantityAvailable: '0',
              quantityAllocated: '2',
              quantityOnOrder: '0',
              locationSummaries: [{
                locationId: 'location-1',
                locationName: 'Main',
                quantityOnHand: '2',
                quantityAvailable: '0',
                sublocationSummaries: [{
                  sublocation: 'bay-a',
                  quantityOnHand: '2',
                  quantityAvailable: '0',
                }],
              }],
            }
          : {
              name: 'Allocated serialized component',
              trackSerials: true,
              isManufacturable: false,
              inventoryLines: [
                {
                  serial: 'SERIAL-A',
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                },
                {
                  serial: 'SERIAL-B',
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                },
              ],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
    });
    expect(registrations).toEqual([]);
    expect(blocks).toHaveLength(1);
  });

  it.each([
    ['build', '2', '0', '2'],
    ['manufacturing', '0', '2', '0'],
  ])(
    'registers nonserialized stock reserved for the current MO via the %s dimension',
    async (_dimension, buildReserved, manufacturingReserved, rawAvailable) => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: unknown[] = [];
    let orderCancelled = false;
    let orderLineQuantity = '2';
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'mudguard-line',
            productId: 'rear-mudguard',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => {
          if (path.startsWith('/manufacturing-orders/')) {
            return {
              manufacturingOrderId: 'mo-1',
              locationId: 'location-1',
              isCancelled: orderCancelled,
              isCompleted: false,
              lines: [{
                manufacturingOrderLineId: 'mudguard-line',
                productId: 'rear-mudguard',
                quantity: {
                  standardQuantity: orderLineQuantity,
                  uomQuantity: orderLineQuantity,
                  serialNumbers: [],
                },
              }],
            };
          }
          return path.endsWith('/summary') ? {
              productId: 'rear-mudguard',
              quantityOnHand: '2',
              quantityAvailable: '0',
              rawQuantityAvailable: rawAvailable,
              quantityAllocated: '0',
              quantityOnOrder: '0',
              quantityReserved: '2',
              quantityReservedForSales: '0',
              quantityReservedForManufacturing: manufacturingReserved,
              quantityReservedForTransfers: '0',
              quantityReservedForBuilds: buildReserved,
              quantityPicked: '0',
              locationSummaries: [],
            } : {
              name: 'Rear Mudguard - Light Blue',
              sku: '55557186257274',
              trackSerials: false,
              isManufacturable: false,
              inventoryLines: [{
                locationId: 'location-1',
                sublocation: '',
                quantityOnHand: '2',
              }],
            };
        },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'mudguard-line',
    });

    expect(blocks).toEqual([]);
    expect(registrations).toEqual([expect.objectContaining({
      rawLineId: 'mudguard-line',
      productId: 'rear-mudguard',
      quantity: '2',
      locationId: 'location-1',
      serialized: false,
      serialNumbers: [],
    })]);

    registrations.length = 0;
    orderCancelled = true;
    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'mudguard-line',
    });
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
      }),
    })]);
    blocks.length = 0;
    orderCancelled = false;
    orderLineQuantity = '3';
    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'mudguard-line',
    });
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
      }),
    })]);
    }
  );

  it.each([
    ['nested', true, true],
    ['direct', false, false],
  ])(
    '%s components use dual reservation projections only when the exact current-MO line is nested',
    async (_label, nested, shouldRegister) => {
      const createResolver = exported('createCoordinatorComponentResolver');
      const registrations: unknown[] = [];
      const blocks: unknown[] = [];
      const componentLine = {
        manufacturingOrderLineId: 'mudguard-line',
        parentManufacturingOrderLineId: nested ? 'subassembly-line' : 'root-line',
        productId: 'rear-mudguard',
        quantity: {
          standardQuantity: '2',
          uomQuantity: '2',
          serialNumbers: [],
        },
      };
      const resolver = createResolver({
        coordinator: {
          snapshot: () => ({
            ...snapshot,
            expectedComponents: [
              {
                rawLineId: 'mudguard-line',
                productId: 'rear-mudguard',
                quantity: '2',
                disposition: 'missing',
              },
              ...(nested
                ? [{
                    rawLineId: 'direct-sibling-line',
                    productId: 'rear-mudguard',
                    quantity: '1',
                    disposition: 'missing',
                  }]
                : []),
            ],
          }),
          registerComponent: (input: unknown) => registrations.push(input),
          blockComponent: (input: unknown) => blocks.push(input),
        },
        store: {
          consumeRateBudget: () => ({
            allowed: true,
            remaining: 19,
            retryAfterMs: 0,
          }),
          getRunArtifact: (_operationId: string, artifactType: string) =>
            artifactType === 'begin_plan'
              ? { artifact: { locationId: 'location-1' } }
              : undefined,
        },
        client: {
          get: async (path: string) => {
            if (path.startsWith('/manufacturing-orders/')) {
              return {
                manufacturingOrderId: 'mo-1',
                locationId: 'location-1',
                isCancelled: false,
                isCompleted: false,
                status: 'open',
                lines: [{
                  manufacturingOrderLineId: 'root-line',
                  parentManufacturingOrderLineId: null,
                  productId: 'finished-product',
                  quantity: { standardQuantity: '1', uomQuantity: '1' },
                  manufacturingOrderLines: nested
                    ? [
                      {
                        manufacturingOrderLineId: 'direct-sibling-line',
                        parentManufacturingOrderLineId: 'root-line',
                        productId: 'rear-mudguard',
                        quantity: { standardQuantity: '1', uomQuantity: '1' },
                      },
                      {
                        manufacturingOrderLineId: 'subassembly-line',
                        parentManufacturingOrderLineId: 'root-line',
                        productId: 'subassembly',
                        quantity: { standardQuantity: '1', uomQuantity: '1' },
                        manufacturingOrderLines: [componentLine],
                      },
                    ]
                    : [componentLine],
                }],
              };
            }
            return path.endsWith('/summary')
              ? {
                  productId: 'rear-mudguard',
                  quantityOnHand: nested ? '3' : '2',
                  quantityAvailable: '-2',
                  rawQuantityAvailable: '0',
                  quantityAllocated: '0',
                  quantityOnOrder: '0',
                  quantityReserved: nested ? '5' : '4',
                  quantityReservedForSales: '0',
                  quantityReservedForManufacturing: nested ? '3' : '2',
                  quantityReservedForTransfers: '0',
                  quantityReservedForBuilds: '2',
                  quantityPicked: '0',
                  locationSummaries: [],
                }
              : {
                  name: 'Rear Mudguard - Yellow',
                  sku: '55557186322810',
                  trackSerials: false,
                  isManufacturable: false,
                  inventoryLines: [{
                    locationId: 'location-1',
                    sublocation: '',
                    quantityOnHand: nested ? '3' : '2',
                  }],
                };
          },
        },
        companyId: 'company-1',
        now: () => NOW,
      });

      await resolver.resolve({
        operationId: 'operation-1',
        rawLineId: 'mudguard-line',
      });

      expect(registrations).toHaveLength(shouldRegister ? 1 : 0);
      expect(blocks).toHaveLength(shouldRegister ? 0 : 1);
    }
  );

  it('does not spend an order-read budget slot when reservations cannot cover the shortage', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: unknown[] = [];
    let rateCalls = 0;
    let orderReads = 0;
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'mudguard-line',
            productId: 'rear-mudguard',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => {
          rateCalls += 1;
          return {
            allowed: rateCalls <= 2,
            remaining: Math.max(0, 2 - rateCalls),
            retryAfterMs: rateCalls <= 2 ? 0 : 60_000,
          };
        },
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => {
          if (path.startsWith('/manufacturing-orders/')) {
            orderReads += 1;
            throw new Error('unexpected manufacturing-order read');
          }
          return path.endsWith('/summary')
            ? {
                productId: 'rear-mudguard',
                quantityOnHand: '2',
                quantityAvailable: '0',
                rawQuantityAvailable: '0',
                quantityAllocated: '0',
                quantityOnOrder: '0',
                quantityReserved: '0',
                quantityReservedForSales: '0',
                quantityReservedForManufacturing: '0',
                quantityReservedForTransfers: '0',
                quantityReservedForBuilds: '0',
                quantityPicked: '0',
                locationSummaries: [],
              }
            : {
                name: 'Rear Mudguard - Yellow',
                sku: '55557186322810',
                trackSerials: false,
                isManufacturable: false,
                inventoryLines: [{
                  locationId: 'location-1',
                  sublocation: '',
                  quantityOnHand: '2',
                }],
              };
        },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'mudguard-line',
    });

    expect(rateCalls).toBe(2);
    expect(orderReads).toBe(0);
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
      }),
    })]);
  });

  it('does not spend an order-read budget slot for build-reserved stock at another location', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const blocks: unknown[] = [];
    let rateCalls = 0;
    let orderReads = 0;
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'mudguard-line',
            productId: 'rear-mudguard',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        blockComponent: (input: unknown) => blocks.push(input),
      },
      store: {
        consumeRateBudget: () => {
          rateCalls += 1;
          return {
            allowed: rateCalls <= 2,
            remaining: Math.max(0, 2 - rateCalls),
            retryAfterMs: rateCalls <= 2 ? 0 : 60_000,
          };
        },
        getRunArtifact: (_operationId: string, artifactType: string) =>
          artifactType === 'begin_plan'
            ? { artifact: { locationId: 'location-1' } }
            : undefined,
      },
      client: {
        get: async (path: string) => {
          if (path.startsWith('/manufacturing-orders/')) {
            orderReads += 1;
            throw new Error('unexpected manufacturing-order read');
          }
          return path.endsWith('/summary') ? {
            productId: 'rear-mudguard',
            quantityOnHand: '2',
            quantityAvailable: '0',
            rawQuantityAvailable: '2',
            quantityAllocated: '0',
            quantityOnOrder: '0',
            quantityReserved: '2',
            quantityReservedForSales: '0',
            quantityReservedForManufacturing: '0',
            quantityReservedForTransfers: '0',
            quantityReservedForBuilds: '2',
            quantityPicked: '0',
            locationSummaries: [{
              locationId: 'location-secondary',
              locationName: 'Secondary',
              quantityOnHand: '2',
              quantityAvailable: '0',
              rawQuantityAvailable: '2',
              quantityReserved: '2',
              quantityReservedForSales: '0',
              quantityReservedForManufacturing: '0',
              quantityReservedForTransfers: '0',
              quantityReservedForBuilds: '2',
              quantityPicked: '0',
              sublocationSummaries: [],
            }],
          } : {
            name: 'Rear Mudguard - Light Blue',
            sku: '55557186257274',
            trackSerials: false,
            isManufacturable: false,
            inventoryLines: [{
              locationId: 'location-secondary',
              sublocation: '',
              quantityOnHand: '2',
            }],
          };
        },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'mudguard-line',
    });

    expect(rateCalls).toBe(2);
    expect(orderReads).toBe(0);
    expect(registrations).toEqual([]);
    expect(blocks).toEqual([expect.objectContaining({
      blockerEvidence: expect.objectContaining({
        code: 'COMPONENT_INVENTORY_SHORTAGE',
      }),
    })]);
  });

  it.each(['1', '2'])(
    'never selects ambiguous serialized stock and recurses only with absent requested serials (required %s)',
    async (quantity) => {
      const createResolver = exported('createCoordinatorComponentResolver');
      const registrations: unknown[] = [];
      const blocks: unknown[] = [];
      const recursiveBegins: unknown[] = [];
      const resolver = createResolver({
        coordinator: {
          snapshot: () => ({
            ...snapshot,
            expectedComponents: [{
              rawLineId: 'line-1',
              productId: 'product-1',
              quantity,
              disposition: 'missing',
            }],
          }),
          registerComponent: (input: unknown) => registrations.push(input),
          blockComponent: (input: unknown) => blocks.push(input),
          beginChildWithDependency: (input: unknown) => {
            recursiveBegins.push(input);
          },
        },
        store: {
          consumeRateBudget: () => ({
            allowed: true,
            remaining: 19,
            retryAfterMs: 0,
          }),
        },
        client: {
          get: async (path: string) => path.endsWith('/summary')
            ? {
                productId: 'product-1',
                quantityOnHand: '2',
                quantityAvailable: '1',
                quantityAllocated: '1',
                quantityOnOrder: '0',
                locationSummaries: [{
                  locationId: 'location-1',
                  locationName: 'Main',
                  quantityOnHand: '2',
                  quantityAvailable: '1',
                  sublocationSummaries: [{
                    sublocation: 'bay-a',
                    quantityOnHand: '2',
                    quantityAvailable: '1',
                  }],
                }],
              }
            : {
                name: 'Partially allocated serialized component',
                trackSerials: true,
                isManufacturable: true,
                itemBoms: [{ childProductId: 'raw-material-1' }],
                inventoryLines: [
                  {
                    serial: 'SERIAL-A',
                    locationId: 'location-1',
                    sublocation: 'bay-a',
                    quantityOnHand: '1',
                  },
                  {
                    serial: 'SERIAL-B',
                    locationId: 'location-1',
                    sublocation: 'bay-a',
                    quantityOnHand: '1',
                  },
                ],
              },
        },
        companyId: 'company-1',
        now: () => NOW,
      });

      await resolver.resolve({
        operationId: 'operation-1',
        rawLineId: 'line-1',
        recursiveChildren: Array.from(
          { length: Number(quantity) },
          (_, index) => ({
            sourceSerial: `SOURCE-${index + 1}`,
            finishedSerial: `SUBASSEMBLY-${index + 1}`,
            locationId: 'location-child',
          })
        ),
      });

      expect(registrations).toEqual([]);
      expect(recursiveBegins).toHaveLength(Number(quantity));
      expect(blocks).toEqual([]);
    }
  );

  it('atomically starts and links a recursive child when shortage has an explicit serial', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const recursiveBegins: any[] = [];
    const coordinator = {
      snapshot: () => ({
        ...snapshot,
        expectedComponents: [{
          rawLineId: 'line-1',
          productId: 'product-1',
          quantity: '1',
          disposition: 'missing',
        }],
      }),
      beginChildWithDependency: (input: unknown) => {
        recursiveBegins.push(input);
        return { ...snapshot, operationId: 'child-operation' };
      },
    };
    const resolver = createResolver({
      coordinator,
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: {
        get: async () => ({
          name: 'Manufacturable component',
          isManufacturable: true,
          itemBoms: [{ childProductId: 'raw-material-1' }],
          inventoryLines: [],
        }),
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [{
        sourceSerial: 'SOURCE-SUBASSEMBLY-1',
        finishedSerial: 'SUBASSEMBLY-1',
        locationId: 'location-child',
      }],
    });
    expect(recursiveBegins).toEqual([expect.objectContaining({
      parentOperationId: 'operation-1',
      parentRawLineId: 'line-1',
      idempotencyKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      identity: expect.objectContaining({
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SOURCE-SUBASSEMBLY-1',
        finishedSerial: 'SUBASSEMBLY-1',
      }),
      locationId: 'location-child',
    })]);
  });

  it('selects the exact requested SERIAL for an available serialized manufacturable component', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const recursiveBegins: unknown[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: '00000000000001',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        beginChildWithDependency: (input: unknown) => recursiveBegins.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              locationSummaries: [{
                locationId: 'location-1',
                quantityOnHand: '2',
                quantityAvailable: '2',
                sublocationSummaries: [{
                  sublocation: 'bay-a',
                  quantityOnHand: '2',
                  quantityAvailable: '2',
                }],
              }],
            }
          : {
              name: 'Black 1x',
              trackSerials: true,
              isManufacturable: true,
              itemBoms: [{ childProductId: 'raw-material-1' }],
              inventoryLines: [
                {
                  serial: 'AAAA0000000000001',
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                },
                {
                  serial: 'SERIAL-SYNTHETIC-003',
                  locationId: 'location-1',
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                },
              ],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [{
        sourceSerial: 'SOURCE-SERIAL-SYNTHETIC-003',
        finishedSerial: 'SERIAL-SYNTHETIC-003',
        locationId: 'location-1',
      }],
    });

    expect(registrations).toEqual([expect.objectContaining({
      productId: '00000000000001',
      serialNumbers: ['SERIAL-SYNTHETIC-003'],
    })]);
    expect(recursiveBegins).toEqual([]);
  });

  it('recurses with the requested SERIAL when another serialized SERIAL is available', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const recursiveBegins: any[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: '00000000000001',
            quantity: '1',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        beginChildWithDependency: (input: unknown) => recursiveBegins.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
        getRunArtifact: () => ({
          artifactType: 'begin_plan',
          artifactHash: 'artifact-hash',
          at: NOW.toISOString(),
          artifact: {
            begin: { normalizedIdentity: { finishedSerial: 'SERIAL-SYNTHETIC-003' } },
            locationId: 'location-1',
            remarks: encodedContextRemarks('root remarks'),
          },
        }),
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              locationSummaries: [{
                locationId: 'location-1',
                quantityOnHand: '1',
                quantityAvailable: '1',
                sublocationSummaries: [{
                  sublocation: 'bay-a',
                  quantityOnHand: '1',
                  quantityAvailable: '1',
                }],
              }],
            }
          : {
              name: 'Light Blue 1x',
              trackSerials: true,
              isManufacturable: true,
              itemBoms: [{ childProductId: 'raw-material-1' }],
              inventoryLines: [{
                serial: 'OTHER000000000001',
                locationId: 'location-1',
                sublocation: 'bay-a',
                quantityOnHand: '1',
              }],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [{
        sourceSerial: 'SOURCE-SERIAL-SYNTHETIC-003',
        finishedSerial: 'SERIAL-SYNTHETIC-003',
        locationId: 'location-1',
      }],
    });

    expect(registrations).toEqual([]);
    expect(recursiveBegins).toEqual([expect.objectContaining({
      identity: expect.objectContaining({
        sourceSerial: 'SOURCE-SERIAL-SYNTHETIC-003',
        finishedSerial: 'SERIAL-SYNTHETIC-003',
      }),
      locationId: 'location-1',
      remarks: expect.stringMatching(/^\[manufacturing-run-context:v1:/),
    })]);
  });

  it('starts one deterministic recursive child per required unit for quantity two', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const recursiveBegins: any[] = [];
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: 'product-1',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        beginChildWithDependency: (input: unknown) => {
          recursiveBegins.push(input);
          return { ...snapshot, operationId: `child-${recursiveBegins.length}` };
        },
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'product-1',
              quantityOnHand: '0',
              quantityAvailable: '0',
              quantityAllocated: '0',
              quantityOnOrder: '0',
              locationSummaries: [],
            }
          : {
              name: 'Manufacturable component',
              isManufacturable: true,
              itemBoms: [{ childProductId: 'raw-material-1' }],
              inventoryLines: [],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'SOURCE-1', finishedSerial: 'SUBASSEMBLY-1', locationId: 'location-child' },
        { sourceSerial: 'SOURCE-2', finishedSerial: 'SUBASSEMBLY-2', locationId: 'location-child' },
      ],
    });
    expect(recursiveBegins).toEqual([
      expect.objectContaining({
        parentChildIndex: 0,
        identity: expect.objectContaining({ finishedSerial: 'SUBASSEMBLY-1' }),
      }),
      expect.objectContaining({
        parentChildIndex: 1,
        identity: expect.objectContaining({ finishedSerial: 'SUBASSEMBLY-2' }),
      }),
    ]);
  });

  it('rejects wrong recursive cardinality before reads or arbitrary stock registration', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const registrations: unknown[] = [];
    const recursiveBegins: unknown[] = [];
    const get = vi.fn(async (path: string) => path.endsWith('/summary')
      ? {
          productId: 'product-1',
          quantityOnHand: '2',
          quantityAvailable: '2',
          quantityAllocated: '0',
          quantityOnOrder: '0',
          locationSummaries: [{
            locationId: 'location-1',
            quantityOnHand: '2',
            quantityAvailable: '2',
          }],
        }
      : {
          productId: 'product-1',
          isManufacturable: true,
          trackSerials: true,
          itemBoms: [{ childProductId: 'raw-material-1' }],
          inventoryLines: [
            { serial: 'SUBASSEMBLY-1', locationId: 'location-1', quantityOnHand: '1' },
            { serial: 'AVAILABLE-2', locationId: 'location-1', quantityOnHand: '1' },
          ],
        });
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: 'product-1',
            quantity: '2',
            disposition: 'missing',
          }],
        }),
        registerComponent: (input: unknown) => registrations.push(input),
        beginChildWithDependency: (input: unknown) => recursiveBegins.push(input),
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: { get },
      companyId: 'company-1',
      now: () => NOW,
    });

    await expect(resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [{
        sourceSerial: 'SOURCE-1',
        finishedSerial: 'SUBASSEMBLY-1',
        locationId: 'location-1',
      }],
    })).rejects.toThrow('RECURSIVE_CHILD_CARDINALITY_MISMATCH');
    expect(get).not.toHaveBeenCalled();
    expect(registrations).toEqual([]);
    expect(recursiveBegins).toEqual([]);
  });

  it('resumes an interrupted per-unit recursive batch without duplicating the first child', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const created = new Set<number>();
    const attempts: number[] = [];
    let failSecondOnce = true;
    const resolver = createResolver({
      coordinator: {
        snapshot: () => ({
          ...snapshot,
          expectedComponents: [{
            rawLineId: 'line-1',
            productId: 'product-1',
            quantity: '2',
            disposition: created.size > 0 ? 'dependency_pending' : 'missing',
          }],
        }),
        beginChildWithDependency: (input: any) => {
          attempts.push(input.parentChildIndex);
          if (input.parentChildIndex === 1 && failSecondOnce) {
            failSecondOnce = false;
            throw new Error('SIMULATED_SECOND_CHILD_CRASH');
          }
          created.add(input.parentChildIndex);
          return { ...snapshot, operationId: `child-${input.parentChildIndex}` };
        },
      },
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: {
        get: async (path: string) => path.endsWith('/summary')
          ? {
              productId: 'product-1',
              quantityOnHand: '0',
              quantityAvailable: '0',
              quantityAllocated: '0',
              quantityOnOrder: '0',
              locationSummaries: [],
            }
          : {
              name: 'Manufacturable component',
              isManufacturable: true,
              itemBoms: [{ childProductId: 'raw-material-1' }],
              inventoryLines: [],
            },
      },
      companyId: 'company-1',
      now: () => NOW,
    });
    const request = {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'SOURCE-1', finishedSerial: 'SUBASSEMBLY-1', locationId: 'location-child' },
        { sourceSerial: 'SOURCE-2', finishedSerial: 'SUBASSEMBLY-2', locationId: 'location-child' },
      ],
    };

    await expect(resolver.resolve(request)).rejects.toThrow(
      /SIMULATED_SECOND_CHILD_CRASH/
    );
    expect([...created]).toEqual([0]);
    await expect(resolver.resolve(request)).resolves.toMatchObject({
      operationId: 'operation-1',
    });
    expect(attempts).toEqual([0, 1, 0, 1]);
    expect([...created]).toEqual([0, 1]);
  });

  it('durably blocks an unresolved shortage instead of guessing inventory or identity', async () => {
    const createResolver = exported('createCoordinatorComponentResolver');
    const blocks: any[] = [];
    const coordinator = {
      snapshot: () => ({
        ...snapshot,
        expectedComponents: [{
          rawLineId: 'line-1',
          productId: 'product-1',
          quantity: '1',
          disposition: 'missing',
        }],
      }),
      blockComponent: (input: unknown) => {
        blocks.push(input);
        return { ...snapshot, state: 'blocked' };
      },
    };
    const resolver = createResolver({
      coordinator,
      store: {
        consumeRateBudget: () => ({
          allowed: true,
          remaining: 19,
          retryAfterMs: 0,
        }),
      },
      client: {
        get: async () => ({
          name: 'Unavailable component',
          isManufacturable: false,
          inventoryLines: [],
        }),
      },
      companyId: 'company-1',
      now: () => NOW,
    });

    await resolver.resolve({
      operationId: 'operation-1',
      rawLineId: 'line-1',
    });
    expect(blocks).toEqual([expect.objectContaining({
      operationId: 'operation-1',
      rawLineId: 'line-1',
      reason: 'authoritative inventory shortage with no safe recursive resolution',
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      blockerEvidence: expect.objectContaining({
        schemaVersion: 'manufacturing-run-blocker/v1',
        productId: 'product-1',
        rawLineId: 'line-1',
      }),
    })]);
  });
});

function exported(name: string): any {
  const value = (serverModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value;
}

function sign(
  body: Buffer,
  path: string,
  method = 'POST',
  overrides: Record<string, string> = {}
): Record<string, string> {
  const timestamp = overrides.timestamp ?? String(Math.floor(NOW.getTime() / 1_000));
  const nonce = overrides.nonce ?? `nonce-${++nonceCounter}`;
  const kid = overrides.kid ?? 'current';
  const audience = overrides.audience ?? 'zapier-private-app';
  const companyId = overrides.companyId ?? 'company-1';
  const material = [
    VERSION,
    method,
    path,
    audience,
    companyId,
    timestamp,
    nonce,
    kid,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  return {
    'content-type': 'application/json',
    'x-inflow-auth-version': VERSION,
    'x-inflow-key-id': kid,
    'x-inflow-timestamp': timestamp,
    'x-inflow-nonce': nonce,
    'x-inflow-audience': audience,
    'x-inflow-company-id': companyId,
    'x-inflow-signature': createHmac(
      'sha256',
      overrides.secret ?? SECRET
    ).update(material).digest('hex'),
  };
}

function fakes(overrides: Record<string, unknown> = {}) {
  const nonces = new Set<string>();
  const manualInputs: any[] = [];
  const rearmInputs: any[] = [];
  const beginInputs: any[] = [];
  const calls = {
    begin: 0,
    register: 0,
    status: 0,
    snapshot: 0,
    manual: 0,
    rearm: 0,
    resolve: 0,
    claim: 0,
    ack: 0,
    deliveryUnknown: 0,
    reconcile: 0,
    runOne: 0,
    dispatch: 0,
    readiness: 0,
  };
  const options = {
    coordinator: {
      begin: (input: unknown) => {
        calls.begin += 1;
        beginInputs.push(structuredClone(input));
        return snapshot;
      },
      registerComponent: () => {
        calls.register += 1;
        return snapshot;
      },
      status: async () => {
        calls.status += 1;
        return snapshot;
      },
      snapshot: () => {
        calls.snapshot += 1;
        return snapshot;
      },
      resolveManual: (input: any) => {
        calls.manual += 1;
        manualInputs.push(structuredClone(input));
        return { ...snapshot, state: 'resolved_manual', stateRevision: 2 };
      },
      rearmProvenNoWrite: async (input: any) => {
        calls.rearm += 1;
        rearmInputs.push(structuredClone(input));
        return {
          ...snapshot,
          state: 'prepared',
          stateRevision: input.expectedRevision + 1,
        };
      },
      runOne: async () => {
        calls.runOne += 1;
      },
    },
    store: {
      claimNonce: ({ nonce }: { nonce: string }) => {
        if (nonces.has(nonce)) return false;
        nonces.add(nonce);
        return true;
      },
      getRunArtifact: () => undefined,
      getNotification: () => undefined,
      claimNextNotification: () => {
        calls.claim += 1;
        return {
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: 'claimed',
        };
      },
      ackNotification: () => {
        calls.ack += 1;
        return {
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: 'acknowledged',
        };
      },
      markNotificationDeliveryUnknown: () => {
        calls.deliveryUnknown += 1;
        return {
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: 'delivery_unknown',
        };
      },
      reconcileNotification: (input: any) => {
        calls.reconcile += 1;
        return {
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: input.action === 'acknowledge_existing'
            ? 'acknowledged'
            : 'pending',
        };
      },
    },
    componentResolver: {
      resolve: async () => {
        calls.resolve += 1;
        return snapshot;
      },
    },
    readiness: async () => {
      calls.readiness += 1;
      return {
        schemaVersion: 'manufacturing-run-readiness/v1',
        ready: true,
        checkedAt: NOW.toISOString(),
        checks: {},
      };
    },
    keyring: () => ({
      current: { kid: 'current', secret: SECRET },
    }),
    expectedAudience: 'zapier-private-app',
    expectedCompanyId: 'company-1',
    now: () => NOW,
    limits: {
      bodyLimitBytes: 65_536,
      requestTimeoutMs: 100,
      headersTimeoutMs: 500,
      keepAliveTimeoutMs: 500,
      maxHeaderBytes: 16_384,
    },
    logger: () => {},
    ...overrides,
  };
  return { options, calls, manualInputs, rearmInputs, beginInputs };
}

async function listen(options: Record<string, unknown>): Promise<{
  server: Server;
  origin: string;
}> {
  const create = exported('createManufacturingRunServer');
  const server = create(options) as Server;
  openServers.push(server);
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function post(
  origin: string,
  path: string,
  value: unknown,
  headerOverrides: Record<string, string> = {}
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(value));
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { ...sign(body, path), ...headerOverrides },
    body,
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

describe('manufacturing run HTTP server', () => {
  it('keeps shallow GET /healthz public and touches no coordinator dependency', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(Object.values(harness.calls)).toEqual(
      Array(Object.keys(harness.calls).length).fill(0)
    );
  });

  it('returns a cache-safe runtime identity only for a valid nonce probe', async () => {
    const harness = fakes({
      runtimeIdentity: {
        instanceId: 'instance-1',
        processId: 4242,
        releaseOid: 'a'.repeat(40),
        materialSha256: 'b'.repeat(64),
        startedAt: '2026-08-12T10:00:00.000Z',
      },
    });
    const { origin } = await listen(harness.options);
    const nonce = 'nonce_0123456789abcdef';
    const response = await fetch(`${origin}/healthz?probe=${nonce}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ok',
      nonce,
      releaseOid: 'a'.repeat(40),
      materialSha256: 'b'.repeat(64),
      instanceId: 'instance-1',
      processId: 4242,
      startedAt: '2026-08-12T10:00:00.000Z',
    });
    expect(Object.values(harness.calls)).toEqual(
      Array(Object.keys(harness.calls).length).fill(0)
    );
    expect((await fetch(`${origin}/healthz?probe=short`)).status).toBe(400);
  });

  it('fails the identity probe closed when the release OID is unavailable', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const response = await fetch(`${origin}/healthz?probe=nonce_0123456789abcdef`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'RUNTIME_IDENTITY_UNAVAILABLE' },
    });
  });

  it('rejects unknown routes, wrong methods, queries, and non-JSON bodies', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    expect((await fetch(`${origin}/debug`)).status).toBe(404);
    expect((await fetch(`${origin}/v1/manufacturing-runs/status`)).status).toBe(405);
    expect((await post(
      origin,
      '/v1/manufacturing-runs/status?debug=true',
      { operationId: 'operation-1' }
    )).status).toBe(404);
    const body = Buffer.from('{}');
    expect((await fetch(`${origin}/v1/manufacturing-runs/status`, {
      method: 'POST',
      headers: { ...sign(body, '/v1/manufacturing-runs/status'), 'content-type': 'text/plain' },
      body,
    })).status).toBe(415);
  });

  it('authenticates the raw body before JSON parsing or coordinator access', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const path = '/v1/manufacturing-runs/status';
    const malformed = Buffer.from('{"operationId":');
    const invalid = sign(malformed, path);
    invalid['x-inflow-signature'] = '00'.repeat(32);
    const unauthorized = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: invalid,
      body: malformed,
    });
    expect(unauthorized.status).toBe(401);
    expect(((await unauthorized.json()) as any).failure.code)
      .toBe('AUTHENTICATION_FAILED');
    expect(harness.calls.status).toBe(0);

    const badJson = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: sign(malformed, path),
      body: malformed,
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as any).failure.code).toBe('INVALID_JSON');
    expect(harness.calls.status).toBe(0);
  });

  it('exposes proven-no-write re-arm only as an authenticated exact operator action', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const path = '/v1/manufacturing-runs/operator/rearm-proven-no-write';

    const accepted = await post(origin, path, {
      operationId: 'operation-1',
      expectedRevision: 4,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      schemaVersion: 'manufacturing-run/v1',
      operationId: 'operation-1',
    });
    expect(harness.rearmInputs).toEqual([{
      operationId: 'operation-1',
      expectedRevision: 4,
    }]);
    expect(harness.calls).toMatchObject({
      rearm: 1,
      snapshot: 1,
      status: 0,
      runOne: 0,
      dispatch: 0,
    });

    const unsigned = await post(origin, path, {
      operationId: 'operation-1',
      expectedRevision: 4,
    }, { 'x-inflow-signature': '00'.repeat(32) });
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as any).failure.code)
      .toBe('AUTHENTICATION_FAILED');

    for (const invalidBody of [
      { operationId: 'operation-1' },
      { operationId: 'operation-1', expectedRevision: '4' },
      { operationId: 'operation-1', expectedRevision: 4, automatic: true },
    ]) {
      const invalid = await post(origin, path, invalidBody);
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as any).failure.code)
        .toBe('INVALID_REQUEST_BODY');
    }
    expect((await post(origin, `${path}?automatic=true`, {
      operationId: 'operation-1',
      expectedRevision: 4,
    })).status).toBe(404);
    expect(harness.calls.rearm).toBe(1);
    expect(harness.calls.runOne).toBe(0);
    expect(harness.calls.dispatch).toBe(0);
  });

  it('returns 202 after durable begin acceptance without running or dispatching work', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-1',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      schemaVersion: 'manufacturing-run/v1',
      operationId: 'operation-1',
      state: 'collecting',
    });
    expect(harness.calls).toMatchObject({
      begin: 1,
      runOne: 0,
      dispatch: 0,
    });
  });

  it('encodes typed Slack thread context into durable begin remarks and returns it', async () => {
    const base = fakes();
    const harness = fakes({
      store: {
        ...base.options.store,
        getRunArtifact: () => ({
          artifactType: 'begin_plan',
          artifactHash: 'artifact-hash',
          at: NOW.toISOString(),
          artifact: {
            begin: { normalizedIdentity: { finishedSerial: 'SERIAL-1' } },
            locationId: 'location-1',
            remarks: encodedContextRemarks('Started by Zapier'),
          },
        }),
      },
    });
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-context-1',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
      remarks: 'Started by Zapier',
      notificationContext,
    });

    expect(response.status).toBe(202);
    expect(harness.beginInputs).toEqual([expect.objectContaining({
      remarks: expect.stringMatching(/^\[manufacturing-run-context:v1:/),
    })]);
    expect(await response.json()).toMatchObject({ notificationContext });
  });

  it('returns the latest replay notification context instead of the original begin context', async () => {
    const replayContext = {
      slackChannelId: 'C09RUSLPQBF',
      slackThreadTs: '1700000000.000002',
      slackPermalink:
        'https://example.slack.com/archives/C2/p1700000000000001',
    };
    const replayRemarks = `[manufacturing-run-context:v1:${Buffer.from(
      JSON.stringify({
        schemaVersion: 'manufacturing-run-context/v1',
        notificationContext: replayContext,
      })
    ).toString('base64url')}]\nStarted by Zapier`;
    const base = fakes();
    const harness = fakes({
      store: {
        ...base.options.store,
        getRunArtifact: () => ({
          artifactType: 'begin_plan',
          artifactHash: 'artifact-hash',
          at: NOW.toISOString(),
          artifact: {
            begin: { normalizedIdentity: { finishedSerial: 'SERIAL-1' } },
            locationId: 'location-1',
            remarks: encodedContextRemarks('Started by Zapier'),
          },
        }),
        getLatestRunArtifactByPrefix: () => ({
          artifact: { remarks: replayRemarks },
        }),
      },
    });
    const { origin } = await listen(harness.options);

    const response = await post(origin, '/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-context-replay',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
      remarks: 'Started by Zapier',
      notificationContext: replayContext,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      notificationContext: replayContext,
    });
  });

  it('rejects parent identity fields on the public root begin route', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-child-not-allowed',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SUBASSEMBLY-1',
        finishedSerial: 'SUBASSEMBLY-1',
        parentRunHash: 'parent-run-hash',
        parentRawLineId: 'parent-line-1',
      },
      locationId: 'location-1',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failure: { code: 'INVALID_REQUEST_BODY' },
    });
    expect(harness.calls.begin).toBe(0);
  });

  it('keeps status readback-only with no worker scheduling or dispatch', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/status', {
      operationId: 'operation-1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operationId: 'operation-1',
      state: 'collecting',
    });
    expect(harness.calls).toMatchObject({
      status: 1,
      snapshot: 1,
      runOne: 0,
      dispatch: 0,
    });
  });

  it('never derives a child identity from the root finished serial', async () => {
    const base = fakes();
    for (const expectedComponents of [
      [{
        rawLineId: 'line-1',
        productId: '00000000000001',
        quantity: '1',
        disposition: 'missing',
      }],
      [{
        rawLineId: 'line-1',
        productId: '00000000000001',
        quantity: '2',
        disposition: 'missing',
      }],
      [
        {
          rawLineId: 'line-1',
          productId: '00000000000001',
          quantity: '1',
          disposition: 'missing',
        },
        {
          rawLineId: 'line-2',
          productId: 'another-product',
          quantity: '1',
          disposition: 'missing',
        },
      ],
    ] as const) {
      const harness = fakes({
        coordinator: {
          ...base.options.coordinator,
          snapshot: () => ({ ...snapshot, expectedComponents }),
        },
        store: {
          ...base.options.store,
          getRunArtifact: () => ({
            artifactType: 'begin_plan',
            artifactHash: 'artifact-hash',
            at: NOW.toISOString(),
            artifact: {
              begin: {
                normalizedIdentity: {
                  finishedSerial: 'SERIAL-SYNTHETIC-003',
                },
              },
              locationId: 'location-1',
              remarks: 'legacy remarks without Slack context',
            },
          }),
        },
      });
      const { origin } = await listen(harness.options);
      const response = await post(origin, '/v1/manufacturing-runs/status', {
        operationId: 'operation-1',
      });
      const body = await response.json() as any;
      expect(body.expectedComponents.filter(
        (component: any) => component.childFinishedSerial !== undefined
      )).toHaveLength(0);
    }
  });

  it('fails a terminal claim before durable claim mutation when thread context is absent', async () => {
    const base = fakes();
    const harness = fakes({
      store: {
        ...base.options.store,
        getNotification: () => ({
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: 'pending',
        }),
        getRunArtifact: () => ({
          artifactType: 'begin_plan',
          artifactHash: 'artifact-hash',
          at: NOW.toISOString(),
          artifact: {
            begin: { normalizedIdentity: { finishedSerial: 'SERIAL-1' } },
            locationId: 'location-1',
            remarks: 'legacy run with no thread context',
          },
        }),
      },
    });
    const { origin } = await listen(harness.options);
    const response = await post(
      origin,
      '/v1/manufacturing-runs/notifications/claim',
      {
        notificationId: 'notification-1',
        claimantId: 'slack-worker',
        claimTtlMs: 30_000,
      }
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      failure: { code: 'NOTIFICATION_CONTEXT_REQUIRED' },
    });
    expect(harness.calls.claim).toBe(0);
  });

  it('returns the exact durable Slack context on a terminal claim', async () => {
    const base = fakes();
    const harness = fakes({
      store: {
        ...base.options.store,
        getNotification: () => ({
          notificationId: 'notification-1',
          operationId: 'operation-1',
          status: 'pending',
        }),
        getRunArtifact: () => ({
          artifactType: 'begin_plan',
          artifactHash: 'artifact-hash',
          at: NOW.toISOString(),
          artifact: {
            begin: { normalizedIdentity: { finishedSerial: 'SERIAL-1' } },
            locationId: 'location-1',
            remarks: encodedContextRemarks('root remarks'),
          },
        }),
      },
    });
    const { origin } = await listen(harness.options);
    const response = await post(
      origin,
      '/v1/manufacturing-runs/notifications/claim',
      {
        notificationId: 'notification-1',
        claimantId: 'slack-worker',
        claimTtlMs: 30_000,
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notificationContext,
      notification: notificationContext,
    });
    expect(base.calls.claim).toBe(1);
  });

  it('exposes only the exact component, notification, and operator facades', async () => {
    const harness = fakes();
    const { origin } = await listen(harness.options);
    expect((await post(origin, '/v1/manufacturing-runs/component/resolve', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
    })).status).toBe(200);
    expect((await post(origin, '/v1/manufacturing-runs/component', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      productId: 'product-1',
      quantity: '1',
      locationId: 'location-1',
      serialized: false,
      serialNumbers: [],
    })).status).toBe(200);
    expect((await post(origin, '/v1/manufacturing-runs/notifications/claim', {
      notificationId: 'notification-1',
      claimantId: 'slack-worker',
      claimTtlMs: 30_000,
    })).status).toBe(200);
    expect((await post(origin, '/v1/manufacturing-runs/notifications/ack', {
      notificationId: 'notification-1',
      claimToken: 'claim-token',
      slackTimestamp: '1712345678.000100',
      permalink: 'https://example.slack.com/archives/C1/p1712345678000100',
    })).status).toBe(200);
    expect((await post(
      origin,
      '/v1/manufacturing-runs/notifications/delivery-unknown',
      {
        notificationId: 'notification-1',
        claimToken: 'claim-token',
        reason: 'Slack response lost after request dispatch',
      }
    )).status).toBe(200);
    expect((await post(
      origin,
      '/v1/manufacturing-runs/notifications/reconcile',
      {
        notificationId: 'notification-1',
        action: 'retry_after_duplicate_risk',
        operatorId: 'operator-1',
      }
    )).status).toBe(200);
    expect((await post(origin, '/v1/manufacturing-runs/operator/resolve', {
      operationId: 'operation-1',
      expectedRevision: 4,
      operatorId: 'operator-1',
      action: 'resolve',
      approvedAt: Math.floor(NOW.getTime() / 1_000),
    })).status).toBe(200);
    expect((await post(
      origin,
      '/v1/manufacturing-runs/operator/rearm-proven-no-write',
      {
        operationId: 'operation-1',
        expectedRevision: 4,
      }
    )).status).toBe(200);
    expect((await post(origin, '/v1/manufacturing-runs/notification/claim', {})).status)
      .toBe(404);
    expect(harness.calls).toMatchObject({
      resolve: 1,
      register: 1,
      claim: 1,
      ack: 1,
      deliveryUnknown: 1,
      reconcile: 1,
      manual: 1,
      rearm: 1,
    });
    expect(harness.manualInputs).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        expectedRevision: 4,
        operatorId: 'operator-1',
        action: 'resolve',
        approvedAt: Math.floor(NOW.getTime() / 1_000),
        approvalEvidence: expect.objectContaining({
          version: VERSION,
          kid: 'current',
          timestamp: Math.floor(NOW.getTime() / 1_000),
          nonce: expect.any(String),
          bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    ]);
  });

  it('returns readiness in the v1 envelope and maps a closed gate to 503', async () => {
    const harness = fakes({
      readiness: async () => ({
        schemaVersion: 'manufacturing-run-readiness/v1',
        ready: false,
        checkedAt: NOW.toISOString(),
        checks: {
          gate: { ok: false, code: 'WRITE_GATE_CLOSED' },
        },
      }),
    });
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/ready', {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      schemaVersion: 'manufacturing-run/v1',
      failure: { code: 'WRITE_GATE_CLOSED' },
      readiness: { ready: false },
    });
  });

  it('bounds bodies and emits only redacted structured logs', async () => {
    const logs: unknown[] = [];
    const harness = fakes({
      logger: (entry: unknown) => logs.push(entry),
      limits: {
        bodyLimitBytes: 128,
        requestTimeoutMs: 100,
        headersTimeoutMs: 500,
        keepAliveTimeoutMs: 500,
        maxHeaderBytes: 16_384,
      },
    });
    const { origin } = await listen(harness.options);
    const path = '/v1/manufacturing-runs/status';
    const body = Buffer.from(JSON.stringify({
      operationId: 'operation-1',
      secret: 'never-log-this-secret'.repeat(20),
    }));
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: sign(body, path),
      body,
    });
    expect(response.status).toBe(413);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('never-log-this-secret');
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('x-inflow-signature');
    expect(serialized).not.toContain('stack');
  });

  it('configures header/request/keepalive limits and terminates a stalled body', async () => {
    const harness = fakes();
    const { server } = await listen(harness.options);
    expect(server.requestTimeout).toBe(100);
    expect(server.headersTimeout).toBe(500);
    expect(server.keepAliveTimeout).toBe(500);
    const address = server.address() as AddressInfo;
    const headerSocket = createConnection({
      host: '127.0.0.1',
      port: address.port,
    });
    await once(headerSocket, 'connect');
    headerSocket.write([
      'POST /v1/manufacturing-runs/status HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      `X-Oversized: ${'x'.repeat(17_000)}`,
      '',
      '',
    ].join('\r\n'));
    const [headerChunk] = await once(headerSocket, 'data') as [Buffer];
    expect(headerChunk.toString('utf8')).toContain('431');
    headerSocket.destroy();

    const socket = createConnection({
      host: '127.0.0.1',
      port: address.port,
    });
    await once(socket, 'connect');
    socket.write([
      'POST /v1/manufacturing-runs/status HTTP/1.1',
      `Host: 127.0.0.1:${address.port}`,
      'Content-Type: application/json',
      'Content-Length: 20',
      '',
      '{',
    ].join('\r\n'));
    const [chunk] = await once(socket, 'data') as [Buffer];
    expect(chunk.toString('utf8')).toContain('408');
    socket.destroy();
  });

  it.each([
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['UNSUPPORTED_MO_SHAPE', 422],
    ['RUN_NOT_MANUALLY_RESOLVABLE', 423],
    ['WRITE_GATE_CLOSED', 503],
    ['UNEXPECTED_INTERNAL_FAILURE', 503],
  ])('maps %s without returning internal error detail', async (code, expected) => {
    const harness = fakes({
      coordinator: {
        ...fakes().options.coordinator as object,
        begin: () => {
          throw new Error(`${code}: apiKey=secret /private/path`);
        },
      },
    });
    const { origin } = await listen(harness.options);
    const response = await post(origin, '/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-1',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
    });
    expect(response.status).toBe(expected);
    const text = await response.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/private');
    expect(text).not.toContain('stack');
  });

  it('maps a stale notification claim acknowledgement to 409', async () => {
    const base = fakes();
    const harness = fakes({
      store: {
        ...base.options.store,
        ackNotification: () => {
          throw new Error('NOTIFICATION_CLAIM_CONFLICT');
        },
      },
    });
    const { origin } = await listen(harness.options);
    const response = await post(
      origin,
      '/v1/manufacturing-runs/notifications/ack',
      {
        notificationId: 'notification-1',
        claimToken: 'expired-claim-token',
        slackTimestamp: '1712345678.000100',
        permalink: 'https://example.slack.com/archives/C1/p1712345678000100',
      }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      failure: { code: 'NOTIFICATION_CLAIM_CONFLICT' },
    });
  });
});
