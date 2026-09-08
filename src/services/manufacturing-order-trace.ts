import { randomUUID } from 'node:crypto';
import type { InflowClient } from '../client/inflow.js';
import { canonicalHash } from '../core/canonical-json.js';
import { normalizeDecimal } from '../core/decimal.js';
import type {
  ManufacturingOrder,
  ManufacturingOrderLine,
  ManufacturingOrderOperation,
  ManufacturingOrderPickLine,
  ManufacturingOrderPickMatching,
  ManufacturingOrderPutLine,
} from '../types/inflow.js';

export const MO_TRACE_INCLUDE = [
  'lines',
  'lines.manufacturingOrderOperations',
  'pickLines',
  'pickMatchings',
  'putLines',
];

export interface SerialReconcileInput {
  mode: 'patch' | 'replace';
  outputLines?: Array<{ manufacturingOrderLineId: string; serialNumbers: string[] }>;
  inputPicks?: Array<{
    manufacturingOrderLineId: string;
    manufacturingOrderPickLineId: string;
    serialNumbers: string[];
  }>;
}

export async function fetchManufacturingOrderTrace(client: InflowClient, id: string): Promise<ManufacturingOrder> {
  return client.get<ManufacturingOrder>(`/manufacturing-orders/${id}`, { include: MO_TRACE_INCLUDE });
}

export function flattenManufacturingLines(lines: ManufacturingOrderLine[]): ManufacturingOrderLine[] {
  const result: ManufacturingOrderLine[] = [];
  const visit = (row: ManufacturingOrderLine) => {
    result.push(row);
    for (const child of row.manufacturingOrderLines ?? []) visit(child);
  };
  for (const row of lines) visit(row);
  return result;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate].sort();
}

function serialCountMatches(quantity: string | undefined, serials: string[]): boolean {
  if (quantity === undefined) return false;
  try { return normalizeDecimal(quantity) === String(serials.length); } catch { return false; }
}

