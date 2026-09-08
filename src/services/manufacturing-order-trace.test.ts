import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../core/canonical-json.js';
import evidence from './fixtures/manufacturing-evidence.slices.json' with { type: 'json' };
import rawIncident from './fixtures/manufacturing-incident.synthetic.json' with { type: 'json' };
import syntheticGolden from './fixtures/manufacturing-order.synthetic-golden.json' with { type: 'json' };
import type { ManufacturingOrder } from '../types/inflow.js';
import * as traceModule from './manufacturing-order-trace.js';
import {
  buildDesiredSerialState,
  normalizeManufacturingOrderTrace,
} from './manufacturing-order-trace.js';

const order = {
  manufacturingOrderId: 'mo-1', status: 'Open', timestamp: 't-1',
  lines: [{ manufacturingOrderLineId: 'out-1', productId: 'finished', quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['OUT_SERIAL'] }, manufacturingOrderLines: [{ manufacturingOrderLineId: 'raw-1', productId: 'raw', quantity: { standardQuantity: '1', uomQuantity: '1' } }] }],
  pickLines: [{ manufacturingOrderPickLineId: 'pick-1', productId: 'raw', locationId: 'loc-1', quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['IN_SERIAL'] } }],
  pickMatchings: [{ manufacturingOrderPickMatchingId: 'match-1', manufacturingOrderLineId: 'raw-1', manufacturingOrderPickLineId: 'pick-1', matchedQuantity: '1', serial: 'IN_SERIAL' }],
};

