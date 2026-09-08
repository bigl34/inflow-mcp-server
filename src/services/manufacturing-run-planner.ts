import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { canonicalHash, stableStringify } from '../core/canonical-json.js';
import { normalizeDecimal } from '../core/decimal.js';
import type {
  ManufacturingOrder,
  ManufacturingOrderLine,
  ManufacturingOrderOperation,
  ManufacturingOrderPickLine,
  ManufacturingOrderPickMatching,
  ManufacturingOrderPutLine,
} from '../types/inflow.js';
import {
  applyManufacturingOrderPatch,
  canonicalManufacturingOrderProjection,
  canonicalManufacturingOrderWriteShape,
  flattenManufacturingLines,
} from './manufacturing-order-trace.js';

/*
 * Contract-owned UUIDv5 namespaces. These values are immutable once released:
 * changing one would create a second MO identity for the same business run.
 */
export const MANUFACTURING_RUN_UUID_NAMESPACES = Object.freeze({
  manufacturingOrder: '87c3b572-23c5-4fc1-8d9f-36fa9ed827d6',
  rootLine: 'fe3d0cc4-3a0d-4d85-9788-cdc4b62a7cc1',
  operation: '77fd4759-ecf4-4b78-bf75-af585d643db7',
  pickLine: 'f293f6da-7a61-45c1-91ee-d674e3fb70ce',
  pickMatching: 'eb4271b8-f26f-4e04-8e31-9a580495c97f',
  putLine: '4cc9786a-2575-419c-8070-2b1fbc430bb7',
});

export const YOUR_COMPANY_ASSEMBLY_OPERATION_TYPE_ID =
  '00000000-0000-4000-8000-000000000201';

const MARKER_PREFIX = '[inflow-manufacturing-run:v2:';
const MARKER_PATTERN = /\[inflow-manufacturing-run:v2:([A-Za-z0-9_-]+)\]/;

export interface ManufacturingRunIdentity {
  schemaVersion: 'manufacturing-run-identity/v2';
  companyId: string;
  finishedProductId: string;
  sourceSerial: string;
  finishedSerial: string;
  parentRunHash?: string | null;
  parentRawLineId?: string | null;
}

export interface BeginManufacturingRunInput {
  identity: ManufacturingRunIdentity;
  locationId: string;
  remarks?: string;
}

export interface ManufacturingRunBeginPlan {
  schemaVersion: 'manufacturing-run-begin/v1';
  normalizedIdentity: Required<ManufacturingRunIdentity>;
  runHash: string;
  manufacturingOrderId: string;
  rootLineId: string;
  operationId: string;
  coordinatorMarker: string;
  createRequest: {
    method: 'PUT';
    path: '/manufacturing-orders';
    query: { fillDefaultBom: true };
    body: ManufacturingOrder;
  };
}

interface CoordinatorMarker {
  schemaVersion: 'manufacturing-run-marker/v2';
  runHash: string;
  companyId: string;
  finishedProductId: string;
  sourceSerial: string;
  finishedSerial: string;
  manufacturingOrderId: string;
  rootLineId: string;
}

export interface ManufacturingComponentIntent {
  rawLineId: string;
  productId: string;
  quantity: string;
  locationId: string;
  sublocation?: string;
  lotId?: string | null;
  serialized: boolean;
  serialNumbers: string[];
}

interface NormalizedComponentIntent extends ManufacturingComponentIntent {
  quantity: string;
  serialNumbers: string[];
}

export interface ManufacturingDependency {
  parentRunHash: string;
  childRunHash: string;
  parentRawLineId: string;
}

export interface ManufacturingSnapshot {
  schemaVersion: 'manufacturing-snapshot/v1';
  manufacturingOrderId: string;
  rootLineId: string;
  lines: Array<{
    rawLineId: string;
    parentRawLineId: string | null;
    productId: string;
    quantity: string;
    structural?: boolean;
  }>;
  operations: Array<{
    manufacturingOrderOperationId: string;
    rawLineId: string;
    operationTypeId: string;
    lineNum: number | null;
    completedDate: string | null;
    manufacturingOrderOperationTimesheets: Array<Record<string, unknown>>;
  }>;
  snapshotHash: string;
}

export interface PlanManufacturingBatchInput {
  current: ManufacturingOrder;
  begin: ManufacturingRunBeginPlan;
  intents: ManufacturingComponentIntent[];
  output: {
    serialNumber: string;
    locationId: string;
    sublocation?: string;
  };
}

