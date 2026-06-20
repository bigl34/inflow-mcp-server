// Manufacturing Order tools for inFlow MCP Server

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  ManufacturingOrder,
  ManufacturingOrderLine,
  ManufacturingOrderFilter,
  PaginationParams,
} from '../types/inflow.js';

const manufacturingInputItemSchema = z.object({
  productId: z.string(),
  quantity: z.number(),
  sublocation: z.string().optional(),
});

const manufacturingInputLinePatchSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  quantity: z.number().optional(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

export type ManufacturingOrderInputItem = z.infer<typeof manufacturingInputItemSchema>;
export type ManufacturingOrderInputLinePatch = z.infer<typeof manufacturingInputLinePatchSchema>;

export type ManufacturingOrderUpsertArgs = {
  id?: string;
  orderNumber?: string;
  orderDate?: string;
  dueDate?: string;
  locationId?: string;
  primaryFinishedProductId?: string;
  outputQuantity?: number;
  outputSerialNumbers?: string[];
  outputSublocation?: string;
  inputLines?: ManufacturingOrderInputLinePatch[];
  deleteInputLineIds?: string[];
  remarks?: string;
  pickRemarks?: string;
  putAwayRemarks?: string;
  isCancelled?: boolean;
  isCompleted?: boolean;
  customFields?: Record<string, unknown>;
  timestamp?: string;
};

/**
 * Build the MO line tree for a fresh `PUT /manufacturing-orders` create call.
 * The parent line at index 0 is the output/finished product; any `inputItems`
 * become nested `manufacturingOrderLines` children. `outputSerialNumbers`, when
 * provided, populates the parent's `quantity.serialNumbers` — the example date
 * serial-drop fix that previously forced callers into raw REST PUTs.
 */
export function buildManufacturingOrderLines(
  outputProductId: string,
  outputQuantity: number,
  inputItems?: ManufacturingOrderInputItem[],
  outputSerialNumbers?: string[]
): ManufacturingOrderLine[] {
  const childLines: ManufacturingOrderLine[] = (inputItems ?? []).map((item) => {
    const child: ManufacturingOrderLine & { sublocation?: string } = {
      manufacturingOrderLineId: randomUUID(),
      productId: item.productId,
      quantity: {
        standardQuantity: String(item.quantity),
        uomQuantity: String(item.quantity),
      },
    };
    if (item.sublocation !== undefined) child.sublocation = item.sublocation;
    return child;
  });

  const parentQuantity: { standardQuantity: string; uomQuantity: string; serialNumbers?: string[] } = {
    standardQuantity: String(outputQuantity),
    uomQuantity: String(outputQuantity),
  };
  if (outputSerialNumbers !== undefined) {
    parentQuantity.serialNumbers = outputSerialNumbers;
  }

  return [
    {
      manufacturingOrderLineId: randomUUID(),
      productId: outputProductId,
      parentManufacturingOrderLineId: null,
      quantity: parentQuantity,
      manufacturingOrderLines: childLines,
    },
  ];
}

/**
 * Merge a partial upsert payload onto an existing manufacturing order.
 *
 * inFlow's `PUT /manufacturing-orders` treats the body as the full desired
 * state. A partial `lines[]` payload silently drops nested fields like
 * `quantity.serialNumbers` on the output parent line (and wipes child input
 * lines) while still returning 200 OK. This helper reconciles caller input
 * against the most-recent GET, preserving every field the caller did not
 * explicitly override.
 *
 * Header merge is presence-based so `false` / `''` / `[]` / `0` are settable
 * (matches `mergeSalesOrderUpdate`).
 *
 * Line-merge rules (applied to `existing.lines[0].manufacturingOrderLines[]`):
 *   1. Lines whose ids are in `deleteInputLineIds` are removed first.
 *   2. Each `inputLines[]` patch matches an existing line by `id`; failing
 *      that, by unambiguous `productId` (throws on multiple matches).
 *   3. Patches with no match are appended as new input lines.
 *
 * The output line at `existing.lines[0]` is patched in place — never replaced
 * — so `manufacturingOrderLineId`, `parentManufacturingOrderLineId`, and
 * `timestamp` survive an update that only touches serials.
 */
export function mergeManufacturingOrderUpdate(
  existing: ManufacturingOrder,
  args: ManufacturingOrderUpsertArgs
): ManufacturingOrder {
  const merged: ManufacturingOrder = { ...existing };

  // Presence-based header merge. `'key' in args` beats truthy checks because
  // callers may intentionally set isCancelled: true, isCompleted: false, etc.
  if ('orderNumber' in args) merged.manufacturingOrderNumber = args.orderNumber;
  if ('orderDate' in args) merged.orderDate = args.orderDate;
  if ('dueDate' in args) merged.dueDate = args.dueDate;
  if ('locationId' in args) merged.locationId = args.locationId;
  if ('primaryFinishedProductId' in args)
    merged.primaryFinishedProductId = args.primaryFinishedProductId;
  if ('remarks' in args) merged.remarks = args.remarks;
  if ('pickRemarks' in args) merged.pickRemarks = args.pickRemarks;
  if ('putAwayRemarks' in args) merged.putAwayRemarks = args.putAwayRemarks;
  if ('isCancelled' in args) merged.isCancelled = args.isCancelled;
  if ('isCompleted' in args) merged.isCompleted = args.isCompleted;
  if ('customFields' in args) merged.customFields = args.customFields;
  if ('timestamp' in args) merged.timestamp = args.timestamp;

  const existingLines = existing.lines ?? [];
  if (existingLines.length === 0) {
    throw new Error(
      'Cannot merge manufacturing order update: existing order has no output line to patch'
    );
  }

  const patchedOutput = patchOutputLine(existingLines[0], args);
  const patchedChildren = patchInputLines(
    patchedOutput.manufacturingOrderLines ?? [],
    args
  );
  patchedOutput.manufacturingOrderLines = patchedChildren;

  // Preserve any extra top-level lines inFlow might return beyond the first
  // (defensive — today MO has exactly one output line, but slicing the tail
  // keeps us robust if the API ever surfaces more).
  merged.lines = [patchedOutput, ...existingLines.slice(1)];
  return merged;
}

/** Apply outputQuantity / outputSerialNumbers / outputSublocation to a cloned parent. */
function patchOutputLine(
  existingParent: ManufacturingOrderLine,
  args: ManufacturingOrderUpsertArgs
): ManufacturingOrderLine {
  const merged: ManufacturingOrderLine & { sublocation?: string } = { ...existingParent };

  const patchHasQuantity = 'outputQuantity' in args;
  const patchHasSerials = 'outputSerialNumbers' in args;
  if (patchHasQuantity || patchHasSerials) {
    const priorQuantity = existingParent.quantity ?? {};
    const nextQuantity: { [k: string]: unknown } = { ...priorQuantity };
    if (patchHasQuantity) {
      nextQuantity.standardQuantity = String(args.outputQuantity);
      nextQuantity.uomQuantity = String(args.outputQuantity);
    }
    if (patchHasSerials) {
      nextQuantity.serialNumbers = args.outputSerialNumbers;
    }
    merged.quantity = nextQuantity as ManufacturingOrderLine['quantity'];
  }

  if ('outputSublocation' in args) {
    merged.sublocation = args.outputSublocation;
  }

  return merged;
}

/** Apply deletes, then patch/append each inputLines entry against a working copy. */
function patchInputLines(
  existingChildren: ManufacturingOrderLine[],
  args: ManufacturingOrderUpsertArgs
): ManufacturingOrderLine[] {
  const deleteSet = new Set(args.deleteInputLineIds ?? []);
  const workingChildren: ManufacturingOrderLine[] = existingChildren
    .filter(
      (line) => !(line.manufacturingOrderLineId && deleteSet.has(line.manufacturingOrderLineId))
    )
    .map((line) => ({ ...line }));

  for (const patch of args.inputLines ?? []) {
    const matchIndex = findInputLineIndexForPatch(workingChildren, patch);
    if (matchIndex >= 0) {
      workingChildren[matchIndex] = patchInputLine(workingChildren[matchIndex], patch);
      continue;
    }
    workingChildren.push(buildNewInputLine(patch));
  }

  return workingChildren;
}

function findInputLineIndexForPatch(
  lines: ManufacturingOrderLine[],
  patch: ManufacturingOrderInputLinePatch
): number {
  if (patch.id) {
    return lines.findIndex((line) => line.manufacturingOrderLineId === patch.id);
  }
  if (patch.productId) {
    const matchingIndices = lines
      .map((line, index) => (line.productId === patch.productId ? index : -1))
      .filter((index) => index >= 0);
    if (matchingIndices.length === 1) return matchingIndices[0];
    if (matchingIndices.length > 1) {
      throw new Error(
        `Ambiguous input line patch: productId ${patch.productId} matches ${matchingIndices.length} existing lines. Pass an explicit id to disambiguate.`
      );
    }
  }
  return -1;
}

function patchInputLine(
  existing: ManufacturingOrderLine,
  patch: ManufacturingOrderInputLinePatch
): ManufacturingOrderLine {
  const merged: ManufacturingOrderLine & { sublocation?: string } = { ...existing };

  if ('productId' in patch) merged.productId = patch.productId;
  if ('sublocation' in patch) merged.sublocation = patch.sublocation;

  const patchHasQuantity = 'quantity' in patch;
  const patchHasSerials = 'serialNumbers' in patch;
  if (patchHasQuantity || patchHasSerials) {
    const priorQuantity = existing.quantity ?? {};
    const nextQuantity: { [k: string]: unknown } = { ...priorQuantity };
    if (patchHasQuantity) {
      nextQuantity.standardQuantity = String(patch.quantity);
      nextQuantity.uomQuantity = String(patch.quantity);
    }
    if (patchHasSerials) {
      nextQuantity.serialNumbers = patch.serialNumbers;
    }
    merged.quantity = nextQuantity as ManufacturingOrderLine['quantity'];
  }

  return merged;
}

function buildNewInputLine(
  patch: ManufacturingOrderInputLinePatch
): ManufacturingOrderLine {
  if (patch.quantity === undefined) {
    throw new Error(
      'New manufacturing order input lines must include quantity. Pass inputLines[].quantity when adding a line with no existing match.'
    );
  }

  const line: ManufacturingOrderLine & { sublocation?: string } = {
    manufacturingOrderLineId: patch.id ?? randomUUID(),
    productId: patch.productId,
    quantity: {
      standardQuantity: String(patch.quantity),
      uomQuantity: String(patch.quantity),
      serialNumbers: patch.serialNumbers,
    },
  };
  if (patch.sublocation !== undefined) line.sublocation = patch.sublocation;
  return line;
}

export function registerManufacturingOrderTools(
  server: McpServer,
  client: InflowClient
): void {
  // List Manufacturing Orders
  server.tool(
    'list_manufacturing_orders',
    'Search and list manufacturing/work orders',
    {
      orderNumber: z.string().optional().describe('Filter by order number'),
      locationId: z.string().optional().describe('Filter by location ID'),
      status: z
        .enum(['Open', 'InProgress', 'Completed', 'Cancelled'])
        .optional(),
      outputProductId: z.string().optional().describe('Filter by output product'),
      orderDateFrom: z.string().optional(),
      orderDateTo: z.string().optional(),
      include: z.array(z.string()).optional(),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., orderDate, orderNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: ManufacturingOrderFilter = {};
      if (args.orderNumber) filters.manufacturingOrderNumber = args.orderNumber;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.status) filters.status = args.status;
      if (args.outputProductId) filters.primaryFinishedProductId = args.outputProductId;
      if (args.orderDateFrom) filters.orderDateFrom = args.orderDateFrom;
      if (args.orderDateTo) filters.orderDateTo = args.orderDateTo;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<ManufacturingOrder>('/manufacturing-orders', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: ManufacturingOrder[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Manufacturing Order
  server.tool(
    'get_manufacturing_order',
    'Get details of a specific manufacturing order',
    {
      manufacturingOrderId: z.string().describe('The manufacturing order ID'),
      include: z.array(z.string()).optional(),
    },
    async (args) => {
      const order = await client.get<ManufacturingOrder>(
        `/manufacturing-orders/${args.manufacturingOrderId}`,
        { include: args.include }
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(order, null, 2) }],
      };
    }
  );

  // Create/Update Manufacturing Order
  server.tool(
    'upsert_manufacturing_order',
    'Create a new manufacturing order or update an existing one. When `id` is provided, performs a partial update: unmentioned header fields and line items are preserved, `outputSerialNumbers`/`outputQuantity` patch the parent output line in place, `inputLines[]` patches merge into existing component lines by id (or unambiguous productId), and any `deleteInputLineIds` are removed. Without `id`, creates a new MO from `outputProductId`, `outputQuantity`, optional `inputItems`, and optional `outputSerialNumbers`.',
    {
      id: z.string().optional().describe('Order ID (required for updates)'),
      orderNumber: z.string().optional().describe('Order number (e.g. MO-001)'),
      orderDate: z.string().optional().describe('Order date (ISO format)'),
      requiredDate: z.string().optional().describe('Required completion date (ISO format)'),
      locationId: z.string().optional().describe('Location ID'),
      outputProductId: z.string().optional().describe('Product ID being manufactured (required for creates)'),
      outputQuantity: z.number().optional().describe('Quantity to manufacture (required for creates; patches the output line on updates)'),
      outputSerialNumbers: z
        .array(z.string())
        .optional()
        .describe('Serial numbers / serial numbers for the output/finished product. On updates, patches quantity.serialNumbers on the parent output line; pass [] to clear.'),
      outputSublocation: z.string().optional().describe('Sublocation for the output line'),
      inputItems: z
        .array(manufacturingInputItemSchema)
        .optional()
        .describe('Input/component items (used for create only — unused on updates)'),
      inputLines: z
        .array(manufacturingInputLinePatchSchema)
        .optional()
        .describe('Input-line patches for updates. Each entry merges into an existing component line by `id` (or unambiguous `productId`); entries with no match are appended as new lines. Set `quantity`, `serialNumbers`, or `sublocation` to patch those fields; omit to preserve them.'),
      deleteInputLineIds: z
        .array(z.string())
        .optional()
        .describe('manufacturingOrderLineId values to remove from the order during an update.'),
      remarks: z.string().optional(),
      pickRemarks: z.string().optional(),
      putAwayRemarks: z.string().optional(),
      isCancelled: z.boolean().optional().describe('Set true to cancel the MO while preserving the rest of its state'),
      isCompleted: z.boolean().optional(),
      customFields: z.record(z.string(), z.unknown()).optional(),
      timestamp: z.string().optional().describe('Rowversion for optimistic concurrency — pass the value from the last GET'),
    },
    async (args) => {
      // Update path: GET existing state, merge the partial payload, PUT the
      // full merged body. This fixes the historical merge bug where an
      // incomplete `lines[]` body caused inFlow to strip
      // quantity.serialNumbers from the output line.
      if (args.id) {
        const existing = await client.get<ManufacturingOrder>(
          `/manufacturing-orders/${args.id}`,
          { include: ['lines'] }
        );

        const mergeArgs: ManufacturingOrderUpsertArgs = {
          id: args.id,
          ...(args.orderNumber !== undefined ? { orderNumber: args.orderNumber } : {}),
          ...(args.orderDate !== undefined ? { orderDate: args.orderDate } : {}),
          ...(args.requiredDate !== undefined ? { dueDate: args.requiredDate } : {}),
          ...(args.locationId !== undefined ? { locationId: args.locationId } : {}),
          ...(args.outputProductId !== undefined
            ? { primaryFinishedProductId: args.outputProductId }
            : {}),
          ...(args.outputQuantity !== undefined ? { outputQuantity: args.outputQuantity } : {}),
          ...(args.outputSerialNumbers !== undefined
            ? { outputSerialNumbers: args.outputSerialNumbers }
            : {}),
          ...(args.outputSublocation !== undefined
            ? { outputSublocation: args.outputSublocation }
            : {}),
          ...(args.inputLines !== undefined ? { inputLines: args.inputLines } : {}),
          ...(args.deleteInputLineIds !== undefined
            ? { deleteInputLineIds: args.deleteInputLineIds }
            : {}),
          ...(args.remarks !== undefined ? { remarks: args.remarks } : {}),
          ...(args.pickRemarks !== undefined ? { pickRemarks: args.pickRemarks } : {}),
          ...(args.putAwayRemarks !== undefined ? { putAwayRemarks: args.putAwayRemarks } : {}),
          ...(args.isCancelled !== undefined ? { isCancelled: args.isCancelled } : {}),
          ...(args.isCompleted !== undefined ? { isCompleted: args.isCompleted } : {}),
          ...(args.customFields !== undefined ? { customFields: args.customFields } : {}),
          ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
        };

        const mergedBody = mergeManufacturingOrderUpdate(existing, mergeArgs);
        mergedBody.manufacturingOrderId = args.id;

        const updateResult = await client.put<ManufacturingOrder>(
          '/manufacturing-orders',
          mergedBody
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(updateResult, null, 2) }],
        };
      }

      // Create path: outputProductId and outputQuantity are required.
      if (!args.outputProductId || args.outputQuantity === undefined) {
        throw new Error(
          'Creating a manufacturing order requires both outputProductId and outputQuantity. Pass id to update an existing MO instead.'
        );
      }

      const manufacturingOrderId = randomUUID();
      const createBody: ManufacturingOrder = {
        manufacturingOrderId,
        manufacturingOrderNumber: args.orderNumber,
        orderDate: args.orderDate,
        dueDate: args.requiredDate,
        locationId: args.locationId,
        primaryFinishedProductId: args.outputProductId,
        lines: buildManufacturingOrderLines(
          args.outputProductId,
          args.outputQuantity,
          args.inputItems,
          args.outputSerialNumbers
        ),
        remarks: args.remarks,
        pickRemarks: args.pickRemarks,
        putAwayRemarks: args.putAwayRemarks,
        isCancelled: args.isCancelled,
        isCompleted: args.isCompleted,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const createResult = await client.put<ManufacturingOrder>(
        '/manufacturing-orders',
        createBody
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(createResult, null, 2) }],
      };
    }
  );
}