export function normalizeManufacturingOrderTrace(order: ManufacturingOrder) {
  const lines = flattenManufacturingLines(order.lines ?? []);
  const pickLines = order.pickLines ?? [];
  const matchings = order.pickMatchings ?? [];
  const putLines = order.putLines ?? [];
  const lineById = new Map(lines.filter((row) => row.manufacturingOrderLineId).map((row) => [row.manufacturingOrderLineId!, row]));
  const pickById = new Map(pickLines.filter((row) => row.manufacturingOrderPickLineId).map((row) => [row.manufacturingOrderPickLineId!, row]));
  const anomalies: Array<{ code: string; ids: string[]; details?: Record<string, unknown> }> = [];

  for (const row of matchings) {
    const line = row.manufacturingOrderLineId ? lineById.get(row.manufacturingOrderLineId) : undefined;
    const pick = row.manufacturingOrderPickLineId ? pickById.get(row.manufacturingOrderPickLineId) : undefined;
    if (!line || !pick) anomalies.push({ code: 'ORPHAN_PICK_MATCHING', ids: [row.manufacturingOrderPickMatchingId ?? 'unknown'] });
    else if (line.productId !== pick.productId) anomalies.push({ code: 'PICK_PRODUCT_MISMATCH', ids: [line.manufacturingOrderLineId!, pick.manufacturingOrderPickLineId!] });
  }

  for (const pick of pickLines) {
    const linked = matchings.filter((row) => row.manufacturingOrderPickLineId === pick.manufacturingOrderPickLineId);
    const pickSerials = pick.quantity?.serialNumbers ?? [];
    const matchingSerials = linked.map((row) => row.serial).filter((serial): serial is string => Boolean(serial));
    if (linked.length === 0) anomalies.push({ code: 'PICK_WITHOUT_MATCHINGS', ids: [pick.manufacturingOrderPickLineId ?? 'unknown'] });
    if (pickSerials.length > 0 && linked.length === 0) anomalies.push({ code: 'PICK_SERIALS_WITHOUT_MATCHINGS', ids: [pick.manufacturingOrderPickLineId ?? 'unknown'] });
    const onlyPick = pickSerials.filter((serial) => !matchingSerials.includes(serial));
    const onlyMatching = matchingSerials.filter((serial) => !pickSerials.includes(serial));
    if (onlyPick.length || onlyMatching.length) anomalies.push({ code: 'SERIAL_REPRESENTATION_MISMATCH', ids: [pick.manufacturingOrderPickLineId ?? 'unknown'], details: { onlyPick: onlyPick.sort(), onlyMatching: onlyMatching.sort() } });
    if (pickSerials.length > 0 && !serialCountMatches(pick.quantity?.standardQuantity, pickSerials)) anomalies.push({ code: 'PICK_QUANTITY_SERIAL_COUNT_MISMATCH', ids: [pick.manufacturingOrderPickLineId ?? 'unknown'] });
  }

  const outputSerials = lines.flatMap((row) => row.quantity?.serialNumbers ?? []);
  const pickSerials = pickLines.flatMap((row) => row.quantity?.serialNumbers ?? []);
  const duplicateSerials = [
    ...new Set([...duplicates(outputSerials), ...duplicates(pickSerials)]),
  ].sort();
  if (duplicateSerials.length) anomalies.push({ code: 'DUPLICATE_SERIAL', ids: duplicateSerials });
  const duplicateMatchingSerials = duplicates(matchings.map((row) => row.serial).filter((serial): serial is string => Boolean(serial)));
  if (duplicateMatchingSerials.length) anomalies.push({ code: 'DUPLICATE_MATCHING_SERIAL', ids: duplicateMatchingSerials });
  for (const line of lines) {
    const serials = line.quantity?.serialNumbers ?? [];
    if (serials.length && !serialCountMatches(line.quantity?.standardQuantity, serials)) anomalies.push({ code: 'OUTPUT_QUANTITY_SERIAL_COUNT_MISMATCH', ids: [line.manufacturingOrderLineId ?? 'unknown'] });
  }

  return {
    manufacturingOrderId: order.manufacturingOrderId,
    manufacturingOrderNumber: order.manufacturingOrderNumber,
    status: order.status,
    timestamp: order.timestamp,
    outputLines: lines.map((row) => ({
      manufacturingOrderLineId: row.manufacturingOrderLineId,
      parentManufacturingOrderLineId: row.parentManufacturingOrderLineId ?? null,
      productId: row.productId,
      quantity: row.quantity?.standardQuantity ?? null,
      serialNumbers: [...(row.quantity?.serialNumbers ?? [])].sort(),
      operations: normalizeOperations(row.manufacturingOrderOperations ?? []),
      timestamp: row.timestamp,
    })),
    inputPicks: pickLines.map((row) => ({
      manufacturingOrderPickLineId: row.manufacturingOrderPickLineId,
      productId: row.productId,
      locationId: row.locationId,
      quantity: row.quantity?.standardQuantity ?? null,
      serialNumbers: [...(row.quantity?.serialNumbers ?? [])].sort(),
      matchingLineIds: [...new Set(matchings.filter((matching) => matching.manufacturingOrderPickLineId === row.manufacturingOrderPickLineId).map((matching) => matching.manufacturingOrderLineId).filter((id): id is string => Boolean(id)))].sort(),
      timestamp: row.timestamp,
    })),
    pickMatchings: matchings.map((row) => ({
      manufacturingOrderPickMatchingId: row.manufacturingOrderPickMatchingId,
      manufacturingOrderLineId: row.manufacturingOrderLineId,
      manufacturingOrderPickLineId: row.manufacturingOrderPickLineId,
      matchedQuantity: row.matchedQuantity ?? null,
      serial: row.serial ?? null,
      timestamp: row.timestamp,
    })),
    putLines: putLines.map((row) => ({
      manufacturingOrderPutLineId: row.manufacturingOrderPutLineId,
      manufacturingOrderLineId: row.manufacturingOrderLineId,
      productId: row.productId,
      locationId: row.locationId,
      lotId: row.lotId ?? null,
      sublocation: row.sublocation ?? null,
      quantity: row.quantity?.standardQuantity ?? null,
      serialNumbers: [...(row.quantity?.serialNumbers ?? [])].sort(),
      putDate: row.putDate ?? null,
      timestamp: row.timestamp,
    })),
    anomalies: anomalies.sort((a, b) => a.code.localeCompare(b.code) || a.ids.join('\0').localeCompare(b.ids.join('\0'))),
  };
}

function normalizeOperations(rows: ManufacturingOrderOperation[]) {
  return rows
    .map((row) => ({
      ...withoutVolatile(row, new Set(['manufacturingOrderOperationTimesheets'])),
      manufacturingOrderOperationTimesheets: [
        ...(row.manufacturingOrderOperationTimesheets ?? []),
      ]
        .map((timesheet) => withoutVolatile(timesheet))
        .sort((a, b) => identityOf(a).localeCompare(identityOf(b))),
    }))
    .sort((a, b) => identityOf(a).localeCompare(identityOf(b)));
}

