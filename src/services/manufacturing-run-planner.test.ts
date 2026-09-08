import { describe, expect, it } from 'vitest';
import rawIncident from './fixtures/manufacturing-incident.synthetic.json' with { type: 'json' };
import syntheticGolden from './fixtures/manufacturing-order.synthetic-golden.json' with { type: 'json' };

const plannerModule = await import('./manufacturing-run-planner.js').catch(() => ({}));

const identity = {
  schemaVersion: 'manufacturing-run-identity/v2',
  companyId: 'company-fixture',
  finishedProductId: 'finished-product',
  sourceSerial: '  serial-001  ',
  finishedSerial: '  serial-001  ',
  parentRunHash: null,
  parentRawLineId: null,
};

function planner(name: string): (...args: any[]) => any {
  const value = (plannerModule as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf('function');
  return value as (...args: any[]) => any;
}

function beginPlan() {
  return planner('planManufacturingRunBegin')({
    identity,
    locationId: 'location-main',
    remarks: 'operator note',
  });
}

function expandedOrder() {
  const begin = beginPlan();
  const order = structuredClone(syntheticGolden.document);
  order.manufacturingOrderId = begin.manufacturingOrderId;
  order.lines[0]!.manufacturingOrderLineId = begin.rootLineId;
  order.lines[0]!.manufacturingOrderLines.forEach((line) => {
    line.parentManufacturingOrderLineId = begin.rootLineId;
  });
  order.lines[0]!.manufacturingOrderOperations.forEach((operation) => {
    operation.manufacturingOrderLineId = begin.rootLineId;
  });
  order.remarks = `operator note\n${begin.coordinatorMarker}`;
  return { begin, order };
}

const intents = [
  {
    rawLineId: 'component-line-a',
    productId: 'repeated-component',
    quantity: '2',
    locationId: 'location-main',
    serialized: true,
    serialNumbers: ['SERIAL-A', '', 'SERIAL-B'],
  },
  {
    rawLineId: 'component-line-b',
    productId: 'repeated-component',
    quantity: '1.0000',
    locationId: 'location-main',
    serialized: false,
    serialNumbers: [],
  },
];

describe('manufacturing run begin planner', () => {
  it('normalizes identity and produces deterministic UUIDv5 create identities', () => {
    const first = beginPlan();
    const second = planner('planManufacturingRunBegin')({
      identity: { ...identity, finishedSerial: 'SERIAL-001' },
      locationId: 'location-main',
      remarks: 'operator note',
    });
    expect(first).toEqual(second);
    expect(first.normalizedIdentity.finishedSerial).toBe('SERIAL-001');
    expect(first.manufacturingOrderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.manufacturingOrderId[14]).toBe('5');
    expect(first.rootLineId[14]).toBe('5');
    expect(first.operationId[14]).toBe('5');
    expect(first.createRequest.query.fillDefaultBom).toBe(true);
    expect(first.createRequest.body.lines[0].manufacturingOrderLineId).toBe(first.rootLineId);
  });

  it('refuses new legacy v1 identities after cutover', () => {
    expect(() => planner('planManufacturingRunBegin')({
      identity: {
        ...identity,
        schemaVersion: 'manufacturing-run-identity/v1',
      },
      locationId: 'location-main',
    })).toThrow(/UNSUPPORTED_MANUFACTURING_RUN_IDENTITY/);
  });

  it('embeds and verifies a machine-readable coordinator marker', () => {
    const begin = beginPlan();
    const marker = planner('parseAndVerifyCoordinatorMarker')(
      begin.createRequest.body.remarks,
      begin
    );
    expect(marker.runHash).toBe(begin.runHash);
    expect(() =>
      planner('parseAndVerifyCoordinatorMarker')(
        begin.createRequest.body.remarks,
        { ...begin, rootLineId: 'wrong-root' }
      )
    ).toThrow(/COORDINATOR_MARKER_MISMATCH/);
  });
});

describe('manufacturing snapshot and dependency validation', () => {
  it('captures the complete expanded line and operation hierarchy and detects drift', () => {
    const { begin, order } = expandedOrder();
    const capture = planner('captureManufacturingSnapshot');
    const validate = planner('validateManufacturingSnapshot');
    const snapshot = capture(order, begin);
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.operations).toHaveLength(2);
    expect(snapshot.operations[1].manufacturingOrderOperationTimesheets).toHaveLength(1);
    expect(() => validate(order, snapshot, begin)).not.toThrow();

    const drifted = structuredClone(order);
    drifted.lines[0]!.manufacturingOrderLines[0]!.quantity.standardQuantity = '3';
    expect(() => validate(drifted, snapshot, begin)).toThrow(/MANUFACTURING_SNAPSHOT_DRIFT/);
  });

  it('accepts recursive dependencies in topological order and rejects cycles', () => {
    const validate = planner('validateManufacturingDependencies');
    expect(
      validate([
        { parentRunHash: 'root', childRunHash: 'child', parentRawLineId: 'line-a' },
        { parentRunHash: 'child', childRunHash: 'grandchild', parentRawLineId: 'line-b' },
      ])
    ).toEqual(['grandchild', 'child', 'root']);
    expect(() =>
      validate([
        { parentRunHash: 'root', childRunHash: 'child', parentRawLineId: 'line-a' },
        { parentRunHash: 'child', childRunHash: 'root', parentRawLineId: 'line-b' },
      ])
    ).toThrow(/MANUFACTURING_DEPENDENCY_CYCLE/);
  });

  it('validates a rooted hierarchy deeper than two levels and exposes only leaf raws as consumable', () => {
    const { begin, order } = expandedOrder();
    const componentA = order.lines[0]!.manufacturingOrderLines.find(
      (line) => line.manufacturingOrderLineId === 'component-line-a'
    )!;
    componentA.parentManufacturingOrderLineId = 'subassembly-level-2';
    order.lines[0]!.manufacturingOrderLines = [
      {
        manufacturingOrderLineId: 'subassembly-level-1',
        parentManufacturingOrderLineId: begin.rootLineId,
        productId: 'subassembly-product-1',
        quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
        manufacturingOrderLines: [{
          manufacturingOrderLineId: 'subassembly-level-2',
          parentManufacturingOrderLineId: 'subassembly-level-1',
          productId: 'subassembly-product-2',
          quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
          manufacturingOrderLines: [componentA],
          manufacturingOrderOperations: [],
        }],
        manufacturingOrderOperations: [],
      } as any,
      ...order.lines[0]!.manufacturingOrderLines.filter(
        (line) => line.manufacturingOrderLineId !== 'component-line-a'
      ),
    ];
    const snapshot = planner('captureManufacturingSnapshot')(order, begin);
    expect(snapshot.lines.filter((line: any) => line.structural).map(
      (line: any) => line.rawLineId
    ).sort()).toEqual([begin.rootLineId, 'subassembly-level-1', 'subassembly-level-2'].sort());
    expect(planner('consumableManufacturingLines')(snapshot).map(
      (line: any) => line.rawLineId
    )).toEqual(['component-line-a', 'component-line-b']);
    expect(() => planner('captureManufacturingSnapshot')({
      ...order,
      lines: [{
        ...order.lines[0],
        manufacturingOrderLines: [{
          ...order.lines[0]!.manufacturingOrderLines[0],
          parentManufacturingOrderLineId: 'orphan-parent',
        }],
      }],
    }, begin)).toThrow(/MANUFACTURING_HIERARCHY_ORPHAN/);
  });

  it('keeps an unexpanded stocked subassembly as a consumable leaf', () => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderLines.find(
      (line) => line.manufacturingOrderLineId === 'component-line-b'
    )!.productId = 'stocked-unexpanded-subassembly';
    const snapshot = planner('captureManufacturingSnapshot')(order, begin);
    expect(planner('consumableManufacturingLines')(snapshot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawLineId: 'component-line-b',
          productId: 'stocked-unexpanded-subassembly',
          structural: false,
        }),
      ])
    );
  });

  it('rejects an incomplete expanded root or malformed nested collection', () => {
    const { begin, order } = expandedOrder();
    const missingRootChildren = structuredClone(order) as any;
    delete missingRootChildren.lines[0]!.manufacturingOrderLines;
    expect(() => planner('captureManufacturingSnapshot')(
      missingRootChildren,
      begin
    )).toThrow(/MANUFACTURING_HIERARCHY_INCOMPLETE/);

    const malformedNested = structuredClone(order) as any;
    malformedNested.lines[0].manufacturingOrderLines[0].manufacturingOrderLines = null;
    expect(() => planner('captureManufacturingSnapshot')(
      malformedNested,
      begin
    )).toThrow(/MANUFACTURING_HIERARCHY_INCOMPLETE/);
  });

  it('rejects duplicate raw-line IDs and cyclic expanded objects', () => {
    const { begin, order } = expandedOrder();
    const duplicate = structuredClone(order);
    duplicate.lines[0]!.manufacturingOrderLines.push(
      structuredClone(duplicate.lines[0]!.manufacturingOrderLines[0]!)
    );
    expect(() => planner('captureManufacturingSnapshot')(duplicate, begin))
      .toThrow(/DUPLICATE_RAW_LINE_ID/);

    const cyclic: any = structuredClone(order);
    cyclic.lines[0]!.manufacturingOrderLines[0]!.manufacturingOrderLines = [
      cyclic.lines[0],
    ];
    expect(() => planner('captureManufacturingSnapshot')(cyclic, begin))
      .toThrow(/MANUFACTURING_HIERARCHY_CYCLE/);
  });
});