export interface ManufacturingBatchPlan {
  schemaVersion: 'manufacturing-batch-plan/v1';
  mode: 'complete' | 'operation-staging';
  state: 'prepared' | 'staged_awaiting_operations';
  request: {
    method: 'PUT';
    path: '/manufacturing-orders';
    body: ManufacturingOrder;
  };
  hashes: {
    immutableIntent: string;
    completePreWriteShape: string;
    expectedPostState: string;
  };
}

export interface PlanManufacturingOperationCompletionInput {
  current: ManufacturingOrder;
  begin: ManufacturingRunBeginPlan;
  completedAt: string;
  output: {
    serialNumber: string;
    locationId: string;
    sublocation?: string;
  };
}

export interface ManufacturingOperationCompletionPlan {
  schemaVersion: 'manufacturing-operation-completion-plan/v1';
  completedAt: string;
  operationIds: string[];
  request: {
    method: 'PUT';
    path: '/manufacturing-orders';
    body: ManufacturingOrder;
  };
  hashes: {
    immutableIntent: string;
    preState: string;
    expectedPostState: string;
  };
}

function requireNonEmpty(value: string, code: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new Error(`${code}: value is required`);
  return normalized;
}

function normalizeIdentity(identity: ManufacturingRunIdentity): Required<ManufacturingRunIdentity> {
  if (identity.schemaVersion !== 'manufacturing-run-identity/v2') {
    throw new Error('UNSUPPORTED_MANUFACTURING_RUN_IDENTITY');
  }
  return {
    schemaVersion: 'manufacturing-run-identity/v2',
    companyId: requireNonEmpty(identity.companyId, 'INVALID_COMPANY_ID').toLowerCase(),
    finishedProductId: requireNonEmpty(identity.finishedProductId, 'INVALID_FINISHED_PRODUCT_ID').toLowerCase(),
    sourceSerial: requireNonEmpty(identity.sourceSerial, 'INVALID_SOURCE_SERIAL').toUpperCase(),
    finishedSerial: requireNonEmpty(identity.finishedSerial, 'INVALID_FINISHED_SERIAL').toUpperCase(),
    parentRunHash: identity.parentRunHash?.trim().toLowerCase() || null,
    parentRawLineId: identity.parentRawLineId?.trim().toLowerCase() || null,
  };
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function encodeMarker(marker: CoordinatorMarker): string {
  return `${MARKER_PREFIX}${Buffer.from(stableStringify(marker)).toString('base64url')}]`;
}

export function planManufacturingRunBegin(
  input: BeginManufacturingRunInput
): ManufacturingRunBeginPlan {
  const normalizedIdentity = normalizeIdentity(input.identity);
  const runHash = sha256Canonical(normalizedIdentity);
  const manufacturingOrderId = uuidv5(
    runHash,
    MANUFACTURING_RUN_UUID_NAMESPACES.manufacturingOrder
  );
  const rootLineId = uuidv5(runHash, MANUFACTURING_RUN_UUID_NAMESPACES.rootLine);
  const operationId = uuidv5(runHash, MANUFACTURING_RUN_UUID_NAMESPACES.operation);
  const coordinatorMarker = encodeMarker({
    schemaVersion: 'manufacturing-run-marker/v2',
    runHash,
    companyId: normalizedIdentity.companyId,
    finishedProductId: normalizedIdentity.finishedProductId,
    sourceSerial: normalizedIdentity.sourceSerial,
    finishedSerial: normalizedIdentity.finishedSerial,
    manufacturingOrderId,
    rootLineId,
  });
  const remarks = [input.remarks?.trim(), coordinatorMarker].filter(Boolean).join('\n');
  return {
    schemaVersion: 'manufacturing-run-begin/v1',
    normalizedIdentity,
    runHash,
    manufacturingOrderId,
    rootLineId,
    operationId,
    coordinatorMarker,
    createRequest: {
      method: 'PUT',
      path: '/manufacturing-orders',
      query: { fillDefaultBom: true },
      body: {
        manufacturingOrderId,
        primaryFinishedProductId: normalizedIdentity.finishedProductId,
        locationId: requireNonEmpty(input.locationId, 'INVALID_LOCATION_ID'),
        remarks,
        isCancelled: false,
        isCompleted: false,
        lines: [{
          manufacturingOrderLineId: rootLineId,
          parentManufacturingOrderLineId: null,
          productId: normalizedIdentity.finishedProductId,
          quantity: {
            standardQuantity: '1',
            uomQuantity: '1',
            serialNumbers: [],
          },
        }],
      },
    },
  };
}

export function parseAndVerifyCoordinatorMarker(
  remarks: string | undefined,
  expected: ManufacturingRunBeginPlan
): CoordinatorMarker {
  const encoded = MARKER_PATTERN.exec(remarks ?? '')?.[1];
  if (!encoded) throw new Error('COORDINATOR_MARKER_MISSING');
  let marker: CoordinatorMarker;
  try {
    marker = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CoordinatorMarker;
  } catch {
    throw new Error('COORDINATOR_MARKER_INVALID');
  }
  const expectedMarker: CoordinatorMarker = {
    schemaVersion: 'manufacturing-run-marker/v2',
    runHash: expected.runHash,
    companyId: expected.normalizedIdentity.companyId,
    finishedProductId: expected.normalizedIdentity.finishedProductId,
    sourceSerial: expected.normalizedIdentity.sourceSerial,
    finishedSerial: expected.normalizedIdentity.finishedSerial,
    manufacturingOrderId: expected.manufacturingOrderId,
    rootLineId: expected.rootLineId,
  };
  if (stableStringify(marker) !== stableStringify(expectedMarker)) {
    throw new Error('COORDINATOR_MARKER_MISMATCH');
  }
  return marker;
}

function positiveIntegerQuantity(value: string | undefined): string {
  let normalized: string;
  try {
    normalized = normalizeDecimal(value ?? '');
  } catch {
    throw new Error(`UNSUPPORTED_QUANTITY: ${value ?? 'missing'}`);
  }
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`UNSUPPORTED_QUANTITY: ${value ?? 'missing'}`);
  }
  return normalized;
}

