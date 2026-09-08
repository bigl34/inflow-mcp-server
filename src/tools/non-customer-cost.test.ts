import { describe, it, expect } from 'vitest';
import {
  toInflowMoney,
  nonCustomerCostSchema,
  mergeSalesOrderUpdate,
} from './sales-orders.js';
import type { SalesOrder } from '../types/inflow.js';

// inFlow Cloud rejects a bare number on PUT /sales-orders with HTTP 422 and
// accepts { value: "12.34000", isPercent: false }.
describe('nonCustomerCost money normalisation', () => {
  it('converts a bare number to the API money object at inFlow money scale', () => {
    expect(toInflowMoney(12.34)).toEqual({ value: '12.34000', isPercent: false });
  });

  it('normalises zero rather than dropping it', () => {
    expect(toInflowMoney(0)).toEqual({ value: '0.00000', isPercent: false });
  });

  it('passes an already-shaped money object through, defaulting isPercent', () => {
    expect(toInflowMoney({ value: '104.67000' })).toEqual({
      value: '104.67000',
      isPercent: false,
    });
  });

  it('preserves an explicit isPercent', () => {
    expect(toInflowMoney({ value: '10.00000', isPercent: true })).toEqual({
      value: '10.00000',
      isPercent: true,
    });
  });

  it('rejects a non-finite number rather than sending NaN to the API', () => {
    expect(() => toInflowMoney(Number.NaN)).toThrow(/finite/);
    expect(() => toInflowMoney(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('accepts BOTH input forms so existing bare-number callers keep working', () => {
    expect(nonCustomerCostSchema.safeParse(12.34).success).toBe(true);
    expect(
      nonCustomerCostSchema.safeParse({ value: '12.34000', isPercent: false }).success
    ).toBe(true);
  });

  it('rejects a shape that is neither', () => {
    expect(nonCustomerCostSchema.safeParse('12.34').success).toBe(false);
    expect(nonCustomerCostSchema.safeParse({ amount: 12.34 }).success).toBe(false);
  });
});

describe('mergeSalesOrderUpdate normalises nonCustomerCost', () => {
  const existing = (): SalesOrder => ({
    salesOrderId: 'so-example',
    customerId: 'cust-1',
    lines: [],
    timestamp: '00000000000FD028',
  }) as SalesOrder;

  it('normalises a bare number so the PUT body cannot 422', () => {
    const merged = mergeSalesOrderUpdate(existing(), {
      id: 'so-example',
      customerId: 'cust-1',
      nonCustomerCost: 12.34,
    });
    expect(merged.nonCustomerCost).toEqual({ value: '12.34000', isPercent: false });
  });

  it('passes a pre-shaped money object through unchanged', () => {
    const merged = mergeSalesOrderUpdate(existing(), {
      id: 'so-example',
      customerId: 'cust-1',
      nonCustomerCost: { value: '104.67000', isPercent: false },
    });
    expect(merged.nonCustomerCost).toEqual({ value: '104.67000', isPercent: false });
  });

  it('leaves nonCustomerCost absent when the caller did not mention it', () => {
    const merged = mergeSalesOrderUpdate(existing(), {
      id: 'so-example',
      customerId: 'cust-1',
    });
    expect(merged.nonCustomerCost).toBeUndefined();
  });
});
