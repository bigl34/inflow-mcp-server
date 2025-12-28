// Purchase Order tools for inFlow MCP Server

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderFilter,
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

const purchaseOrderItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number(),
  unitCost: z.number().optional(),
  taxCodeId: z.string().optional(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const poStatusEnum = z.enum(['Open', 'PartiallyReceived', 'Received', 'Cancelled', 'Closed']);

export function registerPurchaseOrderTools(server: McpServer, client: InflowClient): void {
  // List Purchase Orders
  server.tool(
    'list_purchase_orders',
    'Search and list purchase orders with optional filtering',
    {
      orderNumber: z.string().optional().describe('Filter by order number'),
      vendorId: z.string().optional().describe('Filter by vendor ID'),
      status: z.union([
        poStatusEnum,
        z.array(poStatusEnum),
      ]).optional().describe('Filter by order status (single value or array)'),
      locationId: z.string().optional().describe('Filter by destination location ID'),
      orderDateFrom: z.string().optional().describe('Filter by order date (from) - ISO format'),
      orderDateTo: z.string().optional().describe('Filter by order date (to) - ISO format'),
      expectedDateFrom: z.string().optional().describe('Filter by expected date (from)'),
      expectedDateTo: z.string().optional().describe('Filter by expected date (to)'),
      smart: z.string().optional().describe('Smart search across order fields'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., vendor, items, items.product)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., orderDate, orderNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: PurchaseOrderFilter = {};
      if (args.orderNumber) filters.orderNumber = args.orderNumber;
      if (args.vendorId) filters.vendorId = args.vendorId;
      if (args.status) filters.status = args.status;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.orderDateFrom) filters.orderDateFrom = args.orderDateFrom;
      if (args.orderDateTo) filters.orderDateTo = args.orderDateTo;
      if (args.expectedDateFrom) filters.expectedDateFrom = args.expectedDateFrom;
      if (args.expectedDateTo) filters.expectedDateTo = args.expectedDateTo;
      if (args.smart) filters.smart = args.smart;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<PurchaseOrder>('/purchase-orders', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: PurchaseOrder[]; totalCount?: number } = { data: result.data };
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

  // Get Purchase Order
  server.tool(
    'get_purchase_order',
    'Get detailed information about a specific purchase order',
    {
      purchaseOrderId: z.string().describe('The purchase order ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., vendor, location, items, items.product)'),
    },
    async (args) => {
      const order = await client.get<PurchaseOrder>(
        `/purchase-orders/${args.purchaseOrderId}`,
        { include: args.include }
      );

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

  // Create/Update Purchase Order
  server.tool(
    'upsert_purchase_order',
    'Create a new purchase order or update an existing one',
    {
      id: z.string().optional().describe('Purchase order ID (required for updates)'),
      orderNumber: z.string().optional().describe('Order number'),
      orderDate: z.string().optional().describe('Order date (ISO format)'),
      expectedDate: z.string().optional().describe('Expected delivery date (ISO format)'),
      vendorId: z.string().describe('Vendor ID'),
      locationId: z.string().optional().describe('Destination location/warehouse ID'),
      shippingAddress: addressSchema.optional().describe('Shipping address'),
      currencyCode: z.string().optional().describe('Currency code (e.g., USD)'),
      items: z.array(purchaseOrderItemSchema).optional().describe('Order line items'),
      remarks: z.string().optional().describe('Order remarks/notes'),
      customFields: z.record(z.unknown()).optional().describe('Custom field values'),
      timestamp: z.string().optional().describe('Timestamp for concurrency control'),
    },
    async (args) => {
      const order: PurchaseOrder = {
        id: args.id,
        orderNumber: args.orderNumber,
        orderDate: args.orderDate,
        expectedDate: args.expectedDate,
        vendorId: args.vendorId,
        locationId: args.locationId,
        shippingAddress: args.shippingAddress as Address,
        currencyCode: args.currencyCode,
        items: args.items as PurchaseOrderItem[],
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<PurchaseOrder>('/purchase-orders', order);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