function one<T>(rows: T[], code: string): T {
  if (rows.length !== 1) throw new Error(`${code}: expected exactly one match, found ${rows.length}`);
  return rows[0]!;
}

export function buildDesiredSerialState(
  current: ManufacturingOrder,
  input: SerialReconcileInput,
  plannedMatchingIds: string[] = []
): ManufacturingOrder {
  if (current.isCancelled || current.isCompleted || ['Closed', 'Cancelled', 'Completed'].includes(current.status ?? '')) {
    throw new Error('MANUFACTURING_ORDER_NOT_WRITABLE');
  }
  const rootLines = structuredClone(current.lines ?? []);
  const lines = flattenManufacturingLines(rootLines);
  const picks = (current.pickLines ?? []).map((row) => ({ ...row, quantity: row.quantity ? { ...row.quantity, serialNumbers: [...(row.quantity.serialNumbers ?? [])] } : undefined }));
  const currentMatchings = (current.pickMatchings ?? []).map((row) => ({ ...row }));
  let matchings = input.mode === 'replace' ? [] : currentMatchings.map((row) => ({ ...row }));
  if (input.mode === 'replace') {
    const suppliedOutputLineIds = new Set((input.outputLines ?? []).map((row) => row.manufacturingOrderLineId));
    const suppliedPickIds = new Set((input.inputPicks ?? []).map((row) => row.manufacturingOrderPickLineId));
    for (const line of lines) {
      if (!suppliedOutputLineIds.has(line.manufacturingOrderLineId ?? '')) {
        line.quantity = { ...line.quantity, serialNumbers: [] };
      }
    }
    for (const pick of picks) {
      if (!suppliedPickIds.has(pick.manufacturingOrderPickLineId ?? '')) {
        pick.quantity = { ...pick.quantity, serialNumbers: [] };
      }
    }
  }
  for (const update of input.outputLines ?? []) {
    const line = one(lines.filter((row) => row.manufacturingOrderLineId === update.manufacturingOrderLineId), 'OUTPUT_LINE_MATCH');
    if (!serialCountMatches(line.quantity?.standardQuantity, update.serialNumbers)) throw new Error(`OUTPUT_SERIAL_COUNT_MISMATCH: ${update.manufacturingOrderLineId}`);
    line.quantity = { ...line.quantity, serialNumbers: [...update.serialNumbers] };
  }
  let plannedIndex = 0;
  for (const update of input.inputPicks ?? []) {
    const line = one(lines.filter((row) => row.manufacturingOrderLineId === update.manufacturingOrderLineId), 'INPUT_LINE_MATCH');
    const pick = one(picks.filter((row) => row.manufacturingOrderPickLineId === update.manufacturingOrderPickLineId), 'PICK_LINE_MATCH');
    if (line.productId !== pick.productId) throw new Error('PICK_PRODUCT_MISMATCH');
    const linked = currentMatchings.filter((row) => row.manufacturingOrderLineId === update.manufacturingOrderLineId && row.manufacturingOrderPickLineId === update.manufacturingOrderPickLineId);
    if (linked.length === 0) throw new Error('PICK_MATCHING_REQUIRED_FOR_EXACT_SELECTOR');
    if (!serialCountMatches(pick.quantity?.standardQuantity, update.serialNumbers)) throw new Error(`PICK_SERIAL_COUNT_MISMATCH: ${update.manufacturingOrderPickLineId}`);
    pick.quantity = { ...pick.quantity, serialNumbers: [...update.serialNumbers] };
    if (input.mode === 'patch') matchings = matchings.filter((row) => !(row.manufacturingOrderLineId === update.manufacturingOrderLineId && row.manufacturingOrderPickLineId === update.manufacturingOrderPickLineId));
    matchings.push(...update.serialNumbers.map((serial, index): ManufacturingOrderPickMatching => {
      const existing = linked[index];
      return {
        manufacturingOrderPickMatchingId: existing?.manufacturingOrderPickMatchingId ?? plannedMatchingIds[plannedIndex++] ?? randomUUID(),
        manufacturingOrderId: current.manufacturingOrderId,
        manufacturingOrderLineId: update.manufacturingOrderLineId,
        manufacturingOrderPickLineId: update.manufacturingOrderPickLineId,
        matchedQuantity: existing?.matchedQuantity ?? '1',
        serial,
        lastModifiedById: existing?.lastModifiedById,
        timestamp: existing?.timestamp,
      };
    }));
  }
  return { ...current, lines: rootLines, pickLines: picks, pickMatchings: matchings };
}