function requireLineShape(line: ManufacturingOrderLine): {
  rawLineId: string;
  parentRawLineId: string | null;
  productId: string;
  quantity: string;
  structural: boolean;
} {
  if (
    ('manufacturingOrderLines' in line &&
      !Array.isArray(line.manufacturingOrderLines)) ||
    ('manufacturingOrderOperations' in line &&
      !Array.isArray(line.manufacturingOrderOperations))
  ) {
    throw new Error('MANUFACTURING_HIERARCHY_INCOMPLETE');
  }
  const rawLineId = line.manufacturingOrderLineId;
  const productId = line.productId;
  if (!rawLineId || !productId || !line.quantity?.standardQuantity) {
    throw new Error('UNSUPPORTED_MANUAL_LINE: every line needs an exact ID, product and quantity');
  }
  const parentRawLineId = line.parentManufacturingOrderLineId ?? null;
  return {
    rawLineId,
    parentRawLineId,
    productId,
    quantity: positiveIntegerQuantity(line.quantity.standardQuantity),
    structural: (line.manufacturingOrderLines?.length ?? 0) > 0,
  };
}

function operationSnapshot(
  operation: ManufacturingOrderOperation,
  fallbackLineId: string
): ManufacturingSnapshot['operations'][number] {
  if (!operation.manufacturingOrderOperationId || !operation.operationTypeId) {
    throw new Error('UNSUPPORTED_MANUAL_OPERATION');
  }
  const rawLineId = operation.manufacturingOrderLineId ?? fallbackLineId;
  const manufacturingOrderOperationTimesheets = [
    ...(operation.manufacturingOrderOperationTimesheets ?? []),
  ]
    .map((row) => {
      if (!row.manufacturingOrderOperationTimesheetId) {
        throw new Error('UNSUPPORTED_MANUAL_TIMESHEET');
      }
      return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    })
    .sort((a, b) =>
      String(a.manufacturingOrderOperationTimesheetId).localeCompare(
        String(b.manufacturingOrderOperationTimesheetId)
      )
    );
  return {
    manufacturingOrderOperationId: operation.manufacturingOrderOperationId,
    rawLineId,
    operationTypeId: operation.operationTypeId,
    lineNum: operation.lineNum ?? null,
    completedDate: operation.completedDate ?? null,
    manufacturingOrderOperationTimesheets,
  };
}