describe('manufacturing order trace', () => {
  it('joins matching IDs without treating the matching representation as a duplicate SERIAL', () => {
    const trace = normalizeManufacturingOrderTrace(order);
    expect(trace.inputPicks[0].matchingLineIds).toEqual(['raw-1']);
    expect(trace.anomalies).toEqual([]);
  });

  it('allows a SERIAL to move from consumed input to finished output without flagging a duplicate', () => {
    const sameVinOrder = structuredClone(order);
    sameVinOrder.lines[0]!.quantity!.serialNumbers = ['SERIAL-1'];
    sameVinOrder.pickLines![0]!.quantity!.serialNumbers = ['SERIAL-1'];
    sameVinOrder.pickMatchings![0]!.serial = 'SERIAL-1';

    expect(normalizeManufacturingOrderTrace(sameVinOrder).anomalies).toEqual([]);
  });

  it('still flags a serial repeated within output lines', () => {
    const duplicateOutputOrder = structuredClone(order) as unknown as ManufacturingOrder;
    duplicateOutputOrder.lines![0]!.quantity!.serialNumbers = ['SERIAL-1'];
    duplicateOutputOrder.lines![0]!.manufacturingOrderLines![0]!.quantity!.serialNumbers = ['SERIAL-1'];

    expect(normalizeManufacturingOrderTrace(duplicateOutputOrder).anomalies)
      .toContainEqual({ code: 'DUPLICATE_SERIAL', ids: ['SERIAL-1'] });
  });

  it('still flags a serial repeated within input picks', () => {
    const duplicatePickOrder = structuredClone(order) as unknown as ManufacturingOrder;
    duplicatePickOrder.pickLines![0]!.quantity!.standardQuantity = '2';
    duplicatePickOrder.pickLines![0]!.quantity!.uomQuantity = '2';
    duplicatePickOrder.pickLines![0]!.quantity!.serialNumbers = ['SERIAL-1', 'SERIAL-1'];
    duplicatePickOrder.pickMatchings![0]!.serial = 'SERIAL-1';
    duplicatePickOrder.pickMatchings!.push({
      ...duplicatePickOrder.pickMatchings![0]!,
      manufacturingOrderPickMatchingId: 'match-2',
    });

    expect(normalizeManufacturingOrderTrace(duplicatePickOrder).anomalies)
      .toContainEqual({ code: 'DUPLICATE_SERIAL', ids: ['SERIAL-1'] });
  });

  it('updates exact nested IDs while preserving line hierarchy', () => {
    const desired = buildDesiredSerialState(order, { mode: 'patch', inputPicks: [{ manufacturingOrderLineId: 'raw-1', manufacturingOrderPickLineId: 'pick-1', serialNumbers: ['NEW_SERIAL'] }] }, ['new-match']);
    expect(desired.lines?.[0].manufacturingOrderLines?.[0].manufacturingOrderLineId).toBe('raw-1');
    expect(desired.pickLines?.[0].quantity?.serialNumbers).toEqual(['NEW_SERIAL']);
    expect(desired.pickMatchings?.[0].serial).toBe('NEW_SERIAL');
  });

  it('replace clears omitted line and pick serial representations', () => {
    const desired = buildDesiredSerialState(order, {
      mode: 'replace',
      outputLines: [{ manufacturingOrderLineId: 'out-1', serialNumbers: ['NEWOUT'] }],
      inputPicks: [],
    });
    expect(desired.lines?.[0].quantity?.serialNumbers).toEqual(['NEWOUT']);
    expect(desired.lines?.[0].manufacturingOrderLines?.[0].quantity?.serialNumbers).toEqual([]);
    expect(desired.pickLines?.[0].quantity?.serialNumbers).toEqual([]);
    expect(desired.pickMatchings).toEqual([]);
  });

  it('characterizes every orphan provider pick without a matching row', () => {
    const trace = normalizeManufacturingOrderTrace(rawIncident as unknown as ManufacturingOrder);
    expect(
      trace.anomalies
        .filter((row) => row.code === 'PICK_WITHOUT_MATCHINGS')
        .map((row) => row.ids[0])
    ).toEqual([
      '00000000-0000-4000-8000-000000000117',
      '00000000-0000-4000-8000-000000000118',
    ]);
  });

  it('retains known-good provider matching shapes and four-component BOM identity', () => {
    expect(evidence.knownGoodSyntheticMo.nonSerialized.matching).toMatchObject({
      matchedQuantity: '34.0000',
      serial: '',
    });
    expect(evidence.knownGoodSyntheticMo.serialized.matching).toMatchObject({
      matchedQuantity: '1.0000',
      serial: 'SERIAL-SYNTHETIC-001',
    });
    expect(evidence.britishFlagBom.itemBoms.map((row) => row.childProductId)).toEqual([
      '00000000-0000-4000-8000-000000000125',
      '00000000-0000-4000-8000-000000000112',
      '00000000-0000-4000-8000-000000000113',
      '00000000-0000-4000-8000-000000000114',
    ]);
  });

  it('requests the provider-supported full trace expansions', () => {
    expect(traceModule.MO_TRACE_INCLUDE).toEqual([
      'lines',
      'lines.manufacturingOrderOperations',
      'pickLines',
      'pickMatchings',
      'putLines',
    ]);
  });

  it('projects puts plus nested operations and official timesheets', () => {
    const project = requiredTraceFunction('canonicalManufacturingOrderProjection');
    const projected = project(syntheticGolden.document) as {
      completedDate: string | null;
      lines: Array<{
        operations: Array<{
          manufacturingOrderOperationTimesheets: Array<Record<string, unknown>>;
        }>;
      }>;
      putLines: unknown[];
    };
    expect(projected.completedDate).toBeNull();
    expect(
      projected.lines[0]?.operations.map(
        (row) => row.manufacturingOrderOperationTimesheets.length
      )
    ).toEqual([0, 1]);
    expect(projected.lines[0]?.operations[0]).toMatchObject({ completedDate: null });
    expect(
      projected.lines[0]?.operations[1]?.manufacturingOrderOperationTimesheets[0]
    ).toMatchObject({
      startTime: '2026-01-02T10:00:00.000Z',
      endTime: null,
      perHourCost: '18.5000',
      userId: 'user-fixture',
    });
    expect(projected.putLines).toEqual([]);
  });

  it('keeps full semantic hashes stable across provider array order and rowversions', () => {
    const hash = requiredTraceFunction('manufacturingOrderFullSemanticHash');
    const reordered = structuredClone(syntheticGolden.document) as any;
    reordered.timestamp = 'rowversion-2';
    reordered.lines[0]!.manufacturingOrderLines.reverse();
    reordered.lines[0]!.manufacturingOrderOperations.reverse();
    reordered.lines[0]!.manufacturingOrderOperations[0]!
      .manufacturingOrderOperationTimesheets.reverse();
    reordered.pickLines = [{
      manufacturingOrderPickLineId: 'pick-volatile',
      pickDate: '2026-01-01T00:00:00.000Z',
    }];
    const differentlyTimed = structuredClone(reordered);
    differentlyTimed.pickLines[0]!.pickDate = '2026-01-02T00:00:00.000Z';
    expect(hash(differentlyTimed)).toBe(hash(reordered));
    reordered.pickLines = [];
    expect(hash(reordered)).toBe(hash(syntheticGolden.document));

    const decimalA = structuredClone(syntheticGolden.document) as any;
    decimalA.pickMatchings = [{
      manufacturingOrderPickMatchingId: 'matching-decimal',
      manufacturingOrderLineId: 'component-line-a',
      manufacturingOrderPickLineId: 'pick-decimal',
      matchedQuantity: '1',
      serial: '',
    }];
    const decimalB = structuredClone(decimalA);
    decimalB.pickMatchings[0].matchedQuantity = '1.0000';
    expect(hash(decimalA)).toBe(hash(decimalB));

    const meaningfulChange = structuredClone(syntheticGolden.document);
    meaningfulChange.unknownProviderHeader.keep = false;
    expect(hash(meaningfulChange)).not.toBe(hash(syntheticGolden.document));

    const completed = structuredClone(
      syntheticGolden.document
    ) as unknown as ManufacturingOrder;
    completed.completedDate = '2026-01-03T12:00:00.000Z';
    expect(hash(completed)).not.toBe(hash(syntheticGolden.document));
  });

  it('normalizes provider-defaulted pick/put fields and omitted put-line linkage', () => {
    const project = requiredTraceFunction('canonicalManufacturingOrderProjection');
    const planned = {
      ...structuredClone(order),
      lastModifiedDateTime: '2026-08-01T12:00:00.000Z',
      pickLines: [{
        manufacturingOrderPickLineId: 'pick-1',
        productId: 'raw',
        locationId: 'loc-1',
        quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['IN_SERIAL'] },
      }],
      putLines: [{
        manufacturingOrderPutLineId: 'put-1',
        manufacturingOrderLineId: 'out-1',
        productId: 'finished',
        locationId: 'loc-1',
        quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: ['OUT_SERIAL'] },
      }],
    } as ManufacturingOrder;
    const provider = structuredClone(planned) as ManufacturingOrder & {
      lastModifiedDateTime?: string;
    };
    provider.lastModifiedDateTime = '2026-08-01T12:01:00.000Z';
    provider.pickLines![0]!.description = '';
    provider.pickLines![0]!.quantity!.uom = '';
    provider.putLines![0]!.description = '';
    provider.putLines![0]!.quantity!.uom = '';
    delete provider.putLines![0]!.manufacturingOrderLineId;
    expect(project(provider)).toEqual(project(planned));

    provider.putLines![0]!.manufacturingOrderLineId = 'wrong-output-line';
    expect(project(provider)).not.toEqual(project(planned));
    provider.putLines![0]!.manufacturingOrderLineId = 'out-1';
    provider.putLines![0]!.productId = 'different-finished';
    expect(project(provider)).not.toEqual(project(planned));
  });

  it('normalizes the provider-derived in-progress status for an open staged pick', () => {
    const project = requiredTraceFunction('canonicalManufacturingOrderProjection');
    const planned = {
      ...structuredClone(order),
      isCompleted: false,
      status: 'open',
    } as ManufacturingOrder;
    const provider = structuredClone(planned);
    provider.status = 'inProgress';
    expect(project(provider)).toEqual(project(planned));

    provider.status = 'cancelled';
    expect(project(provider)).not.toEqual(project(planned));
  });

  it('canonicalizes the complete pre-write shape without dropping rowversions', () => {
    const writeShape = requiredTraceFunction('canonicalManufacturingOrderWriteShape');
    const reordered = structuredClone(syntheticGolden.document);
    reordered.lines[0]!.manufacturingOrderLines.reverse();
    reordered.lines[0]!.manufacturingOrderOperations.reverse();
    expect(canonicalHash(writeShape(reordered))).toBe(
      canonicalHash(writeShape(syntheticGolden.document))
    );

    reordered.timestamp = 'rowversion-2';
    expect(canonicalHash(writeShape(reordered))).not.toBe(
      canonicalHash(writeShape(syntheticGolden.document))
    );
  });

  it('patches only allowlisted fields on an untouched raw GET write base', () => {
    const applyPatch = requiredTraceFunction('applyManufacturingOrderPatch');
    const before = structuredClone(rawIncident);
    const nextPicks = [...rawIncident.pickLines].reverse();
    const desired = applyPatch(rawIncident, {
      pickLines: nextPicks,
      pickMatchings: [],
      putLines: [],
      isCompleted: true,
      status: 'completed',
    }) as typeof rawIncident & { putLines: unknown[] };

    expect(rawIncident).toEqual(before);
    expect(desired.assignedToTeamMemberId).toBe(before.assignedToTeamMemberId);
    expect(desired.customFields).toEqual(before.customFields);
    expect(desired.lines).toEqual(before.lines);
    expect(desired.pickLines).toEqual(nextPicks);
    expect(desired.putLines).toEqual([]);
    expect(() => applyPatch(rawIncident, { remarks: 'not allowlisted' })).toThrow(
      /UNSUPPORTED_MANUFACTURING_ORDER_PATCH/
    );
  });
});

function requiredTraceFunction(name: string): (...args: any[]) => unknown {
  const value = (traceModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value as (...args: any[]) => unknown;
}