describe('manufacturing batch planner', () => {
  it('is intent-order independent and selects repeated products by exact raw-line ID', () => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [];
    const plan = planner('planManufacturingBatch');
    const first = plan({
      current: order,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    const second = plan({
      current: order,
      begin,
      intents: [...intents].reverse(),
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(first).toEqual(second);
    expect(first.mode).toBe('complete');
    expect(first.state).toBe('prepared');
    expect(first.request.body.isCompleted).toBe(true);
    expect(first.request.body.pickMatchings.map((row: any) => row.manufacturingOrderLineId))
      .toEqual(['component-line-a', 'component-line-a', 'component-line-b']);
    expect(first.request.body.pickLines[0].quantity.serialNumbers).toEqual(['SERIAL-A', 'SERIAL-B']);
    expect(first.request.body.putLines[0].quantity.serialNumbers).toEqual(['SERIAL-001']);
  });

  it('creates a distinct operation-staging plan without completion or put-away', () => {
    const { begin, order } = expandedOrder();
    const result = planner('planManufacturingBatch')({
      current: order,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(result.mode).toBe('operation-staging');
    expect(result.state).toBe('staged_awaiting_operations');
    expect(result.request.body.isCompleted).toBe(false);
    expect(result.request.body.putLines).toEqual([]);
  });

  it('rejects an output serial that does not match the independent finished identity', () => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [];
    expect(() => planner('planManufacturingBatch')({
      current: order,
      begin,
      intents,
      output: { serialNumber: 'SOME-OTHER-OUTPUT', locationId: 'location-main' },
    })).toThrow(/FINISHED_SERIAL_MISMATCH/);
  });

  it('normalizes serial identity before rejecting duplicate component ownership', () => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [];
    expect(() => planner('planManufacturingBatch')({
      current: order,
      begin,
      intents: [{
        ...intents[0],
        serialNumbers: ['serial-a', 'ＳＥＲＩＡＬ－Ａ'],
      }, intents[1]],
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    })).toThrow(/DUPLICATE_COMPONENT_SERIAL/);
  });

  it('plans all four British Flag components by exact raw-line identity', () => {
    const begin = planner('planManufacturingRunBegin')({
      identity: {
        schemaVersion: 'manufacturing-run-identity/v2',
        companyId: 'company-fixture',
        finishedProductId: rawIncident.primaryFinishedProductId,
        sourceSerial: 'SERIAL-BRITISH-FLAG',
        finishedSerial: 'SERIAL-BRITISH-FLAG',
        parentRunHash: null,
        parentRawLineId: null,
      },
      locationId: rawIncident.locationId,
    });
    const current = structuredClone(rawIncident);
    current.manufacturingOrderId = begin.manufacturingOrderId;
    current.lines[0]!.manufacturingOrderLineId = begin.rootLineId;
    current.lines[0]!.productId = begin.normalizedIdentity.finishedProductId;
    current.lines[0]!.manufacturingOrderLines.forEach((line) => {
      line.parentManufacturingOrderLineId = begin.rootLineId;
    });
    current.primaryFinishedProductId = begin.normalizedIdentity.finishedProductId;
    current.remarks = begin.coordinatorMarker;
    current.pickLines = [];
    current.pickMatchings = [];
    const componentIntents = current.lines[0]!.manufacturingOrderLines.map((line) => ({
      rawLineId: line.manufacturingOrderLineId,
      productId: line.productId,
      quantity: line.quantity.standardQuantity,
      locationId: rawIncident.locationId,
      serialized: false,
      serialNumbers: [],
    }));
    const result = planner('planManufacturingBatch')({
      current,
      begin,
      intents: componentIntents.reverse(),
      output: {
        serialNumber: 'SERIAL-BRITISH-FLAG',
        locationId: rawIncident.locationId,
      },
    });
    expect(
      result.request.body.pickMatchings.map((row: any) => row.manufacturingOrderLineId)
    ).toEqual([
      '00000000-0000-4000-8000-000000000103',
      '00000000-0000-4000-8000-000000000104',
      '00000000-0000-4000-8000-000000000115',
      '00000000-0000-4000-8000-000000000121',
    ]);
    expect(result.request.body.pickMatchings.at(-1).matchedQuantity).toBe('2');
  });

  it('uses independent immutable-intent, pre-write, and expected-post hashes', () => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [];
    const result = planner('planManufacturingBatch')({
      current: order,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(new Set(Object.values(result.hashes)).size).toBe(3);

    const changedTimestamp = structuredClone(order);
    changedTimestamp.timestamp = 'new-rowversion';
    const changed = planner('planManufacturingBatch')({
      current: changedTimestamp,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(changed.hashes.immutableIntent).toBe(result.hashes.immutableIntent);
    expect(changed.hashes.completePreWriteShape).not.toBe(result.hashes.completePreWriteShape);

    const changedCompletedDate: any = structuredClone(order);
    changedCompletedDate.completedDate = '2026-01-03T12:00:00.000Z';
    const completedDatePlan = planner('planManufacturingBatch')({
      current: changedCompletedDate,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(completedDatePlan.hashes.immutableIntent).toBe(result.hashes.immutableIntent);
    expect(completedDatePlan.hashes.expectedPostState).not.toBe(
      result.hashes.expectedPostState
    );
  });

  it.each([
    ['lots', (order: any, next: any[]) => ({ order: { ...order, pickLines: [{ ...order.pickLines[0], lotId: 'lot-1' }] }, intents: next }), /UNSUPPORTED_LOTS/],
    ['split picks', (order: any, next: any[]) => ({ order, intents: [...next, { ...next[0], serialNumbers: ['SERIAL-A', 'SERIAL-B'] }] }), /UNSUPPORTED_SPLIT_PICK/],
    ['existing split picks', (order: any, next: any[]) => ({
      order: {
        ...order,
        pickLines: [
          {
            manufacturingOrderPickLineId: 'manual-pick-a',
            productId: 'repeated-component',
            locationId: 'location-main',
            lotId: null,
            quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
          },
          {
            manufacturingOrderPickLineId: 'manual-pick-b',
            productId: 'repeated-component',
            locationId: 'location-main',
            lotId: null,
            quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
          },
        ],
        pickMatchings: [
          {
            manufacturingOrderPickMatchingId: 'manual-matching-a',
            manufacturingOrderLineId: 'component-line-b',
            manufacturingOrderPickLineId: 'manual-pick-a',
            matchedQuantity: '1',
            serial: '',
          },
          {
            manufacturingOrderPickMatchingId: 'manual-matching-b',
            manufacturingOrderLineId: 'component-line-b',
            manufacturingOrderPickLineId: 'manual-pick-b',
            matchedQuantity: '1',
            serial: '',
          },
        ],
      },
      intents: next,
    }), /UNSUPPORTED_SPLIT_PICK/],
    ['existing inventory rows', (order: any, next: any[]) => ({
      order: {
        ...order,
        pickLines: [{
          manufacturingOrderPickLineId: 'existing-pick',
          productId: 'repeated-component',
          locationId: 'location-main',
          lotId: null,
          quantity: { standardQuantity: '1', uomQuantity: '1', serialNumbers: [] },
          timestamp: 'pick-rowversion',
          unknownProviderField: 'keep',
        }],
        pickMatchings: [{
          manufacturingOrderPickMatchingId: 'existing-matching',
          manufacturingOrderLineId: 'component-line-b',
          manufacturingOrderPickLineId: 'existing-pick',
          matchedQuantity: '1.0000',
          serial: '',
          timestamp: 'matching-rowversion',
        }],
      },
      intents: next,
    }), /UNSUPPORTED_EXISTING_INVENTORY_ROWS/],
    ['multiple outputs', (order: any, next: any[]) => ({ order: { ...order, lines: [...order.lines, structuredClone(order.lines[0])] }, intents: next }), /UNSUPPORTED_MULTIPLE_OUTPUTS/],
    ['ambiguous manual rows', (order: any, next: any[]) => {
      const changed = structuredClone(order);
      delete changed.lines[0].manufacturingOrderLines[0].manufacturingOrderLineId;
      return { order: changed, intents: next };
    }, /UNSUPPORTED_MANUAL_LINE/],
    ['unsupported quantities', (order: any, next: any[]) => ({ order, intents: [{ ...next[0], quantity: '1.5' }, next[1]] }), /UNSUPPORTED_QUANTITY/],
  ])('fails closed for %s', (_name, mutate, expected) => {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [];
    const changed = mutate(order, intents);
    expect(() =>
      planner('planManufacturingBatch')({
        current: changed.order,
        begin,
        intents: changed.intents,
        output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
      })
    ).toThrow(expected);
  });
});

describe('manufacturing operation completion planner', () => {
  function stagedAssemblyOrder() {
    const { begin, order } = expandedOrder();
    order.lines[0]!.manufacturingOrderOperations = [{
      manufacturingOrderOperationId: 'assembly-operation',
      manufacturingOrderLineId: begin.rootLineId,
      operationTypeId: '00000000-0000-4000-8000-000000000201',
      completedDate: null,
      trackTime: true,
      manufacturingOrderOperationTimesheets: [],
      providerExtension: { preserve: true },
    }] as any;
    const staged = planner('planManufacturingBatch')({
      current: order,
      begin,
      intents,
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    }).request.body;
    staged.timestamp = '0000000000000002';
    return { begin, staged };
  }

  it('completes only the exact Assembly shape while preserving staged rows and unknown fields', () => {
    const { begin, staged } = stagedAssemblyOrder();
    const result = planner('planManufacturingOperationCompletion')({
      current: staged,
      begin,
      completedAt: '2026-08-07T12:34:56.000+00:00',
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    expect(result.completedAt).toBe('2026-08-07T12:34:56.000Z');
    expect(result.operationIds).toEqual(['assembly-operation']);
    expect(result.request.body).toMatchObject({
      isCompleted: true,
      status: 'completed',
      completedDate: '2026-08-07T12:34:56.000Z',
    });
    expect(result.request.body.pickLines).toEqual(staged.pickLines);
    expect(result.request.body.pickMatchings).toEqual(staged.pickMatchings);
    expect(
      result.request.body.lines[0].manufacturingOrderOperations[0]
    ).toMatchObject({
      completedDate: '2026-08-07T12:34:56.000Z',
      trackTime: true,
      providerExtension: { preserve: true },
    });
    expect(result.request.body.lines[0].quantity.serialNumbers).toEqual([
      'SERIAL-001',
    ]);
    expect(result.request.body.putLines).toEqual([
      expect.objectContaining({
        manufacturingOrderLineId: begin.rootLineId,
        productId: begin.normalizedIdentity.finishedProductId,
        locationId: 'location-main',
        quantity: expect.objectContaining({ serialNumbers: ['SERIAL-001'] }),
      }),
    ]);
  });

  it('normalizes equivalent provider completion timestamps in readback hashes', () => {
    const { begin, staged } = stagedAssemblyOrder();
    const result = planner('planManufacturingOperationCompletion')({
      current: staged,
      begin,
      completedAt: '2026-08-07T12:34:56.000Z',
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    });
    const readback = structuredClone(result.request.body);
    readback.completedDate = '2026-08-07T12:34:56.000+00:00';
    readback.lines[0].manufacturingOrderOperations[0].completedDate =
      '2026-08-07T12:34:56.000+00:00';
    expect(planner('manufacturingOperationCompletionStateHash')(readback))
      .toBe(result.hashes.expectedPostState);
  });

  it.each([
    ['wrong operation type', (order: any) => {
      order.lines[0].manufacturingOrderOperations[0].operationTypeId =
        'registration-operation';
    }],
    ['track time disabled', (order: any) => {
      order.lines[0].manufacturingOrderOperations[0].trackTime = false;
    }],
    ['existing timesheet', (order: any) => {
      order.lines[0].manufacturingOrderOperations[0]
        .manufacturingOrderOperationTimesheets = [
          { manufacturingOrderOperationTimesheetId: 'timesheet-1' },
        ];
    }],
    ['partially completed operation', (order: any) => {
      order.lines[0].manufacturingOrderOperations[0].completedDate =
        '2026-08-07T12:00:00Z';
    }],
  ])('fails closed for %s', (_label, mutate) => {
    const { begin, staged } = stagedAssemblyOrder();
    mutate(staged);
    expect(() => planner('planManufacturingOperationCompletion')({
      current: staged,
      begin,
      completedAt: '2026-08-07T12:34:56.000Z',
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    })).toThrow(/UNSUPPORTED_OPERATION_COMPLETION_SHAPE/);
  });

  it('refuses to complete an order without the exact staged inventory rows', () => {
    const { begin, staged } = stagedAssemblyOrder();
    staged.pickLines = [];
    expect(() => planner('planManufacturingOperationCompletion')({
      current: staged,
      begin,
      completedAt: '2026-08-07T12:34:56.000Z',
      output: { serialNumber: 'SERIAL-001', locationId: 'location-main' },
    })).toThrow(/MANUFACTURING_ORDER_NOT_EXACTLY_STAGED/);
  });
});