export function captureManufacturingSnapshot(
  order: ManufacturingOrder,
  begin: ManufacturingRunBeginPlan
): ManufacturingSnapshot {
  if (order.manufacturingOrderId !== begin.manufacturingOrderId) {
    throw new Error('MANUFACTURING_ORDER_ID_MISMATCH');
  }
  if (order.primaryFinishedProductId?.toLowerCase() !== begin.normalizedIdentity.finishedProductId) {
    throw new Error('FINISHED_PRODUCT_MISMATCH');
  }
  parseAndVerifyCoordinatorMarker(order.remarks, begin);
  if ((order.lines?.length ?? 0) !== 1) {
    throw new Error('UNSUPPORTED_MULTIPLE_OUTPUTS');
  }
  const rootLine = order.lines![0]!;
  if (
    !Array.isArray(rootLine.manufacturingOrderLines) ||
    rootLine.manufacturingOrderLines.length === 0
  ) {
    throw new Error('MANUFACTURING_HIERARCHY_INCOMPLETE');
  }
  const lines: ManufacturingSnapshot['lines'] = [];
  const operations: ManufacturingSnapshot['operations'] = [];
  const activeObjects = new WeakSet<object>();
  const visitedObjects = new WeakSet<object>();
  const rawLineIds = new Set<string>();
  const visit = (
    line: ManufacturingOrderLine,
    expectedParentRawLineId: string | null
  ): void => {
    if (activeObjects.has(line)) {
      throw new Error('MANUFACTURING_HIERARCHY_CYCLE');
    }
    if (visitedObjects.has(line)) {
      throw new Error('MANUFACTURING_HIERARCHY_SHARED_LINE');
    }
    activeObjects.add(line);
    visitedObjects.add(line);
    const shaped = requireLineShape(line);
    if (rawLineIds.has(shaped.rawLineId)) {
      throw new Error(`DUPLICATE_RAW_LINE_ID: ${shaped.rawLineId}`);
    }
    rawLineIds.add(shaped.rawLineId);
    if (shaped.parentRawLineId !== expectedParentRawLineId) {
      throw new Error(
        `MANUFACTURING_HIERARCHY_ORPHAN: ${shaped.rawLineId} expected parent ${expectedParentRawLineId ?? 'null'}, got ${shaped.parentRawLineId ?? 'null'}`
      );
    }
    lines.push(shaped);
    for (const operation of line.manufacturingOrderOperations ?? []) {
      const captured = operationSnapshot(operation, shaped.rawLineId);
      if (captured.rawLineId !== shaped.rawLineId) {
        throw new Error(
          `MANUFACTURING_OPERATION_ORPHAN: ${captured.manufacturingOrderOperationId}`
        );
      }
      operations.push(captured);
    }
    for (const child of line.manufacturingOrderLines ?? []) {
      visit(child, shaped.rawLineId);
    }
    activeObjects.delete(line);
  };
  visit(rootLine, null);
  lines.sort((a, b) => a.rawLineId.localeCompare(b.rawLineId));
  operations.sort((a, b) =>
    a.manufacturingOrderOperationId.localeCompare(b.manufacturingOrderOperationId)
  );
  const root = lines.find((line) => line.parentRawLineId === null);
  if (!root || root.rawLineId !== begin.rootLineId || root.productId.toLowerCase() !== begin.normalizedIdentity.finishedProductId) {
    throw new Error('ROOT_LINE_IDENTITY_MISMATCH');
  }
  const snapshotBase = {
    schemaVersion: 'manufacturing-snapshot/v1' as const,
    manufacturingOrderId: order.manufacturingOrderId!,
    rootLineId: root.rawLineId,
    lines,
    operations,
  };
  return {
    ...snapshotBase,
    snapshotHash: canonicalHash(snapshotBase, 'manufacturing-order/expanded-snapshot/v1'),
  };
}

export function consumableManufacturingLines(
  snapshot: ManufacturingSnapshot
): ManufacturingSnapshot['lines'] {
  return snapshot.lines
    .filter((line) => line.rawLineId !== snapshot.rootLineId && !line.structural)
    .sort((a, b) => a.rawLineId.localeCompare(b.rawLineId));
}

export function validateManufacturingSnapshot(
  current: ManufacturingOrder,
  expected: ManufacturingSnapshot,
  begin: ManufacturingRunBeginPlan
): void {
  const actual = captureManufacturingSnapshot(current, begin);
  if (actual.snapshotHash !== expected.snapshotHash) {
    throw new Error(
      `MANUFACTURING_SNAPSHOT_DRIFT: expected ${expected.snapshotHash}, got ${actual.snapshotHash}`
    );
  }
}