export function manufacturingOrderSerialSemantic(order: ManufacturingOrder) {
  return JSON.parse(JSON.stringify(normalizeManufacturingOrderTrace(order))) as unknown;
}

export function manufacturingOrderSerialWriteShape(order: ManufacturingOrder) {
  const semantic = JSON.parse(JSON.stringify(normalizeManufacturingOrderTrace(order))) as ReturnType<typeof normalizeManufacturingOrderTrace>;
  return {
    ...semantic,
    outputLines: semantic.outputLines.map((row) => ({ ...row })),
    inputPicks: semantic.inputPicks.map((row) => ({ ...row })),
    pickMatchings: semantic.pickMatchings.map((row) => ({ ...row })),
    putLines: semantic.putLines.map((row) => ({ ...row })),
  };
}

const VOLATILE_PROVIDER_FIELDS = new Set([
  'timestamp',
  'lastModifiedById',
  'createdDate',
  'modifiedDate',
  'lastModifiedDateTime',
  'pickDate',
  'putDate',
]);

const IDENTITY_FIELDS = [
  'manufacturingOrderOperationTimesheetId',
  'manufacturingOrderOperationId',
  'manufacturingOrderPickMatchingId',
  'manufacturingOrderPickLineId',
  'manufacturingOrderPutLineId',
  'manufacturingOrderLineId',
] as const;

function identityOf(row: Record<string, unknown>): string {
  for (const field of IDENTITY_FIELDS) {
    const value = row[field];
    if (typeof value === 'string') return `${field}\0${value}`;
  }
  return '';
}

function withoutVolatile(
  value: Record<string, unknown>,
  omit: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (VOLATILE_PROVIDER_FIELDS.has(key) || omit.has(key)) continue;
    result[key] = child;
  }
  return result;
}

function canonicalQuantity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'standardQuantity' || key === 'uomQuantity' || key === 'matchedQuantity') && typeof child === 'string') {
      try {
        result[key] = normalizeDecimal(child);
      } catch {
        result[key] = child;
      }
    } else if (key === 'serialNumbers' && Array.isArray(child)) {
      result[key] = child.filter((serial): serial is string => typeof serial === 'string').sort();
    } else {
      result[key] = canonicalUnknown(child);
    }
  }
  if (!Object.hasOwn(result, 'uom')) result.uom = '';
  return result;
}

function canonicalUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    const rows = value.map(canonicalUnknown);
    if (
      rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)) &&
      rows.every((row) => identityOf(row as Record<string, unknown>) !== '')
    ) {
      return [...rows].sort((left, right) =>
        identityOf(left as Record<string, unknown>).localeCompare(identityOf(right as Record<string, unknown>))
      );
    }
    return rows;
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_PROVIDER_FIELDS.has(key)) continue;
    if (key === 'description' && child === '') continue;
    if (key === 'quantity') {
      result[key] = canonicalQuantity(child);
    } else if (key === 'matchedQuantity' && typeof child === 'string') {
      try {
        result[key] = normalizeDecimal(child);
      } catch {
        result[key] = child;
      }
    } else {
      result[key] = canonicalUnknown(child);
    }
  }
  return result;
}

function canonicalLine(row: ManufacturingOrderLine): Record<string, unknown> {
  const base = withoutVolatile(row, new Set(['manufacturingOrderLines', 'manufacturingOrderOperations']));
  return {
    ...canonicalUnknown(base) as Record<string, unknown>,
    parentManufacturingOrderLineId: row.parentManufacturingOrderLineId ?? null,
    quantity: canonicalQuantity(row.quantity),
    operations: normalizeOperations(row.manufacturingOrderOperations ?? []).map(canonicalUnknown),
  };
}

/**
 * Canonical, complete projection for semantic comparisons. Provider rowversion
 * fields are omitted, while unknown non-volatile fields remain hash-significant.
 */
