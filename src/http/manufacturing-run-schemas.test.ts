import { describe, expect, it } from 'vitest';

const schemasModule = await import('./manufacturing-run-schemas.js')
  .catch(() => ({})) as Record<string, any>;

function parse(route: string, value: unknown): unknown {
  expect(schemasModule.parseManufacturingRunRouteBody).toBeTypeOf('function');
  return schemasModule.parseManufacturingRunRouteBody(route, value);
}

describe('manufacturing run route schemas', () => {
  it('accepts the exact route-specific request contracts', () => {
    const cases: Array<[string, unknown]> = [
      ['/v1/manufacturing-runs/ready', {}],
      ['/v1/manufacturing-runs/begin', {
        idempotencyKey: 'zap-run-123',
        identity: {
          schemaVersion: 'manufacturing-run-identity/v2',
          companyId: 'company-1',
          finishedProductId: 'product-1',
          sourceSerial: 'SERIAL-1',
          finishedSerial: 'SERIAL-1',
        },
        locationId: 'location-1',
        remarks: 'safe remarks',
        notificationContext: {
          slackChannelId: 'C0000000001',
          slackThreadTs: '1700000000.000001',
          slackPermalink:
            'https://example.slack.com/archives/C1/p1700000000000000',
        },
      }],
      ['/v1/manufacturing-runs/component/resolve', {
        operationId: 'operation-1',
        rawLineId: 'line-1',
        recursiveChildren: [{
          sourceSerial: 'SOURCE-1',
          finishedSerial: 'SUBASSEMBLY-1',
          locationId: 'location-1',
        }],
      }],
      ['/v1/manufacturing-runs/component', {
        operationId: 'operation-1',
        rawLineId: 'line-1',
        productId: 'product-1',
        quantity: '1',
        locationId: 'location-1',
        serialized: true,
        serialNumbers: ['SERIAL-1'],
      }],
      ['/v1/manufacturing-runs/status', { operationId: 'operation-1' }],
      ['/v1/manufacturing-runs/notifications/claim', {
        notificationId:
          'manufacturing-run-notification/v1:operation-1:7',
        claimantId: 'slack-worker-1',
        claimTtlMs: 30_000,
      }],
      ['/v1/manufacturing-runs/notifications/ack', {
        notificationId: 'notification-1',
        claimToken: 'claim-token-1',
        slackTimestamp: '1712345678.000100',
        permalink: 'https://example.slack.com/archives/C1/p1712345678000100',
      }],
      ['/v1/manufacturing-runs/notifications/delivery-unknown', {
        notificationId: 'notification-1',
        claimToken: 'claim-token-1',
        reason: 'Slack accepted the request but its response was lost',
      }],
      ['/v1/manufacturing-runs/notifications/reconcile', {
        notificationId: 'notification-1',
        action: 'acknowledge_existing',
        operatorId: 'operator-1',
        slackTimestamp: '1712345678.000100',
        permalink: 'https://example.slack.com/archives/C1/p1712345678000100',
      }],
      ['/v1/manufacturing-runs/operator/resolve', {
        operationId: 'operation-1',
        expectedRevision: 4,
        operatorId: 'operator-1',
        action: 'resolve',
        approvedAt: 1_712_345_678,
      }],
      ['/v1/manufacturing-runs/operator/rearm-proven-no-write', {
        operationId: 'operation-1',
        expectedRevision: 4,
      }],
    ];
    for (const [route, value] of cases) {
      expect(parse(route, value)).toEqual(value);
    }
  });

  it('rejects unknown fields, coercion, and schemas from another route', () => {
    expect(() => parse('/v1/manufacturing-runs/status', {
      operationId: 'operation-1',
      debug: true,
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/status', {
      operationId: 1,
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/component', {
      operationId: 'operation-1',
    })).toThrow();
    expect(() => parse(
      '/v1/manufacturing-runs/operator/rearm-proven-no-write',
      { operationId: 'operation-1' }
    )).toThrow();
    expect(() => parse(
      '/v1/manufacturing-runs/operator/rearm-proven-no-write',
      { operationId: 'operation-1', expectedRevision: '4' }
    )).toThrow();
    expect(() => parse(
      '/v1/manufacturing-runs/operator/rearm-proven-no-write',
      { operationId: 'operation-1', expectedRevision: 4, automatic: true }
    )).toThrow();
    expect(() => parse('/v1/manufacturing-runs/unknown', {})).toThrow(
      /UNKNOWN_MANUFACTURING_RUN_ROUTE/
    );
  });

  it.each([
    [{ parentRunHash: 'parent-run-hash' }],
    [{ parentRawLineId: 'parent-line-1' }],
    [{ parentRunHash: null, parentRawLineId: null }],
  ])('keeps public begin root-only when parent identity fields are supplied', (parent) => {
    expect(() => parse('/v1/manufacturing-runs/begin', {
      idempotencyKey: 'zap-run-123',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
        ...parent,
      },
      locationId: 'location-1',
    })).toThrow();
  });

  it('requires exact paired Slack thread context on root begin', () => {
    const base = {
      idempotencyKey: 'zap-run-123',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
    };
    for (const notificationContext of [
      { slackChannelId: 'C0000000001' },
      { slackThreadTs: '1700000000.000001' },
      {
        slackChannelId: 'C0000000001',
        slackThreadTs: 'not-a-slack-timestamp',
      },
      {
        slackChannelId: 'not a channel',
        slackThreadTs: '1700000000.000001',
      },
      {
        slackChannelId: 'C0000000001',
        slackThreadTs: '1700000000.000001',
        slackPermalink: 'http://example.invalid/not-https',
      },
      {
        slackChannelId: 'C0000000001',
        slackThreadTs: '1700000000.000001',
        slackPermalink: 'not a URL',
      },
      {
        slackChannelId: 'C0000000001',
        slackThreadTs: '1700000000.000001',
        extra: true,
      },
    ]) {
      expect(() => parse('/v1/manufacturing-runs/begin', {
        ...base,
        notificationContext,
      })).toThrow();
    }
    expect(parse('/v1/manufacturing-runs/begin', base)).toEqual(base);
  });

  it('accepts exact per-unit recursive identities and rejects duplicate serials', () => {
    expect(parse('/v1/manufacturing-runs/component/resolve', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'SOURCE-1', finishedSerial: 'CHILD-1', locationId: 'location-1' },
        { sourceSerial: 'SOURCE-2', finishedSerial: 'CHILD-2', locationId: 'location-1' },
      ],
    })).toMatchObject({
      recursiveChildren: [
        { finishedSerial: 'CHILD-1' },
        { finishedSerial: 'CHILD-2' },
      ],
    });
    expect(() => parse('/v1/manufacturing-runs/component/resolve', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'SOURCE-1', finishedSerial: 'CHILD-1', locationId: 'location-1' },
        { sourceSerial: 'SOURCE-2', finishedSerial: 'CHILD-1', locationId: 'location-2' },
      ],
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/component/resolve', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'SOURCE-1', finishedSerial: 'child-1', locationId: 'location-1' },
        { sourceSerial: 'SOURCE-2', finishedSerial: 'CHILD-1', locationId: 'location-2' },
      ],
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/component/resolve', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      recursiveChildren: [
        { sourceSerial: 'source-1', finishedSerial: 'CHILD-1', locationId: 'location-1' },
        { sourceSerial: 'ＳＯＵＲＣＥ－１', finishedSerial: 'CHILD-2', locationId: 'location-2' },
      ],
    })).toThrow();
  });

  it('bounds identifiers, remarks, arrays, and claim leases', () => {
    expect(parse('/v1/manufacturing-runs/notifications/claim', {
      notificationId: 'manufacturing-run-notification/v1:operation-1:7',
      claimantId: 'slack-worker',
      claimTtlMs: 30_000,
    })).toMatchObject({
      notificationId: 'manufacturing-run-notification/v1:operation-1:7',
    });
    expect(() => parse('/v1/manufacturing-runs/notifications/claim', {
      claimantId: 'slack-worker',
      claimTtlMs: 30_000,
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/begin', {
      idempotencyKey: 'x',
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-1',
        finishedProductId: 'product-1',
        sourceSerial: 'SERIAL-1',
        finishedSerial: 'SERIAL-1',
      },
      locationId: 'location-1',
      remarks: 'x'.repeat(4_097),
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/component', {
      operationId: 'operation-1',
      rawLineId: 'line-1',
      productId: 'product-1',
      quantity: '1',
      locationId: 'location-1',
      serialized: false,
      serialNumbers: Array.from({ length: 101 }, (_, index) => `S-${index}`),
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/notifications/claim', {
      claimantId: 'claimant-1',
      claimTtlMs: 3_600_001,
    })).toThrow();
  });

  it('requires explicit and internally consistent notification reconciliation', () => {
    expect(parse('/v1/manufacturing-runs/notifications/reconcile', {
      notificationId: 'notification-1',
      action: 'retry_after_duplicate_risk',
      operatorId: 'operator-1',
    })).toMatchObject({ action: 'retry_after_duplicate_risk' });
    expect(() => parse('/v1/manufacturing-runs/notifications/reconcile', {
      notificationId: 'notification-1',
      action: 'acknowledge_existing',
      operatorId: 'operator-1',
    })).toThrow();
    expect(() => parse('/v1/manufacturing-runs/notifications/reconcile', {
      notificationId: 'notification-1',
      action: 'retry_after_duplicate_risk',
      operatorId: 'operator-1',
      slackTimestamp: '1712345678.000100',
      permalink: 'https://example.slack.com/archives/C1/p1712345678000100',
    })).toThrow();
  });
});