export function validateManufacturingDependencies(
  dependencies: ManufacturingDependency[]
): string[] {
  const children = new Map<string, Set<string>>();
  const ownerByLine = new Map<string, string>();
  const nodes = new Set<string>();
  for (const dependency of dependencies) {
    const parent = requireNonEmpty(dependency.parentRunHash, 'INVALID_PARENT_RUN');
    const child = requireNonEmpty(dependency.childRunHash, 'INVALID_CHILD_RUN');
    const lineKey = `${parent}\0${requireNonEmpty(dependency.parentRawLineId, 'INVALID_PARENT_RAW_LINE')}`;
    const priorChild = ownerByLine.get(lineKey);
    if (priorChild && priorChild !== child) {
      throw new Error('MANUFACTURING_DEPENDENCY_CONFLICT');
    }
    ownerByLine.set(lineKey, child);
    nodes.add(parent);
    nodes.add(child);
    const next = children.get(parent) ?? new Set<string>();
    next.add(child);
    children.set(parent, next);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      throw new Error(`MANUFACTURING_DEPENDENCY_CYCLE: ${node}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of [...(children.get(node) ?? [])].sort()) visit(child);
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  };
  for (const node of [...nodes].sort()) visit(node);
  return result;
}

function compactSerials(serials: string[]): string[] {
  const compacted = serials
    .map((serial) => serial.normalize('NFKC').trim().toUpperCase())
    .filter(Boolean)
    .sort();
  if (new Set(compacted).size !== compacted.length) {
    throw new Error('DUPLICATE_COMPONENT_SERIAL');
  }
  return compacted;
}

function normalizeComponentIntents(
  snapshot: ManufacturingSnapshot,
  intents: ManufacturingComponentIntent[]
): NormalizedComponentIntent[] {
  const linesById = new Map(
    consumableManufacturingLines(snapshot).map((line) => [line.rawLineId, line])
  );
  const seen = new Set<string>();
  const normalized = intents.map((intent): NormalizedComponentIntent => {
    if (seen.has(intent.rawLineId)) throw new Error(`UNSUPPORTED_SPLIT_PICK: ${intent.rawLineId}`);
    seen.add(intent.rawLineId);
    if (intent.lotId) throw new Error(`UNSUPPORTED_LOTS: ${intent.rawLineId}`);
    const line = linesById.get(intent.rawLineId);
    if (!line) throw new Error(`UNKNOWN_COMPONENT_RAW_LINE: ${intent.rawLineId}`);
    const quantity = positiveIntegerQuantity(intent.quantity);
    const expectedQuantity = positiveIntegerQuantity(line.quantity);
    if (quantity !== expectedQuantity) {
      throw new Error(`COMPONENT_QUANTITY_MISMATCH: ${intent.rawLineId}`);
    }
    if (line.productId !== intent.productId) {
      throw new Error(`COMPONENT_PRODUCT_MISMATCH: ${intent.rawLineId}`);
    }
    const serialNumbers = compactSerials(intent.serialNumbers);
    const numericQuantity = Number(quantity);
    if (!Number.isSafeInteger(numericQuantity)) {
      throw new Error(`UNSUPPORTED_QUANTITY: ${quantity}`);
    }
    if (intent.serialized && serialNumbers.length !== numericQuantity) {
      throw new Error(`SERIAL_COUNT_MISMATCH: ${intent.rawLineId}`);
    }
    if (!intent.serialized && serialNumbers.length > 0) {
      throw new Error(`UNSUPPORTED_NON_SERIALIZED_SERIALS: ${intent.rawLineId}`);
    }
    return {
      ...intent,
      quantity,
      serialNumbers,
      locationId: requireNonEmpty(intent.locationId, 'INVALID_COMPONENT_LOCATION'),
    };
  }).sort((a, b) => a.rawLineId.localeCompare(b.rawLineId));
  const expectedIds = [...linesById.keys()].sort();
  const actualIds = normalized.map((intent) => intent.rawLineId);
  if (stableStringify(actualIds) !== stableStringify(expectedIds)) {
    throw new Error('COMPONENT_INTENT_SET_MISMATCH');
  }
  return normalized;
}

function ensureSupportedExistingShape(current: ManufacturingOrder): void {
  if ((current.lines?.length ?? 0) !== 1) throw new Error('UNSUPPORTED_MULTIPLE_OUTPUTS');
  if (current.isCancelled || current.isCompleted || ['cancelled', 'completed', 'closed'].includes(current.status?.toLowerCase() ?? '')) {
    throw new Error('MANUFACTURING_ORDER_NOT_WRITABLE');
  }
  const pickIds = new Set<string>();
  for (const pick of current.pickLines ?? []) {
    if (pick.lotId) throw new Error('UNSUPPORTED_LOTS');
    if (!pick.manufacturingOrderPickLineId || !pick.productId || !pick.locationId || !pick.quantity) {
      throw new Error('UNSUPPORTED_AMBIGUOUS_PICK_ROW');
    }
    positiveIntegerQuantity(pick.quantity.standardQuantity);
    pickIds.add(pick.manufacturingOrderPickLineId);
  }
  for (const put of current.putLines ?? []) {
    if (put.lotId) throw new Error('UNSUPPORTED_LOTS');
  }
  const matchingsByPick = new Map<string, number>();
  const picksByRawLine = new Map<string, Set<string>>();
  for (const matching of current.pickMatchings ?? []) {
    if (!matching.manufacturingOrderLineId || !matching.manufacturingOrderPickLineId) {
      throw new Error('UNSUPPORTED_AMBIGUOUS_MATCHING_ROW');
    }
    if (!pickIds.has(matching.manufacturingOrderPickLineId)) {
      throw new Error('UNSUPPORTED_ORPHAN_PICK_MATCHING');
    }
    positiveIntegerQuantity(matching.matchedQuantity);
    matchingsByPick.set(
      matching.manufacturingOrderPickLineId,
      (matchingsByPick.get(matching.manufacturingOrderPickLineId) ?? 0) + 1
    );
    const matchingPicks = picksByRawLine.get(matching.manufacturingOrderLineId) ?? new Set<string>();
    matchingPicks.add(matching.manufacturingOrderPickLineId);
    picksByRawLine.set(matching.manufacturingOrderLineId, matchingPicks);
  }
  if ([...picksByRawLine.values()].some((ids) => ids.size > 1)) {
    throw new Error('UNSUPPORTED_SPLIT_PICK');
  }
  for (const pick of current.pickLines ?? []) {
    if (!matchingsByPick.has(pick.manufacturingOrderPickLineId!)) {
      throw new Error('UNSUPPORTED_ORPHAN_PICK');
    }
  }
  if (
    (current.pickLines?.length ?? 0) > 0 ||
    (current.pickMatchings?.length ?? 0) > 0 ||
    (current.putLines?.length ?? 0) > 0
  ) {
    throw new Error('UNSUPPORTED_EXISTING_INVENTORY_ROWS');
  }
}

function buildPickState(
  begin: ManufacturingRunBeginPlan,
  intents: NormalizedComponentIntent[]
): { pickLines: ManufacturingOrderPickLine[]; pickMatchings: ManufacturingOrderPickMatching[] } {
  const pickLines: ManufacturingOrderPickLine[] = [];
  const pickMatchings: ManufacturingOrderPickMatching[] = [];
  for (const intent of intents) {
    const pickLineId = uuidv5(
      `${begin.runHash}\0${intent.rawLineId}`,
      MANUFACTURING_RUN_UUID_NAMESPACES.pickLine
    );
    pickLines.push({
      manufacturingOrderPickLineId: pickLineId,
      manufacturingOrderId: begin.manufacturingOrderId,
      productId: intent.productId,
      locationId: intent.locationId,
      lotId: null,
      sublocation: intent.sublocation ?? '',
      quantity: {
        standardQuantity: intent.quantity,
        uomQuantity: intent.quantity,
        serialNumbers: intent.serialNumbers,
      },
    });
    if (intent.serialized) {
      intent.serialNumbers.forEach((serial, index) => {
        pickMatchings.push({
          manufacturingOrderPickMatchingId: uuidv5(
            `${begin.runHash}\0${intent.rawLineId}\0${index}\0${serial}`,
            MANUFACTURING_RUN_UUID_NAMESPACES.pickMatching
          ),
          manufacturingOrderId: begin.manufacturingOrderId,
          manufacturingOrderLineId: intent.rawLineId,
          manufacturingOrderPickLineId: pickLineId,
          matchedQuantity: '1',
          serial,
        });
      });
    } else {
      pickMatchings.push({
        manufacturingOrderPickMatchingId: uuidv5(
          `${begin.runHash}\0${intent.rawLineId}\0non-serialized`,
          MANUFACTURING_RUN_UUID_NAMESPACES.pickMatching
        ),
        manufacturingOrderId: begin.manufacturingOrderId,
        manufacturingOrderLineId: intent.rawLineId,
        manufacturingOrderPickLineId: pickLineId,
        matchedQuantity: intent.quantity,
        serial: '',
      });
    }
  }
  return { pickLines, pickMatchings };
}

function setRootOutputSerial(
  lines: ManufacturingOrderLine[],
  rootLineId: string,
  serialNumber: string
): ManufacturingOrderLine[] {
  const next = structuredClone(lines);
  const flattened = flattenManufacturingLines(next);
  const root = flattened.find((line) => line.manufacturingOrderLineId === rootLineId);
  if (!root) throw new Error('ROOT_LINE_IDENTITY_MISMATCH');
  const quantity = positiveIntegerQuantity(root.quantity?.standardQuantity);
  if (quantity !== '1') throw new Error('UNSUPPORTED_OUTPUT_QUANTITY');
  root.quantity = {
    ...root.quantity,
    standardQuantity: quantity,
    uomQuantity: quantity,
    serialNumbers: [serialNumber],
  };
  return next;
}

function rawPreWriteShape(current: ManufacturingOrder): unknown {
  return canonicalManufacturingOrderWriteShape(current);
}

function normalizeCompletionTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : value;
}

function normalizedCompletionProjection(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedCompletionProjection);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === 'completedDate'
        ? normalizeCompletionTimestamp(child)
        : normalizedCompletionProjection(child),
    ])
  );
}

export function manufacturingOperationCompletionStateHash(
  order: ManufacturingOrder
): string {
  return canonicalHash(
    normalizedCompletionProjection(
      canonicalManufacturingOrderProjection(order)
    ),
    'manufacturing-run/operation-completion-state/v1'
  );
}

function completeAssemblyOperations(
  lines: ManufacturingOrderLine[],
  completedAt: string
): { lines: ManufacturingOrderLine[]; operationIds: string[] } {
  const next = structuredClone(lines);
  const operationIds: string[] = [];
  for (const line of flattenManufacturingLines(next)) {
    for (const operation of line.manufacturingOrderOperations ?? []) {
      if (
        !operation.manufacturingOrderOperationId ||
        operation.operationTypeId !== YOUR_COMPANY_ASSEMBLY_OPERATION_TYPE_ID ||
        operation.trackTime !== true ||
        operation.completedDate != null ||
        (operation.manufacturingOrderOperationTimesheets?.length ?? 0) !== 0
      ) {
        throw new Error('UNSUPPORTED_OPERATION_COMPLETION_SHAPE');
      }
      operation.completedDate = completedAt;
      operationIds.push(operation.manufacturingOrderOperationId);
    }
  }
  operationIds.sort();
  if (operationIds.length === 0) {
    throw new Error('MANUFACTURING_OPERATIONS_MISSING');
  }
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error('DUPLICATE_MANUFACTURING_OPERATION_ID');
  }
  return { lines: next, operationIds };
}

export function planManufacturingOperationCompletion(
  input: PlanManufacturingOperationCompletionInput
): ManufacturingOperationCompletionPlan {
  if (
    input.current.isCancelled ||
    input.current.isCompleted ||
    ['cancelled', 'canceled', 'completed', 'closed'].includes(
      input.current.status?.toLowerCase() ?? ''
    )
  ) {
    throw new Error('MANUFACTURING_ORDER_NOT_WRITABLE');
  }
  if (
    (input.current.pickLines?.length ?? 0) === 0 ||
    (input.current.pickMatchings?.length ?? 0) === 0 ||
    (input.current.putLines?.length ?? 0) !== 0
  ) {
    throw new Error('MANUFACTURING_ORDER_NOT_EXACTLY_STAGED');
  }
  const completedMilliseconds = Date.parse(input.completedAt);
  if (!Number.isFinite(completedMilliseconds)) {
    throw new Error('INVALID_OPERATION_COMPLETION_TIMESTAMP');
  }
  const completedAt = new Date(completedMilliseconds).toISOString();
  const outputSerial = requireNonEmpty(
    input.output.serialNumber,
    'INVALID_FINISHED_SERIAL'
  ).toUpperCase();
  if (outputSerial !== input.begin.normalizedIdentity.finishedSerial) {
    throw new Error('FINISHED_SERIAL_MISMATCH');
  }
  const outputLocation = requireNonEmpty(
    input.output.locationId,
    'INVALID_OUTPUT_LOCATION'
  );
  const completed = completeAssemblyOperations(
    input.current.lines ?? [],
    completedAt
  );
  const lines = setRootOutputSerial(
    completed.lines,
    input.begin.rootLineId,
    outputSerial
  );
  const putLines: ManufacturingOrderPutLine[] = [{
    manufacturingOrderPutLineId: uuidv5(
      `${input.begin.runHash}\0${input.begin.rootLineId}`,
      MANUFACTURING_RUN_UUID_NAMESPACES.putLine
    ),
    manufacturingOrderId: input.begin.manufacturingOrderId,
    manufacturingOrderLineId: input.begin.rootLineId,
    productId: input.begin.normalizedIdentity.finishedProductId,
    locationId: outputLocation,
    lotId: null,
    sublocation: input.output.sublocation ?? '',
    quantity: {
      standardQuantity: '1',
      uomQuantity: '1',
      serialNumbers: [outputSerial],
    },
  }];
  const desired = applyManufacturingOrderPatch(input.current, {
    lines,
    pickLines: structuredClone(input.current.pickLines ?? []),
    pickMatchings: structuredClone(input.current.pickMatchings ?? []),
    putLines,
    isCompleted: true,
    status: 'completed',
    completedDate: completedAt,
  });
  return {
    schemaVersion: 'manufacturing-operation-completion-plan/v1',
    completedAt,
    operationIds: completed.operationIds,
    request: {
      method: 'PUT',
      path: '/manufacturing-orders',
      body: desired,
    },
    hashes: {
      immutableIntent: canonicalHash({
        runHash: input.begin.runHash,
        operationIds: completed.operationIds,
        completedAt,
        output: {
          serialNumber: outputSerial,
          locationId: outputLocation,
          sublocation: input.output.sublocation ?? '',
        },
      }, 'manufacturing-run/operation-completion-intent/v1'),
      preState: manufacturingOperationCompletionStateHash(input.current),
      expectedPostState: manufacturingOperationCompletionStateHash(desired),
    },
  };
}

export function planManufacturingBatch(
  input: PlanManufacturingBatchInput
): ManufacturingBatchPlan {
  ensureSupportedExistingShape(input.current);
  const snapshot = captureManufacturingSnapshot(input.current, input.begin);
  const normalizedIntents = normalizeComponentIntents(snapshot, input.intents);
  const outputSerial = requireNonEmpty(
    input.output.serialNumber,
    'INVALID_FINISHED_SERIAL'
  ).toUpperCase();
  if (outputSerial !== input.begin.normalizedIdentity.finishedSerial) {
    throw new Error('FINISHED_SERIAL_MISMATCH');
  }
  const outputLocation = requireNonEmpty(input.output.locationId, 'INVALID_OUTPUT_LOCATION');
  const { pickLines, pickMatchings } = buildPickState(input.begin, normalizedIntents);
  const operationBearing = snapshot.operations.length > 0;
  const putLines: ManufacturingOrderPutLine[] = operationBearing ? [] : [{
    manufacturingOrderPutLineId: uuidv5(
      `${input.begin.runHash}\0${input.begin.rootLineId}`,
      MANUFACTURING_RUN_UUID_NAMESPACES.putLine
    ),
    manufacturingOrderId: input.begin.manufacturingOrderId,
    manufacturingOrderLineId: input.begin.rootLineId,
    productId: input.begin.normalizedIdentity.finishedProductId,
    locationId: outputLocation,
    lotId: null,
    sublocation: input.output.sublocation ?? '',
    quantity: {
      standardQuantity: '1',
      uomQuantity: '1',
      serialNumbers: [outputSerial],
    },
  }];
  const lines = operationBearing
    ? structuredClone(input.current.lines ?? [])
    : setRootOutputSerial(input.current.lines ?? [], input.begin.rootLineId, outputSerial);
  const desired = applyManufacturingOrderPatch(input.current, {
    lines,
    pickLines,
    pickMatchings,
    putLines,
    isCompleted: operationBearing ? false : true,
    status: operationBearing ? input.current.status : 'completed',
  });
  const immutableIntent = canonicalHash({
    begin: input.begin.normalizedIdentity,
    runHash: input.begin.runHash,
    intents: normalizedIntents,
    output: {
      serialNumber: outputSerial,
      locationId: outputLocation,
      sublocation: input.output.sublocation ?? '',
    },
  }, 'manufacturing-run/immutable-intent/v1');
  const completePreWriteShape = canonicalHash(
    rawPreWriteShape(input.current),
    'manufacturing-run/complete-pre-write/v1'
  );
  const expectedPostState = canonicalHash(
    canonicalManufacturingOrderProjection(desired),
    'manufacturing-run/expected-post/v1'
  );
  return {
    schemaVersion: 'manufacturing-batch-plan/v1',
    mode: operationBearing ? 'operation-staging' : 'complete',
    state: operationBearing ? 'staged_awaiting_operations' : 'prepared',
    request: {
      method: 'PUT',
      path: '/manufacturing-orders',
      body: desired,
    },
    hashes: {
      immutableIntent,
      completePreWriteShape,
      expectedPostState,
    },
  };
}
