import { describe, expect, it, vi } from 'vitest';
import { InflowApiError, type InflowClient } from '../client/inflow.js';
import {
  cleanupCanaryProducts,
  evaluateProbeResult,
  isTimestampConcurrencyConflict,
  type ProbeResult,
} from './manufacturing-writes.js';

describe('manufacturing write canary safety', () => {
  it('fails the probe when cleanup readback is not verified', () => {
    const result = {
      parentProductId: 'parent',
      componentProductId: 'component',
      addWorked: true,
      updateWorked: true,
      operationRemoveWorked: true,
      removeWorked: true,
      clearWorked: true,
      inactiveComponentAccepted: true,
      staleTimestampRejected: true,
      clientSuppliedItemBomIdRetained: true,
      clientSuppliedOperationIdRetained: true,
      cleanupSucceeded: false,
      errors: [],
    } satisfies ProbeResult;

    expect(evaluateProbeResult(result)).toMatchObject({
      passed: false,
      requiredChecks: { cleanupSucceeded: false },
    });
  });

  it('still deactivates the component when parent cleanup fails', async () => {
    let componentActive = true;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith('/parent')) throw new Error('parent missing');
      return {
        productId: 'component',
        timestamp: 'component-ts',
        isActive: componentActive,
      };
    });
    const put = vi.fn(async (_path: string, body: Record<string, unknown>) => {
      if (body.productId === 'component') componentActive = false;
      return body;
    });

    const result = await cleanupCanaryProducts(
      { get, put } as unknown as InflowClient,
      'parent',
      'component'
    );

    expect(result.cleanupSucceeded).toBe(false);
    expect(result.errors.join(' ')).toContain('Parent cleanup failed');
    expect(put).toHaveBeenCalledWith(
      '/products',
      expect.objectContaining({ productId: 'component', isActive: false })
    );
  });

  it('accepts only explicit timestamp-concurrency API errors', () => {
    expect(
      isTimestampConcurrencyConflict(
        new InflowApiError('Timestamp conflict', 409, {
          code: 'timestamp_conflict',
          message: 'The row version has changed',
        })
      )
    ).toBe(true);
    expect(
      isTimestampConcurrencyConflict(
        new InflowApiError('Rate limited', 429, {
          code: 'rate_limited',
          message: 'Try later',
        })
      )
    ).toBe(false);
    expect(isTimestampConcurrencyConflict(new InflowApiError('Server', 500))).toBe(
      false
    );
    expect(
      isTimestampConcurrencyConflict(
        new InflowApiError('Validation failed', 400, {
          code: 'invalid_product',
          message: 'Name is required',
        })
      )
    ).toBe(false);
    expect(isTimestampConcurrencyConflict(new TypeError('network'))).toBe(false);
  });
});