export function canonicalManufacturingOrderProjection(order: ManufacturingOrder) {
  const flattenedLines = flattenManufacturingLines(order.lines ?? []);
  const rootLineId = flattenedLines.find(
    (line) => line.parentManufacturingOrderLineId == null
  )?.manufacturingOrderLineId;
  const header = withoutVolatile(order, new Set([
    'lines',
    'pickLines',
    'pickMatchings',
    'putLines',
    'completedDate',
  ]));
  const canonicalHeader = canonicalUnknown(header) as Record<string, unknown>;
  if (
    canonicalHeader.status === 'open' &&
    !order.isCompleted &&
    ((order.pickLines?.length ?? 0) > 0 || (order.pickMatchings?.length ?? 0) > 0)
  ) {
    canonicalHeader.status = 'inProgress';
  }
  return {
    ...canonicalHeader,
    completedDate: typeof order.completedDate === 'string' ? order.completedDate : null,
    lines: flattenedLines
      .map(canonicalLine)
      .sort((a, b) => {
        const leftRoot = a.parentManufacturingOrderLineId === null;
        const rightRoot = b.parentManufacturingOrderLineId === null;
        if (leftRoot !== rightRoot) return leftRoot ? -1 : 1;
        return identityOf(a).localeCompare(identityOf(b));
      }),
    pickLines: (order.pickLines ?? [])
      .map((row) => canonicalUnknown(withoutVolatile(row)) as Record<string, unknown>)
      .sort((a, b) => identityOf(a).localeCompare(identityOf(b))),
    pickMatchings: (order.pickMatchings ?? [])
      .map((row) => canonicalUnknown(withoutVolatile(row)) as Record<string, unknown>)
      .sort((a, b) => identityOf(a).localeCompare(identityOf(b))),
    putLines: (order.putLines ?? [])
      .map((row) => {
        const canonical = canonicalUnknown(withoutVolatile(row)) as Record<string, unknown>;
        if (!canonical.manufacturingOrderLineId && rootLineId) {
          canonical.manufacturingOrderLineId = rootLineId;
        }
        return canonical;
      })
      .sort((a, b) => identityOf(a).localeCompare(identityOf(b))),
  };
}

export function manufacturingOrderFullSemanticHash(order: ManufacturingOrder): string {
  return canonicalHash(
    canonicalManufacturingOrderProjection(order),
    'manufacturing-order/full-semantic/v1'
  );
}

function canonicalWriteUnknown(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const rows = value.map((row) => canonicalWriteUnknown(row));
    if (parentKey === 'serialNumbers' && rows.every((row) => typeof row === 'string')) {
      return [...rows].sort();
    }
    if (
      rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)) &&
      rows.every((row) => identityOf(row as Record<string, unknown>) !== '')
    ) {
      return [...rows].sort((left, right) =>
        identityOf(left as Record<string, unknown>).localeCompare(
          identityOf(right as Record<string, unknown>)
        )
      );
    }
    return rows;
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    result[key] = canonicalWriteUnknown(child, key);
  }
  return result;
}

/**
 * Complete canonical write shape. Unlike the semantic projection this retains
 * every rowversion and provider field, while normalizing identity-array order.
 */
export function canonicalManufacturingOrderWriteShape(order: ManufacturingOrder): unknown {
  return canonicalWriteUnknown(order);
}

export type ManufacturingOrderAllowlistedPatch = Pick<
  ManufacturingOrder,
  'lines' | 'pickLines' | 'pickMatchings' | 'putLines' | 'isCompleted' | 'status' | 'completedDate'
>;

const ALLOWLISTED_PATCH_FIELDS = new Set<keyof ManufacturingOrderAllowlistedPatch>([
  'lines',
  'pickLines',
  'pickMatchings',
  'putLines',
  'isCompleted',
  'status',
  'completedDate',
]);

/**
 * Apply the planner's narrow state transition to an untouched full GET
 * document. Every unpatched provider field and identity-bearing row survives.
 */
export function applyManufacturingOrderPatch(
  raw: ManufacturingOrder,
  patch: ManufacturingOrderAllowlistedPatch
): ManufacturingOrder {
  for (const key of Object.keys(patch)) {
    if (!ALLOWLISTED_PATCH_FIELDS.has(key as keyof ManufacturingOrderAllowlistedPatch)) {
      throw new Error(`UNSUPPORTED_MANUFACTURING_ORDER_PATCH: ${key}`);
    }
  }
  const desired = structuredClone(raw);
  for (const key of Object.keys(patch) as Array<keyof ManufacturingOrderAllowlistedPatch>) {
    const value = patch[key];
    if (value !== undefined) (desired as Record<string, unknown>)[key] = structuredClone(value);
  }
  return desired;
}
