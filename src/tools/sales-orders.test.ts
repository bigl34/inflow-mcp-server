import { describe, it, expect } from 'vitest';
import { mergeSalesOrderUpdate, upsertSalesOrderToolSchema } from './sales-orders.js';
import type { SalesOrder, SalesOrderLine } from '../types/inflow.js';

const lineFoo = (): SalesOrderLine => ({
  salesOrderLineId: 'line-foo',
  productId: 'prod-foo',
  description: 'Foo widget',
  quantity: {
    standardQuantity: 2,
    uomQuantity: 2,
    uom: 'each',
    serialNumbers: ['FOO-1', 'FOO-2'],
  },
  unitPrice: 10,
  discount: 0,
  discountType: 'Amount',
  taxCodeId: 'tax-default',
  subtotal: 20,
  sublocation: 'A1',
  lineNum: 0,
  timestamp: '2026-04-20T00:00:00Z',
});

const lineBar = (): SalesOrderLine => ({
  salesOrderLineId: 'line-bar',
  productId: 'prod-bar',
  quantity: {
    standardQuantity: 5,
    uomQuantity: 5,
    uom: 'each',
    serialNumbers: [],
  },
  unitPrice: 3,
  taxCodeId: 'tax-default',
  subtotal: 15,
  lineNum: 1,
  timestamp: '2026-04-20T00:00:00Z',
});

const existingOrder = (): SalesOrder => ({
  salesOrderId: 'so-123',
  orderNumber: 'ORDER-001',
  orderDate: '2026-04-20T00:00:00Z',
  customerId: 'cust-example',
  locationId: 'loc-primary',
  orderRemarks: 'original remark',
  customFields: { custom4: 'https://your-commerce-platform.example/orders/ORDER_ID' },
  timestamp: '2026-04-20T00:00:00Z',
  lines: [lineFoo(), lineBar()],
});

