// Sales Order tools for inFlow MCP Server

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import { randomUUID } from 'node:crypto';
import type {
  SalesOrder,
  SalesOrderLine,
  SalesOrderFilter,
  PaginationParams,
  Address,
} from '../types/inflow.js';

const addressSchema = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

const salesOrderItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  description: z.string().optional(),
  // Optional so partial updates can touch serialNumbers / unitPrice without
  // restating quantity. New lines (no id, no existing match) must include it;
  // that's validated at line-build time.
  quantity: z.number().optional(),
  unitPrice: z.number().optional(),
  discount: z.number().optional(),
  discountType: z.enum(['Percent', 'Amount']).optional(),
  taxCodeId: z.string().optional(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const orderStatusEnum = z.enum(['Open', 'PartiallyFulfilled', 'Fulfilled', 'Cancelled', 'Closed']);

export type SalesOrderItemPatch = z.infer<typeof salesOrderItemSchema>;

export type SalesOrderUpsertArgs = {
  id?: string;
  orderNumber?: string;
  orderDate?: string;
  requiredDate?: string;
  customerId?: string;
  locationId?: string;
  billingAddress?: Address;
  shippingAddress?: Address;
  pricingSchemeId?: string;
  taxingSchemeId?: string;
  paymentTermsId?: string;
  currencyCode?: string;
  nonCustomerCost?: number;
  items?: SalesOrderItemPatch[];
  remarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  deleteLineIds?: string[];
};

export const upsertSalesOrderToolSchema = {
  id: z.string().optional().describe('Sales order ID (required for updates)'),
  orderNumber: z.string().optional().describe('Order number'),
  orderDate: z.string().optional().describe('Order date (ISO format)'),
  requiredDate: z.string().optional().describe('Required/ship date (ISO format)'),
  customerId: z
    .string()
    .optional()
    .describe('Customer ID (required for creates; preserved from the existing order on updates)'),
  locationId: z.string().optional().describe('Location/warehouse ID'),
  billingAddress: addressSchema.optional().describe('Billing address'),
  shippingAddress: addressSchema.optional().describe('Shipping address'),
  pricingSchemeId: z.string().optional().describe('Pricing scheme ID'),
  taxingSchemeId: z.string().optional().describe('Taxing scheme ID'),
  paymentTermsId: z.string().optional().describe('Payment terms ID'),
  currencyCode: z.string().optional().describe('Currency code (e.g., USD)'),
  nonCustomerCost: z.number().optional().describe('Non-customer cost amount'),
  items: z.array(salesOrderItemSchema).optional().describe(
    'Order line items. For updates, each item patches an existing line when it has a matching `id` (salesOrderLineId) or unambiguous `productId`; items without a match are appended as new lines. Unmentioned existing lines are preserved.'
  ),
  deleteLineIds: z
    .array(z.string())
    .optional()
    .describe('salesOrderLineId values to remove from the order during an update.'),
  remarks: z.string().optional().describe('Order remarks/notes'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Custom field values'),
  timestamp: z.string().optional().describe('Timestamp for concurrency control'),
};

/**
 * Merge a partial upsert payload onto an existing sales order.
 *
 * inFlow's `PUT /sales-orders` treats the body as the full desired state. If the
 * caller sends a `lines[]` missing per-line fields (timestamp, subtotal,
 * taxCodeId), inFlow silently drops nested fields like `quantity.serialNumbers`
 * and still returns 200 OK. This helper reconciles caller input against the
 * most-recent GET, preserving every field the caller did not explicitly override.
 *
 * Matching rules for items:
 *   1. If an item carries `id`, match an existing line by `salesOrderLineId`;
 *      when found, patch in place (preserve un-mentioned fields); otherwise
 *      append as a new line carrying that id.
 *   2. If an item has no `id`, fall back to matching by `productId` — but only
 *      when exactly one existing line has that productId. Multiple matches
 *      throw an ambiguity error; zero matches append as a new line.
 *   3. Lines whose ids are in `deleteLineIds` are removed before patches apply.
 */
export function mergeSalesOrderUpdate(
  existing: SalesOrder,
  args: SalesOrderUpsertArgs
): SalesOrder & { nonCustomerCost?: number } {
  const merged: SalesOrder & { nonCustomerCost?: number } = { ...existing };

  // Presence-based header merge, so callers can intentionally set 0 / '' / [].
  if ('orderNumber' in args) merged.orderNumber = args.orderNumber;
  if ('orderDate' in args) merged.orderDate = args.orderDate;
  if ('requiredDate' in args) merged.requiredDate = args.requiredDate;
  if ('customerId' in args) merged.customerId = args.customerId;
  if ('locationId' in args) merged.locationId = args.locationId;
  if ('billingAddress' in args) merged.billingAddress = args.billingAddress;
  if ('shippingAddress' in args) merged.shippingAddress = args.shippingAddress;
  if ('pricingSchemeId' in args) merged.pricingSchemeId = args.pricingSchemeId;
  if ('taxingSchemeId' in args) merged.taxingSchemeId = args.taxingSchemeId;
  if ('paymentTermsId' in args) merged.paymentTermsId = args.paymentTermsId;
  if ('currencyCode' in args) merged.currencyCode = args.currencyCode;
  if ('remarks' in args) merged.orderRemarks = args.remarks;
  if ('customFields' in args) merged.customFields = args.customFields;
  if ('timestamp' in args) merged.timestamp = args.timestamp;
  if ('nonCustomerCost' in args) merged.nonCustomerCost = args.nonCustomerCost;

  // Start from existing lines, drop any the caller asked to delete.
  const deleteSet = new Set(args.deleteLineIds ?? []);
  const workingLines: SalesOrderLine[] = (existing.lines ?? [])
    .filter((line) => !(line.salesOrderLineId && deleteSet.has(line.salesOrderLineId)))
    .map((line) => ({ ...line }));

  for (const patch of args.items ?? []) {
    const matchIndex = findLineIndexForPatch(workingLines, patch);
    if (matchIndex >= 0) {
      workingLines[matchIndex] = patchSalesOrderLine(workingLines[matchIndex], patch);
      continue;
    }
    workingLines.push(buildNewSalesOrderLine(patch));
  }

  merged.lines = workingLines;
  return merged;
}

/** Locate the existing line a patch targets; throws on productId ambiguity. */
function findLineIndexForPatch(
  lines: SalesOrderLine[],
  patch: SalesOrderItemPatch
): number {
  if (patch.id) {
    return lines.findIndex((line) => line.salesOrderLineId === patch.id);
  }
  if (patch.productId) {
    const matchingIndices = lines
      .map((line, index) => (line.productId === patch.productId ? index : -1))
      .filter((index) => index >= 0);
    if (matchingIndices.length === 1) return matchingIndices[0];
    if (matchingIndices.length > 1) {
      throw new Error(
        `Ambiguous line patch: productId ${patch.productId} matches ${matchingIndices.length} existing lines. Pass an explicit id to disambiguate.`
      );
    }
  }
  return -1;
}

function patchSalesOrderLine(
  existing: SalesOrderLine,
  patch: SalesOrderItemPatch
): SalesOrderLine {
  const merged: SalesOrderLine = { ...existing };

  if ('productId' in patch) merged.productId = patch.productId;
  if ('description' in patch) merged.description = patch.description;
  if ('unitPrice' in patch) merged.unitPrice = patch.unitPrice;
  if ('discount' in patch) merged.discount = patch.discount;
  if ('discountType' in patch) merged.discountType = patch.discountType;
  if ('taxCodeId' in patch) merged.taxCodeId = patch.taxCodeId;
  if ('sublocation' in patch) merged.sublocation = patch.sublocation;

  // quantity: patches can carry a new numeric quantity, new serialNumbers, or
  // both. The existing quantity may be a raw number or the object form; we
  // always write back the object form so serialNumbers has somewhere to live.
  const patchHasQuantity = 'quantity' in patch;
  const patchHasSerials = 'serialNumbers' in patch;
  if (patchHasQuantity || patchHasSerials) {
    const priorValue = existing.quantity;
    const priorObject =
      typeof priorValue === 'object' && priorValue !== null ? priorValue : undefined;
    const priorStandard = priorObject
      ? priorObject.standardQuantity
      : typeof priorValue === 'number'
        ? priorValue
        : 0;
    const priorUom = priorObject
      ? priorObject.uomQuantity
      : typeof priorValue === 'number'
        ? priorValue
        : 0;
    const priorSerials = priorObject?.serialNumbers;

    const newStandard = patchHasQuantity ? (patch.quantity as number) : priorStandard;
    const newUom = patchHasQuantity ? (patch.quantity as number) : priorUom;
    const newSerials = patchHasSerials ? patch.serialNumbers : priorSerials;

    merged.quantity = {
      ...(priorObject ?? {}),
      standardQuantity: newStandard,
      uomQuantity: newUom,
      serialNumbers: newSerials,
    };
  }

  return merged;
}

function buildNewSalesOrderLine(patch: SalesOrderItemPatch): SalesOrderLine {
  if (patch.quantity === undefined) {
    throw new Error(
      'New sales order lines must include quantity. Pass item.quantity when adding a line with no existing match.'
    );
  }

  return {
    salesOrderLineId: patch.id ?? randomUUID(),
    productId: patch.productId,
    description: patch.description,
    quantity: {
      standardQuantity: patch.quantity,
      uomQuantity: patch.quantity,
      serialNumbers: patch.serialNumbers,
    },
    unitPrice: patch.unitPrice,
    discount: patch.discount,
    discountType: patch.discountType,
    taxCodeId: patch.taxCodeId,
    sublocation: patch.sublocation,
  };
}

export function registerSalesOrderTools(server: McpServer, client: InflowClient): void {
  // List Sales Orders
  server.tool(
    'list_sales_orders',
    'Search and list sales orders with optional filtering',
    {
      orderNumber: z.string().optional().describe('Filter by order number'),
      customerId: z.string().optional().describe('Filter by customer ID'),
      status: z.union([
        orderStatusEnum,
        z.array(orderStatusEnum),
      ]).optional().describe('Filter by order status (single value or array)'),
      locationId: z.string().optional().describe('Filter by location ID'),
      orderDateFrom: z.string().optional().describe('Filter by order date (from) - ISO format'),
      orderDateTo: z.string().optional().describe('Filter by order date (to) - ISO format'),
      requiredDateFrom: z.string().optional().describe('Filter by required date (from)'),
      requiredDateTo: z.string().optional().describe('Filter by required date (to)'),
      totalFrom: z.number().optional().describe('Filter by minimum total'),
      totalTo: z.number().optional().describe('Filter by maximum total'),
      smart: z.string().optional().describe('Smart search across order fields'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., customer, lines, lines.product)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., orderDate, orderNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: SalesOrderFilter = {};
      if (args.orderNumber) filters.orderNumber = args.orderNumber;
      if (args.customerId) filters.customerId = args.customerId;
      if (args.status) filters.status = args.status;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.orderDateFrom) filters.orderDateFrom = args.orderDateFrom;
      if (args.orderDateTo) filters.orderDateTo = args.orderDateTo;
      if (args.requiredDateFrom) filters.requiredDateFrom = args.requiredDateFrom;
      if (args.requiredDateTo) filters.requiredDateTo = args.requiredDateTo;
      if (args.totalFrom !== undefined) filters.totalFrom = args.totalFrom;
      if (args.totalTo !== undefined) filters.totalTo = args.totalTo;
      if (args.smart) filters.smart = args.smart;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<SalesOrder>('/sales-orders', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: SalesOrder[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );

  // Get Sales Order
  server.tool(
    'get_sales_order',
    'Get detailed information about a specific sales order',
    {
      salesOrderId: z.string().describe('The sales order ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., customer, location, lines, lines.product)'),
    },
    async (args) => {
      const order = await client.get<SalesOrder>(`/sales-orders/${args.salesOrderId}`, {
        include: args.include,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(order, null, 2),
          },
        ],
      };
    }
  );

  // Create/Update Sales Order
  server.tool(
    'upsert_sales_order',
    'Create a new sales order or update an existing one. When `id` is provided, performs a partial update: unmentioned header fields and line items are preserved, item patches are merged into existing lines by id (or unambiguous productId), and lines listed in `deleteLineIds` are removed. Without `id`, creates a new order from the provided fields.',
    upsertSalesOrderToolSchema,
    async (args) => {
      // Update path: fetch current state, merge, PUT the full desired state.
      // This fixes the merge bug where incomplete line payloads caused
      // inFlow to strip nested fields like quantity.serialNumbers.
      if (args.id) {
        const existing = await client.get<SalesOrder>(`/sales-orders/${args.id}`, {
          include: ['lines'],
        });
        const mergedBody = mergeSalesOrderUpdate(existing, args as SalesOrderUpsertArgs);
        mergedBody.salesOrderId = args.id;

        const updateResult = await client.put<SalesOrder>('/sales-orders', mergedBody);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(updateResult, null, 2),
            },
          ],
        };
      }

      // Create path: build body from args alone. Quantity-required validation
      // now happens inside buildNewSalesOrderLine so callers get a clear error
      // rather than inFlow silently producing a zero-quantity line.
      if (!args.customerId) {
        throw new Error(
          'Creating a sales order requires customerId. Pass id to update an existing sales order instead.'
        );
      }

      const newSalesOrderId = randomUUID();
      const createLines: SalesOrderLine[] = (args.items ?? []).map(buildNewSalesOrderLine);

      const createBody: SalesOrder & { nonCustomerCost?: number } = {
        salesOrderId: newSalesOrderId,
        orderNumber: args.orderNumber,
        orderDate: args.orderDate,
        requiredDate: args.requiredDate,
        customerId: args.customerId,
        locationId: args.locationId,
        billingAddress: args.billingAddress as Address | undefined,
        shippingAddress: args.shippingAddress as Address | undefined,
        pricingSchemeId: args.pricingSchemeId,
        taxingSchemeId: args.taxingSchemeId,
        paymentTermsId: args.paymentTermsId,
        currencyCode: args.currencyCode,
        lines: createLines,
        orderRemarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };
      if (args.nonCustomerCost !== undefined) createBody.nonCustomerCost = args.nonCustomerCost;

      const createResult = await client.put<SalesOrder>('/sales-orders', createBody);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(createResult, null, 2),
          },
        ],
      };
    }
  );
}
