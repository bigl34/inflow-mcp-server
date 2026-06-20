import { describe, it, expect } from 'vitest';
import {
  mergeManufacturingOrderUpdate,
  buildManufacturingOrderLines,
} from './manufacturing-orders.js';
import type {
  ManufacturingOrder,
  ManufacturingOrderLine,
} from '../types/inflow.js';

const inputLineA = (): ManufacturingOrderLine => ({
  manufacturingOrderLineId: 'line-input-a',
  productId: 'prod-component-a',
  parentManufacturingOrderLineId: 'line-output',
  quantity: {
    standardQuantity: '10',
    uomQuantity: '10',
    uom: 'each',
  },
  timestamp: '2026-04-20T00:00:00Z',
});

const inputLineB = (): ManufacturingOrderLine => ({
  manufacturingOrderLineId: 'line-input-b',
  productId: 'prod-component-b',
  parentManufacturingOrderLineId: 'line-output',
  quantity: {
    standardQuantity: '20',
    uomQuantity: '20',
    uom: 'each',
  },
  timestamp: '2026-04-20T00:00:00Z',
});

const outputLine = (): ManufacturingOrderLine => ({
  manufacturingOrderLineId: 'line-output',
  productId: 'prod-finished',
  parentManufacturingOrderLineId: null,
  description: 'Finished product',
  quantity: {
    standardQuantity: '10',
    uomQuantity: '10',
    uom: 'each',
    serialNumbers: ['SERIAL-1', 'SERIAL-2'],
  },
  timestamp: '2026-04-20T00:00:00Z',
  manufacturingOrderLines: [inputLineA(), inputLineB()],
});

const existingOrder = (): ManufacturingOrder => ({
  manufacturingOrderId: 'mo-170',
  manufacturingOrderNumber: 'MO-001',
  orderDate: '2026-04-20T00:00:00Z',
  dueDate: '2026-05-01T00:00:00Z',
  locationId: 'loc-primary',
  primaryFinishedProductId: 'prod-finished',
  remarks: 'original remark',
  isCancelled: false,
  isCompleted: false,
  customFields: { custom1: 'batch-A' },
  timestamp: '2026-04-20T00:00:00Z',
  lines: [outputLine()],
});

