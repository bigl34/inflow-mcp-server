import { describe, expect, it } from 'vitest';
import {
  assertSafeWriteAuthorized,
  classifySafeWriteOperations,
  evaluateSafeWriteAuthorization,
  evaluateSafeWriteClassAuthorization,
  getSafeWritePolicy,
  listSafeWritePolicies,
} from './write-policy.js';

const gates = (safeWritesEnabled: boolean, stockWritesEnabled: boolean) => ({
  safeWritesEnabled,
  stockWritesEnabled,
});

describe('safe-write policy', () => {
  it('supports product prices and bounded product writes', () => {
    const supported = listSafeWritePolicies()
      .filter((policy) => policy.staticSupport)
      .map((policy) => policy.operation);
    expect(supported).toEqual(['set_product_prices', 'set_product']);
  });

  it('classifies the fixed ordinary and stock operation sets', () => {
    expect(getSafeWritePolicy('set_product_prices').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_product').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_product_group_config').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_customer').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_vendor').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_taxing_scheme').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_webhook').classification).toBe('ordinary');
    expect(getSafeWritePolicy('set_sales_order').classification).toBe('stock');
    expect(getSafeWritePolicy('set_purchase_order').classification).toBe('stock');
    expect(getSafeWritePolicy('set_purchase_order_receipts').classification).toBe('stock');
    expect(getSafeWritePolicy('set_stock_adjustment').classification).toBe('stock');
    expect(getSafeWritePolicy('set_stock_transfer').classification).toBe('stock');
    expect(getSafeWritePolicy('set_stock_count').classification).toBe('stock');
    expect(getSafeWritePolicy('set_manufacturing_order').classification).toBe('stock');
    expect(getSafeWritePolicy('reconcile_manufacturing_order_serials').classification).toBe('stock');
  });

  it('fails unknown and mixed operations closed as stock-affecting or unsupported', () => {
    expect(getSafeWritePolicy('future_operation')).toMatchObject({
      classification: 'stock',
      staticSupport: false,
      idempotency: 'required',
    });
    expect(classifySafeWriteOperations(['set_product_prices', 'set_sales_order'])).toEqual({
      classification: 'stock',
      staticSupport: false,
      unknownOperations: [],
    });
    expect(classifySafeWriteOperations(['set_product_prices', 'future_operation'])).toEqual({
      classification: 'stock',
      staticSupport: false,
      unknownOperations: ['future_operation'],
    });
  });

  it('applies master-before-stock gate precedence', () => {
    expect(evaluateSafeWriteClassAuthorization(gates(false, false), 'stock')).toMatchObject({
      enabled: false,
      reasonCode: 'SAFE_WRITES_DISABLED',
    });
    expect(evaluateSafeWriteClassAuthorization(gates(false, true), 'stock')).toMatchObject({
      enabled: false,
      reasonCode: 'SAFE_WRITES_DISABLED',
    });
    expect(evaluateSafeWriteClassAuthorization(gates(true, false), 'stock')).toMatchObject({
      enabled: false,
      reasonCode: 'STOCK_WRITES_DISABLED',
    });
    expect(evaluateSafeWriteClassAuthorization(gates(true, true), 'stock')).toMatchObject({
      enabled: true,
      reasonCode: undefined,
    });
    expect(evaluateSafeWriteClassAuthorization(gates(true, false), 'ordinary').enabled).toBe(true);
  });

  it('reports static unsupported state before runtime gate state', () => {
    expect(evaluateSafeWriteAuthorization(gates(false, false), 'set_customer')).toMatchObject({
      staticSupport: false,
      effectiveApplyEnabled: false,
      reasonCode: 'OPERATION_UNSUPPORTED',
    });
    expect(() => assertSafeWriteAuthorized(gates(true, true), 'set_customer')).toThrow(
      /OPERATION_UNSUPPORTED/
    );
    expect(() => assertSafeWriteAuthorized(gates(false, false), 'set_product_prices')).toThrow(
      /SAFE_WRITES_DISABLED/
    );
    expect(() => assertSafeWriteAuthorized(gates(true, false), 'set_product_prices')).not.toThrow();
  });

  it('declares conditional idempotency requirements by mutation semantics', () => {
    expect(getSafeWritePolicy('set_product_prices').idempotency).toBe('replacement-optional');
    expect(getSafeWritePolicy('set_product').idempotency).toBe('create-only');
    expect(getSafeWritePolicy('set_sales_order').idempotency).toBe('required');
    expect(getSafeWritePolicy('create_product_group_variants').idempotency).toBe('required');
    expect(getSafeWritePolicy('remove_webhook').idempotency).toBe('delete-absence-verified');
  });
});