describe('mergeSalesOrderUpdate', () => {
  it('persists serialNumbers on a matched line while preserving every other field', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      timestamp: '2026-04-20T00:00:00Z',
      items: [
        {
          id: 'line-foo',
          serialNumbers: ['FOO-1', 'FOO-2', 'FOO-3'],
        },
      ],
    });

    expect(merged.lines).toHaveLength(2);

    const patchedFoo = merged.lines?.[0] as SalesOrderLine;
    expect(patchedFoo.salesOrderLineId).toBe('line-foo');
    // serialNumbers was updated
    expect(
      (patchedFoo.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['FOO-1', 'FOO-2', 'FOO-3']);
    // every other line-level field is preserved verbatim
    expect((patchedFoo.quantity as { standardQuantity: number }).standardQuantity).toBe(2);
    expect((patchedFoo.quantity as { uomQuantity: number }).uomQuantity).toBe(2);
    expect(patchedFoo.unitPrice).toBe(10);
    expect(patchedFoo.taxCodeId).toBe('tax-default');
    expect(patchedFoo.subtotal).toBe(20);
    expect(patchedFoo.lineNum).toBe(0);
    expect(patchedFoo.timestamp).toBe('2026-04-20T00:00:00Z');
    expect(patchedFoo.description).toBe('Foo widget');

    // untouched line passes through verbatim
    expect(merged.lines?.[1]).toEqual(lineBar());
  });

  it('matches by unambiguous productId when no id is given', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      items: [{ productId: 'prod-bar', serialNumbers: ['BAR-NEW'] }],
    });

    const patchedBar = merged.lines?.find((line) => line.productId === 'prod-bar');
    expect(patchedBar).toBeDefined();
    expect(
      (patchedBar!.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['BAR-NEW']);
    expect(merged.lines).toHaveLength(2);
  });

  it('allows update payloads without customerId and preserves the existing customer', () => {
    expect(upsertSalesOrderToolSchema.customerId.safeParse(undefined).success).toBe(true);

    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      items: [{ id: 'line-foo', serialNumbers: ['FOO-UPDATE'] }],
    });

    expect(merged.customerId).toBe('cust-example');
    const patchedFoo = merged.lines?.[0] as SalesOrderLine;
    expect(
      (patchedFoo.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['FOO-UPDATE']);
  });

  it('throws on ambiguous productId matches', () => {
    const existing: SalesOrder = {
      ...existingOrder(),
      lines: [
        { ...lineFoo(), salesOrderLineId: 'line-a' },
        { ...lineFoo(), salesOrderLineId: 'line-b' },
      ],
    };

    expect(() =>
      mergeSalesOrderUpdate(existing, {
        id: 'so-123',
        customerId: 'cust-example',
        items: [{ productId: 'prod-foo', serialNumbers: ['ZZZ'] }],
      })
    ).toThrow(/Ambiguous line patch: productId prod-foo matches 2 existing lines/);
  });

  it('appends a new line when no match and does not touch existing lines', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      items: [
        {
          productId: 'prod-new',
          quantity: 4,
          unitPrice: 99,
          serialNumbers: ['NEW-1'],
        },
      ],
    });

    expect(merged.lines).toHaveLength(3);
    expect(merged.lines?.[0]).toEqual(lineFoo());
    expect(merged.lines?.[1]).toEqual(lineBar());

    const appended = merged.lines?.[2] as SalesOrderLine;
    expect(appended.productId).toBe('prod-new');
    expect(appended.unitPrice).toBe(99);
    expect(appended.salesOrderLineId).toBeDefined();
    expect(
      (appended.quantity as { standardQuantity: number }).standardQuantity
    ).toBe(4);
    expect(
      (appended.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['NEW-1']);
  });

  it('leaves lines untouched on a header-only update', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      remarks: 'shipping monday',
    });

    expect(merged.orderRemarks).toBe('shipping monday');
    expect(merged.lines).toEqual([lineFoo(), lineBar()]);
    // customFields not mentioned → preserved
    expect(merged.customFields).toEqual({
      custom4: 'https://your-commerce-platform.example/orders/ORDER_ID',
    });
  });

  it('removes lines listed in deleteLineIds without touching others', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      deleteLineIds: ['line-foo'],
    });

    expect(merged.lines).toHaveLength(1);
    expect(merged.lines?.[0]).toEqual(lineBar());
  });

  it('supports mixed-op updates: patch one line, add another, delete a third in one call', () => {
    const existing: SalesOrder = {
      ...existingOrder(),
      lines: [
        lineFoo(),
        lineBar(),
        {
          salesOrderLineId: 'line-baz',
          productId: 'prod-baz',
          quantity: { standardQuantity: 1, uomQuantity: 1, serialNumbers: [] },
          unitPrice: 50,
          taxCodeId: 'tax-default',
          subtotal: 50,
          lineNum: 2,
          timestamp: '2026-04-20T00:00:00Z',
        },
      ],
    };

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      items: [
        { id: 'line-foo', serialNumbers: ['FOO-NEW'] },
        { productId: 'prod-brand-new', quantity: 1, serialNumbers: ['SHINY-1'] },
      ],
      deleteLineIds: ['line-baz'],
    });

    expect(merged.lines).toHaveLength(3);

    const patchedFoo = merged.lines?.find((line) => line.salesOrderLineId === 'line-foo');
    expect(
      (patchedFoo!.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['FOO-NEW']);

    const untouchedBar = merged.lines?.find((line) => line.salesOrderLineId === 'line-bar');
    expect(untouchedBar).toEqual(lineBar());

    const bazStillThere = merged.lines?.find((line) => line.salesOrderLineId === 'line-baz');
    expect(bazStillThere).toBeUndefined();

    const appended = merged.lines?.find((line) => line.productId === 'prod-brand-new');
    expect(appended).toBeDefined();
    expect(
      (appended!.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['SHINY-1']);
  });

  it('can clear a line\'s serialNumbers by passing an empty array (presence, not truthiness)', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      items: [{ id: 'line-foo', serialNumbers: [] }],
    });

    const patched = merged.lines?.[0] as SalesOrderLine;
    expect(
      (patched.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual([]);
    // quantity numbers preserved
    expect(
      (patched.quantity as { standardQuantity: number }).standardQuantity
    ).toBe(2);
  });

  it('upgrades a primitive-number quantity to the object form when serialNumbers arrive', () => {
    const existing: SalesOrder = {
      ...existingOrder(),
      lines: [
        {
          salesOrderLineId: 'line-primitive',
          productId: 'prod-primitive',
          quantity: 3,
          unitPrice: 7,
        },
      ],
    };

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      items: [{ id: 'line-primitive', serialNumbers: ['P-1', 'P-2', 'P-3'] }],
    });

    const patched = merged.lines?.[0] as SalesOrderLine;
    expect(typeof patched.quantity).toBe('object');
    expect((patched.quantity as { standardQuantity: number }).standardQuantity).toBe(3);
    expect((patched.quantity as { uomQuantity: number }).uomQuantity).toBe(3);
    expect(
      (patched.quantity as { serialNumbers?: string[] }).serialNumbers
    ).toEqual(['P-1', 'P-2', 'P-3']);
  });

  it('merges header fields like nonCustomerCost via presence rather than truthiness', () => {
    const existing = existingOrder();

    const merged = mergeSalesOrderUpdate(existing, {
      id: 'so-123',
      customerId: 'cust-example',
      nonCustomerCost: 0,
    });

    expect(merged.nonCustomerCost).toBe(0);
    // Lines, customFields, and orderRemarks all preserved
    expect(merged.lines).toEqual([lineFoo(), lineBar()]);
    expect(merged.customFields).toEqual({
      custom4: 'https://your-commerce-platform.example/orders/ORDER_ID',
    });
    expect(merged.orderRemarks).toBe('original remark');
  });
});