describe('mergeManufacturingOrderUpdate', () => {
  it('persists outputSerialNumbers on the parent line while preserving every other field', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      timestamp: '2026-04-20T00:00:00Z',
      outputSerialNumbers: ['SERIAL-1', 'SERIAL-2', 'SERIAL-3'],
    });

    expect(merged.lines).toHaveLength(1);

    const parent = merged.lines![0];
    // outputSerialNumbers updated
    expect(parent.quantity?.serialNumbers).toEqual(['SERIAL-1', 'SERIAL-2', 'SERIAL-3']);
    // other quantity fields preserved verbatim
    expect(parent.quantity?.standardQuantity).toBe('10');
    expect(parent.quantity?.uomQuantity).toBe('10');
    expect(parent.quantity?.uom).toBe('each');
    // every other parent-line field preserved
    expect(parent.manufacturingOrderLineId).toBe('line-output');
    expect(parent.productId).toBe('prod-finished');
    expect(parent.description).toBe('Finished product');
    expect(parent.parentManufacturingOrderLineId).toBeNull();
    expect(parent.timestamp).toBe('2026-04-20T00:00:00Z');

    // child input lines untouched
    expect(parent.manufacturingOrderLines).toEqual([inputLineA(), inputLineB()]);

    // header fields preserved
    expect(merged.remarks).toBe('original remark');
    expect(merged.customFields).toEqual({ custom1: 'batch-A' });
    expect(merged.primaryFinishedProductId).toBe('prod-finished');
  });

  it('clears outputSerialNumbers when given an empty array (presence, not truthiness)', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      outputSerialNumbers: [],
    });

    expect(merged.lines![0].quantity?.serialNumbers).toEqual([]);
    // quantity numbers preserved
    expect(merged.lines![0].quantity?.standardQuantity).toBe('10');
  });

  it('patches an input line by id, leaving siblings and the output line untouched', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      inputLines: [{ id: 'line-input-a', quantity: 15 }],
    });

    const parent = merged.lines![0];
    const children = parent.manufacturingOrderLines!;
    expect(children).toHaveLength(2);

    const patchedA = children.find((l) => l.manufacturingOrderLineId === 'line-input-a')!;
    expect(patchedA.quantity?.standardQuantity).toBe('15');
    expect(patchedA.quantity?.uomQuantity).toBe('15');
    // uom preserved (presence-based merge on quantity)
    expect(patchedA.quantity?.uom).toBe('each');

    // B untouched
    expect(children.find((l) => l.manufacturingOrderLineId === 'line-input-b')).toEqual(inputLineB());

    // output quantity + serials untouched
    expect(parent.quantity?.standardQuantity).toBe('10');
    expect(parent.quantity?.serialNumbers).toEqual(['SERIAL-1', 'SERIAL-2']);
  });

  it('matches an input line by unambiguous productId when no id is given', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      inputLines: [{ productId: 'prod-component-b', quantity: 99 }],
    });

    const children = merged.lines![0].manufacturingOrderLines!;
    const patchedB = children.find((l) => l.productId === 'prod-component-b')!;
    expect(patchedB.quantity?.standardQuantity).toBe('99');
    expect(children).toHaveLength(2);
  });

  it('throws on ambiguous input-line productId matches', () => {
    const existing: ManufacturingOrder = {
      ...existingOrder(),
      lines: [
        {
          ...outputLine(),
          manufacturingOrderLines: [
            { ...inputLineA(), manufacturingOrderLineId: 'line-dup-1' },
            { ...inputLineA(), manufacturingOrderLineId: 'line-dup-2' },
          ],
        },
      ],
    };

    expect(() =>
      mergeManufacturingOrderUpdate(existing, {
        id: 'mo-170',
        inputLines: [{ productId: 'prod-component-a', quantity: 5 }],
      })
    ).toThrow(
      /Ambiguous input line patch: productId prod-component-a matches 2 existing lines/
    );
  });

  it('appends a new input line when no match and does not touch existing lines', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      inputLines: [{ productId: 'prod-component-new', quantity: 4 }],
    });

    const children = merged.lines![0].manufacturingOrderLines!;
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual(inputLineA());
    expect(children[1]).toEqual(inputLineB());

    const appended = children[2];
    expect(appended.productId).toBe('prod-component-new');
    expect(appended.manufacturingOrderLineId).toBeDefined();
    expect(appended.quantity?.standardQuantity).toBe('4');
    expect(appended.quantity?.uomQuantity).toBe('4');
  });

  it('removes input lines listed in deleteInputLineIds without touching others', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      deleteInputLineIds: ['line-input-a'],
    });

    const children = merged.lines![0].manufacturingOrderLines!;
    expect(children).toHaveLength(1);
    expect(children[0]).toEqual(inputLineB());

    // output untouched
    expect(merged.lines![0].quantity?.serialNumbers).toEqual(['SERIAL-1', 'SERIAL-2']);
  });

  it('leaves lines untouched on a header-only update', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      remarks: 'rescheduled to Friday',
    });

    expect(merged.remarks).toBe('rescheduled to Friday');
    expect(merged.lines).toEqual([outputLine()]);
    // customFields not mentioned → preserved
    expect(merged.customFields).toEqual({ custom1: 'batch-A' });
  });

  it('supports mixed-op updates: patch one input, add another, delete a third, update output serials', () => {
    const existing: ManufacturingOrder = {
      ...existingOrder(),
      lines: [
        {
          ...outputLine(),
          manufacturingOrderLines: [
            inputLineA(),
            inputLineB(),
            {
              manufacturingOrderLineId: 'line-input-c',
              productId: 'prod-component-c',
              parentManufacturingOrderLineId: 'line-output',
              quantity: { standardQuantity: '1', uomQuantity: '1' },
              timestamp: '2026-04-20T00:00:00Z',
            },
          ],
        },
      ],
    };

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      outputSerialNumbers: ['SERIAL-NEW-1', 'SERIAL-NEW-2'],
      inputLines: [
        { id: 'line-input-a', quantity: 7 },
        { productId: 'prod-component-fresh', quantity: 3 },
      ],
      deleteInputLineIds: ['line-input-c'],
    });

    const parent = merged.lines![0];
    expect(parent.quantity?.serialNumbers).toEqual(['SERIAL-NEW-1', 'SERIAL-NEW-2']);

    const children = parent.manufacturingOrderLines!;
    expect(children).toHaveLength(3);

    const patchedA = children.find((l) => l.manufacturingOrderLineId === 'line-input-a')!;
    expect(patchedA.quantity?.standardQuantity).toBe('7');

    const untouchedB = children.find((l) => l.manufacturingOrderLineId === 'line-input-b')!;
    expect(untouchedB).toEqual(inputLineB());

    const cGone = children.find((l) => l.manufacturingOrderLineId === 'line-input-c');
    expect(cGone).toBeUndefined();

    const appended = children.find((l) => l.productId === 'prod-component-fresh')!;
    expect(appended.quantity?.standardQuantity).toBe('3');
  });

  it('applies isCancelled header field via presence-based merge (cancel flow)', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      isCancelled: true,
      timestamp: '2026-04-20T00:00:00Z',
    });

    expect(merged.isCancelled).toBe(true);
    // Lines unchanged verbatim
    expect(merged.lines).toEqual([outputLine()]);
    // Other header fields preserved
    expect(merged.remarks).toBe('original remark');
    expect(merged.primaryFinishedProductId).toBe('prod-finished');
  });

  it('patches outputQuantity while preserving serialNumbers (presence-based quantity merge)', () => {
    const existing = existingOrder();

    const merged = mergeManufacturingOrderUpdate(existing, {
      id: 'mo-170',
      outputQuantity: 42,
    });

    expect(merged.lines![0].quantity?.standardQuantity).toBe('42');
    expect(merged.lines![0].quantity?.uomQuantity).toBe('42');
    // serialNumbers untouched because outputSerialNumbers was not in args
    expect(merged.lines![0].quantity?.serialNumbers).toEqual(['SERIAL-1', 'SERIAL-2']);
  });
});

describe('buildManufacturingOrderLines', () => {
  it('populates outputSerialNumbers on the parent line quantity', () => {
    const lines = buildManufacturingOrderLines(
      'prod-finished',
      2,
      [{ productId: 'prod-component-a', quantity: 2 }],
      ['SERIAL-CREATE-1', 'SERIAL-CREATE-2']
    );

    expect(lines).toHaveLength(1);
    const parent = lines[0];
    expect(parent.productId).toBe('prod-finished');
    expect(parent.parentManufacturingOrderLineId).toBeNull();
    expect(parent.quantity?.standardQuantity).toBe('2');
    expect(parent.quantity?.serialNumbers).toEqual(['SERIAL-CREATE-1', 'SERIAL-CREATE-2']);

    const children = parent.manufacturingOrderLines!;
    expect(children).toHaveLength(1);
    expect(children[0].productId).toBe('prod-component-a');
    expect(children[0].quantity?.standardQuantity).toBe('2');
  });

  it('omits parent serialNumbers when outputSerialNumbers is not passed', () => {
    const lines = buildManufacturingOrderLines('prod-finished', 5);
    expect(lines[0].quantity?.serialNumbers).toBeUndefined();
  });
});
