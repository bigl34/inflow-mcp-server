import { describe, expect, it } from 'vitest';

const envelopeModule = await import('./manufacturing-run-envelope.js').catch(
  () => ({})
);

function exported(name: string): (...args: any[]) => any {
  const value = (envelopeModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value as (...args: any[]) => any;
}

const snapshot = {
  operationId: 'operation-1',
  runHash: 'run-hash-1',
  manufacturingOrderId: 'mo-1',
  rootLineId: 'root-1',
  state: 'collecting',
  stateRevision: 3,
  retryMode: 'none',
  expectedComponents: [{
    rawLineId: 'line-1',
    productId: 'product-1',
    quantity: '1',
    disposition: 'registered',
  }],
};

describe('manufacturing run response envelope', () => {
  it('presents every required field under manufacturing-run/v1', () => {
    const create = exported('createManufacturingRunEnvelope');
    expect(create({
      snapshot,
      notificationDisposition: 'pending',
      notificationContext: {
        slackChannelId: 'C0000000001',
        slackThreadTs: '1700000000.000001',
      },
    })).toEqual({
      schemaVersion: 'manufacturing-run/v1',
      operationId: 'operation-1',
      state: 'collecting',
      manufacturingOrder: {
        manufacturingOrderId: 'mo-1',
        rootLineId: 'root-1',
        runHash: 'run-hash-1',
      },
      stateRevision: 3,
      retryMode: 'none',
      expectedComponents: snapshot.expectedComponents,
      failure: null,
      notificationDisposition: 'pending',
      notificationContext: {
        slackChannelId: 'C0000000001',
        slackThreadTs: '1700000000.000001',
      },
      blockerEvidence: null,
    });
  });

  it('round-trips strict versioned notification metadata through durable remarks', () => {
    const encode = exported('encodeManufacturingRunRemarks');
    const decode = exported('decodeManufacturingRunRemarks');
    const notificationContext = {
      slackChannelId: 'C0000000001',
      slackThreadTs: '1700000000.000001',
      slackPermalink:
        'https://example.slack.com/archives/C1/p1700000000000000',
    };
    const encoded = encode({
      remarks: 'Started by Zapier',
      notificationContext,
    });
    expect(encoded).toMatch(/^\[manufacturing-run-context:v1:/);
    expect(decode(encoded)).toEqual({
      remarks: 'Started by Zapier',
      notificationContext,
    });
    expect(decode('legacy unstructured remarks')).toEqual({
      remarks: 'legacy unstructured remarks',
      notificationContext: null,
    });
    expect(() => decode(
      '[manufacturing-run-context:v1:not-base64-json]\nremarks'
    )).toThrow(/INVALID_MANUFACTURING_RUN_CONTEXT/);
  });

  it('redacts secrets, stack traces, file paths, and provider text from failures', () => {
    const sanitize = exported('sanitizeManufacturingRunFailure');
    const error = new Error(
      'WRITE_GATE_CLOSED apiKey=super-secret /Users/USER/private.sqlite'
    );
    error.stack = `Error: ${error.message}\n    at secret (/private/source.ts:1:2)`;
    const serialized = JSON.stringify(sanitize(error));
    expect(serialized).toContain('WRITE_GATE_CLOSED');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('/Users');
    expect(serialized).not.toContain('/private');
    expect(serialized).not.toContain('source.ts');
  });

  it.each([
    [{ accepted: true }, 202],
    [{ snapshot: { ...snapshot, state: 'conflict' } }, 409],
    [{ snapshot: { ...snapshot, state: 'blocked' } }, 423],
    [{ failure: { code: 'UNSUPPORTED_MO_SHAPE', message: 'Unsupported manufacturing order shape' } }, 422],
    [{ failure: { code: 'WRITE_GATE_CLOSED', message: 'Coordinator unavailable' } }, 503],
    [{ snapshot }, 200],
  ])('maps operational outcomes %# to the required status', (input, expected) => {
    const status = exported('manufacturingRunHttpStatus');
    expect(status(input)).toBe(expected);
  });
});
