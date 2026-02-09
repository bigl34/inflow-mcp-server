// Sales Order tools for inFlow MCP Server

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  SalesOrder,
  SalesOrderItem,
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
  quantity: z.number(),
  unitPrice: z.number().optional(),
  discount: z.number().optional(),
  discountType: z.enum(['Percent', 'Amount']).optional(),
  taxCodeId: z.string().optional(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const orderStatusEnum = z.enum(['Open', 'PartiallyFulfilled', 'Fulfilled', 'Cancelled', 'Closed']);

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
        .describe('Related data to include (e.g., customer, items, items.product)'),
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
        .describe('Related data to include (e.g., customer, location, items, items.product)'),
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
    'Create a new sales order or update an existing one',
    {
      id: z.string().optional().describe('Sales order ID (required for updates)'),
      orderNumber: z.string().optional().describe('Order number'),
      orderDate: z.string().optional().describe('Order date (ISO format)'),
      requiredDate: z.string().optional().describe('Required/ship date (ISO format)'),
      customerId: z.string().describe('Customer ID'),
      locationId: z.string().optional().describe('Location/warehouse ID'),
      billingAddress: addressSchema.optional().describe('Billing address'),
      shippingAddress: addressSchema.optional().describe('Shipping address'),
      pricingSchemeId: z.string().optional().describe('Pricing scheme ID'),
      taxingSchemeId: z.string().optional().describe('Taxing scheme ID'),
      paymentTermsId: z.string().optional().describe('Payment terms ID'),
      currencyCode: z.string().optional().describe('Currency code (e.g., USD)'),
      items: z.array(salesOrderItemSchema).optional().describe('Order line items'),
      remarks: z.string().optional().describe('Order remarks/notes'),
      customFields: z.record(z.unknown()).optional().describe('Custom field values'),
      timestamp: z.string().optional().describe('Timestamp for concurrency control'),
    },
    async (args) => {
      const order: SalesOrder = {
        id: args.id,
        orderNumber: args.orderNumber,
        orderDate: args.orderDate,
        requiredDate: args.requiredDate,
        customerId: args.customerId,
        locationId: args.locationId,
        billingAddress: args.billingAddress as Address,
        shippingAddress: args.shippingAddress as Address,
        pricingSchemeId: args.pricingSchemeId,
        taxingSchemeId: args.taxingSchemeId,
        paymentTermsId: args.paymentTermsId,
        currencyCode: args.currencyCode,
        items: args.items as SalesOrderItem[],
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<SalesOrder>('/sales-orders', order);

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
