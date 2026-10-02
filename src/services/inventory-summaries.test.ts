import { describe, expect, it } from 'vitest';
import {
  canonicalInventorySummaryProjection,
  canonicalSerialInventoryProjection,
  directBuildOwnershipEvidence,
  directBuildReservationCredit,
  effectiveBuildRunAvailableQuantity,
} from './inventory-summaries.js';

describe('manufacturing canary inventory projections', () => {
  it('normalizes decimal strings/numbers and sorts product, location, and sublocation rows', () => {
    expect(canonicalInventorySummaryProjection([
      {
        productId: 'product-b',
        quantityOnHand: 2,
        quantityAvailable: '1.00',
        quantityOnOrder: '0.0',
        quantityAllocated: 1,
        locationSummaries: [{
          locationId: 'location-b',
          locationName: 'B',
          quantityOnHand: '2.0',
          quantityAvailable: 1,
          sublocationSummaries: [
            { sublocation: 'z', quantityOnHand: '1.00', quantityAvailable: '0.0' },
            { sublocation: 'a', quantityOnHand: 1, quantityAvailable: '1.0' },
          ],
        }],
      },
      {
        productId: 'product-a',
        quantityOnHand: '0.00',
        quantityAvailable: 0,
        quantityOnOrder: 0,
        quantityAllocated: '0',
      },
    ] as any)).toEqual([
      {
        productId: 'product-a',
        quantityAllocated: '0',
        quantityAvailable: '0',
        quantityOnHand: '0',
        quantityOnOrder: '0',
        locations: [],
      },
      {
        productId: 'product-b',
        quantityAllocated: '1',
        quantityAvailable: '1',
        quantityOnHand: '2',
        quantityOnOrder: '0',
        locations: [{
          locationId: 'location-b',
          quantityAvailable: '1',
          quantityOnHand: '2',
          sublocations: [
            {
              sublocation: 'a',
              quantityAvailable: '1',
              quantityOnHand: '1',
            },
            {
              sublocation: 'z',
              quantityAvailable: '0',
              quantityOnHand: '1',
            },
          ],
        }],
      },
    ]);
  });

  it('watches only approved product/serial pairs and exposes missing or moved holdings', () => {
    const watched = [
      { productId: 'product-a', serial: 'SERIAL-A' },
      { productId: 'product-b', serial: 'SERIAL-B' },
    ];
    const before = canonicalSerialInventoryProjection([
      {
        productId: 'product-a',
        inventoryLines: [
          { serial: 'SERIAL-A', locationId: 'source', sublocation: 'bin-1', quantityOnHand: '1.00' },
          { serial: 'UNWATCHED', locationId: 'source', quantityOnHand: '1' },
        ],
      },
    ], watched);
    const moved = canonicalSerialInventoryProjection([
      {
        productId: 'product-a',
        inventoryLines: [
          { serial: 'SERIAL-A', locationId: 'output', sublocation: 'bin-2', quantityOnHand: 1 as any },
        ],
      },
    ], watched);

    expect(before).toEqual([
      {
        productId: 'product-a',
        serial: 'SERIAL-A',
        holdings: [{ locationId: 'source', sublocation: 'bin-1', quantityOnHand: '1' }],
      },
      { productId: 'product-b', serial: 'SERIAL-B', holdings: [] },
    ]);
    expect(moved).not.toEqual(before);
  });

  it('adds back build-only reservations for a manufacturing run without accepting direct allocations', () => {
    expect(effectiveBuildRunAvailableQuantity({
      quantityOnHand: '2',
      quantityAvailable: '0',
      rawQuantityAvailable: '2',
      quantityReserved: '2',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '0',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '2',
      quantityPicked: '0',
    }, { allowBuildReserved: true, requiredQuantity: 2 })).toBe(2);

    expect(effectiveBuildRunAvailableQuantity({
      quantityOnHand: '2',
      quantityAvailable: '0',
      quantityReserved: '2',
      quantityReservedForSales: '2',
      quantityReservedForBuilds: '0',
    }, { allowBuildReserved: true, requiredQuantity: 2 })).toBe(0);

    expect(effectiveBuildRunAvailableQuantity({
      quantityOnHand: '2',
      quantityAvailable: '0',
      quantityReserved: '2',
      quantityReservedForBuilds: '2',
    }, { allowBuildReserved: false, requiredQuantity: 2 })).toBe(0);

    expect(effectiveBuildRunAvailableQuantity({
      quantityOnHand: '2',
      quantityAvailable: '0',
      rawQuantityAvailable: '2',
      quantityReserved: '2',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '0',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '2',
    }, { allowBuildReserved: true, requiredQuantity: 2 })).toBe(0);
  });

  it('credits an exactly owned manufacturing reservation without borrowing other MO reservations', () => {
    const row = {
      quantityOnHand: '2',
      quantityAvailable: '0',
      rawQuantityAvailable: '0',
      quantityReserved: '2',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '2',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '0',
      quantityPicked: '0',
    };
    expect(effectiveBuildRunAvailableQuantity(row, {
      allowBuildReserved: true,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(2);
    expect(effectiveBuildRunAvailableQuantity(row, {
      allowBuildReserved: true,
      requiredQuantity: 2,
    })).toBe(0);
    expect(effectiveBuildRunAvailableQuantity({
      ...row,
      quantityOnHand: '3',
      quantityReserved: '3',
      quantityReservedForManufacturing: '3',
    }, {
      allowBuildReserved: true,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(0);
    expect(effectiveBuildRunAvailableQuantity({
      ...row,
      quantityReservedForSales: '1',
    }, {
      allowBuildReserved: true,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(0);
  });

  it('credits exact nested build and manufacturing projections only with complete reservation evidence', () => {
    const row = {
      quantityOnHand: '2',
      quantityAvailable: '-2',
      rawQuantityAvailable: '0',
      quantityReserved: '4',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '2',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '2',
      quantityPicked: '0',
    };
    expect(effectiveBuildRunAvailableQuantity(row, {
      allowBuildReserved: true,
      ownedBuildReservedQuantity: 2,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(2);
    expect(effectiveBuildRunAvailableQuantity(row, {
      allowBuildReserved: true,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(-2);
    expect(effectiveBuildRunAvailableQuantity({
      ...row,
      quantityReserved: undefined,
    }, {
      allowBuildReserved: true,
      ownedBuildReservedQuantity: 2,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(-2);
    expect(effectiveBuildRunAvailableQuantity({
      ...row,
      quantityReservedForSales: undefined,
    }, {
      allowBuildReserved: true,
      ownedBuildReservedQuantity: 2,
      ownedManufacturingReservedQuantity: 2,
      requiredQuantity: 2,
    })).toBe(-2);
  });

  it('makes reservation dimensions hash-significant in the canary projection', () => {
    const base = {
      productId: 'product-a',
      quantityOnHand: '2',
      quantityAvailable: '0',
      quantityOnOrder: '0',
      quantityAllocated: '2',
    };
    const buildReserved = canonicalInventorySummaryProjection([{
      ...base,
      quantityReserved: '2',
      quantityReservedForBuilds: '2',
    }]);
    const salesReserved = canonicalInventorySummaryProjection([{
      ...base,
      quantityReserved: '2',
      quantityReservedForSales: '2',
    }]);

    expect(buildReserved).not.toEqual(salesReserved);
  });

  it('rejects duplicate positive holdings for one watched product/serial', () => {
    expect(() => canonicalSerialInventoryProjection([
      {
        productId: 'product-a',
        inventoryLines: [
          { serial: 'SERIAL-A', locationId: 'source-a', quantityOnHand: '1' },
          { serial: 'SERIAL-A', locationId: 'source-b', quantityOnHand: '1' },
        ],
      },
    ], [{ productId: 'product-a', serial: 'SERIAL-A' }])).toThrow(
      'CANARY_SERIAL_DUPLICATE_POSITIVE_STOCK'
    );
  });
});

describe('direct build reservation credit', () => {
  const liveFrontMudguard = {
    quantityOnHand: '1',
    quantityAvailable: '-1',
    rawQuantityAvailable: '0',
    quantityReserved: '2',
    quantityReservedForSales: '0',
    quantityReservedForManufacturing: '1',
    quantityReservedForTransfers: '0',
    quantityReservedForBuilds: '1',
    quantityPicked: '0',
  };
  const fullyOwnedEvidence = {
    ownedManufacturingReservedQuantity: 1,
    remainingManufacturingOrderLineQuantity: 1,
    soleQualifyingManufacturingOrderLine: true,
    finishedProductOpenDemandQuantity: 1,
  };

  it('credits the live exactly-sufficient shape and clears the availability gate', () => {
    const credit = directBuildReservationCredit(
      liveFrontMudguard,
      fullyOwnedEvidence
    );
    expect(credit).toBe(1);
    expect(effectiveBuildRunAvailableQuantity(liveFrontMudguard, {
      allowBuildReserved: true,
      ownedBuildReservedQuantity: credit,
      ownedManufacturingReservedQuantity: 1,
      requiredQuantity: 1,
    })).toBe(1);
  });

  it('blocks both runs when two manufacturing orders share one build reservation', () => {
    const sharedPool = {
      quantityOnHand: '1',
      quantityAvailable: '-2',
      rawQuantityAvailable: '0',
      quantityReserved: '3',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '2',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '1',
      quantityPicked: '0',
    };
    const credit = directBuildReservationCredit(sharedPool, {
      ownedManufacturingReservedQuantity: 1,
      remainingManufacturingOrderLineQuantity: 1,
      soleQualifyingManufacturingOrderLine: false,
      finishedProductOpenDemandQuantity: 1,
    });
    expect(credit).toBe(0);
    expect(effectiveBuildRunAvailableQuantity(sharedPool, {
      allowBuildReserved: true,
      ownedBuildReservedQuantity: credit,
      ownedManufacturingReservedQuantity: 1,
      requiredQuantity: 1,
    })).toBe(-2);
  });

  it('refuses when the build reservation belongs to another finished product', () => {
    expect(directBuildReservationCredit(liveFrontMudguard, {
      ...fullyOwnedEvidence,
      finishedProductOpenDemandQuantity: 0,
    })).toBe(0);
  });

  it('refuses once any of the component stock has been picked', () => {
    expect(directBuildReservationCredit({
      ...liveFrontMudguard,
      quantityReserved: '3',
      quantityPicked: '1',
    }, fullyOwnedEvidence)).toBe(0);
  });

  it('caps the credit at the unfulfilled remainder of the order line', () => {
    expect(directBuildReservationCredit({
      ...liveFrontMudguard,
      quantityOnHand: '2',
      quantityAvailable: '-2',
      quantityReserved: '4',
      quantityReservedForManufacturing: '2',
      quantityReservedForBuilds: '2',
    }, {
      ownedManufacturingReservedQuantity: 2,
      remainingManufacturingOrderLineQuantity: 1,
      soleQualifyingManufacturingOrderLine: true,
      finishedProductOpenDemandQuantity: 2,
    })).toBe(1);
  });

  it('keeps the residual bound below a competing manufacturing reservation', () => {
    expect(directBuildReservationCredit({
      quantityOnHand: '3',
      quantityAvailable: '-2',
      rawQuantityAvailable: '1',
      quantityReserved: '5',
      quantityReservedForSales: '0',
      quantityReservedForManufacturing: '3',
      quantityReservedForTransfers: '0',
      quantityReservedForBuilds: '2',
      quantityPicked: '0',
    }, {
      ownedManufacturingReservedQuantity: 2,
      remainingManufacturingOrderLineQuantity: 2,
      soleQualifyingManufacturingOrderLine: true,
      finishedProductOpenDemandQuantity: 5,
    })).toBe(1);
  });

  it('refuses negative or non-finite evidence', () => {
    expect(directBuildReservationCredit(liveFrontMudguard, {
      ...fullyOwnedEvidence,
      remainingManufacturingOrderLineQuantity: -1,
    })).toBe(0);
    expect(directBuildReservationCredit(liveFrontMudguard, {
      ...fullyOwnedEvidence,
      finishedProductOpenDemandQuantity: Number.NaN,
    })).toBe(0);
  });

  it('derives ownership evidence from the live order and summary row', () => {
    const evidence = directBuildOwnershipEvidence({
      order: {
        manufacturingOrderId: 'mo-1',
        pickMatchings: [
          { manufacturingOrderLineId: 'rear-line', matchedQuantity: '1' },
          { manufacturingOrderLineId: 'other-line', matchedQuantity: '5' },
        ],
      },
      componentLineIds: ['rear-line'],
      componentQuantities: [2],
      summaryRow: {
        quantityReservedForManufacturing: '2',
      },
      finishedProductReservedForSales: 1,
      finishedOutputQuantity: 1,
    });
    expect(evidence).toEqual({
      ownedManufacturingReservedQuantity: 2,
      remainingManufacturingOrderLineQuantity: 1,
      soleQualifyingManufacturingOrderLine: true,
      finishedProductOpenDemandQuantity: 2,
    });
  });

  it('marks the order line as not sole when another order also reserves the component', () => {
    const evidence = directBuildOwnershipEvidence({
      order: { manufacturingOrderId: 'mo-1' },
      componentLineIds: ['front-line'],
      componentQuantities: [1],
      summaryRow: { quantityReservedForManufacturing: '2' },
      finishedProductReservedForSales: 1,
      finishedOutputQuantity: 1,
    });
    expect(evidence.soleQualifyingManufacturingOrderLine).toBe(false);
  });
});
