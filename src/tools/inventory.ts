// Inventory operation tools for inFlow MCP Server
// Includes: Stock Adjustments, Stock Transfers, Stock Counts, Manufacturing Orders

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  StockAdjustment,
  StockAdjustmentItem,
  StockAdjustmentFilter,
  StockTransfer,
  StockTransferItem,
  StockTransferFilter,
  StockCount,
  ManufacturingOrder,
  ManufacturingOrderLine,
  ManufacturingOrderFilter,
  PaginationParams,
} from '../types/inflow.js';

const stockAdjustmentItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string(),
  quantity: z.number(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
  unitCost: z.number().optional(),
});

const stockTransferItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string(),
  quantity: z.number(),
  fromSublocation: z.string().optional(),
  toSublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const manufacturingInputItemSchema = z.object({
  productId: z.string(),
  quantity: z.number(),
  sublocation: z.string().optional(),
});

function buildManufacturingOrderLines(
  outputProductId: string,
  outputQuantity: number,
  inputItems?: Array<{ productId: string; quantity: number; sublocation?: string }>
): ManufacturingOrderLine[] {
  const childLines: ManufacturingOrderLine[] = (inputItems || []).map(item => ({
    manufacturingOrderLineId: randomUUID(),
    productId: item.productId,
    quantity: {
      standardQuantity: String(item.quantity),
      uomQuantity: String(item.quantity),
    },
  }));

  return [{
    manufacturingOrderLineId: randomUUID(),
    productId: outputProductId,
    parentManufacturingOrderLineId: null,
    quantity: {
      standardQuantity: String(outputQuantity),
      uomQuantity: String(outputQuantity),
    },
    manufacturingOrderLines: childLines,
  }];
}

export function registerInventoryTools(server: McpServer, client: InflowClient): void {
  // ==================== STOCK ADJUSTMENTS ====================

  // List Stock Adjustments
  server.tool(
    'list_stock_adjustments',
    'Search and list stock adjustments with optional filtering',
    {
      adjustmentNumber: z.string().optional().describe('Filter by adjustment number'),
      locationId: z.string().optional().describe('Filter by location ID'),
      reasonId: z.string().optional().describe('Filter by adjustment reason ID'),
      status: z
        .enum(['Open', 'Completed', 'Cancelled'])
        .optional()
        .describe('Filter by status'),
      adjustmentDateFrom: z.string().optional().describe('Filter by date (from)'),
      adjustmentDateTo: z.string().optional().describe('Filter by date (to)'),
      include: z.array(z.string()).optional().describe('Related data to include'),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., adjustmentDate, adjustmentNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: StockAdjustmentFilter = {};
      if (args.adjustmentNumber) filters.adjustmentNumber = args.adjustmentNumber;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.reasonId) filters.adjustmentReasonId = args.reasonId;
      if (args.status) filters.status = args.status;
      if (args.adjustmentDateFrom) filters.adjustmentDateFrom = args.adjustmentDateFrom;
      if (args.adjustmentDateTo) filters.adjustmentDateTo = args.adjustmentDateTo;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<StockAdjustment>('/stock-adjustments', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: StockAdjustment[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Stock Adjustment
  server.tool(
    'get_stock_adjustment',
    'Get details of a specific stock adjustment',
    {
      adjustmentId: z.string().describe('The stock adjustment ID'),
      include: z.array(z.string()).optional(),
    },
    async (args) => {
      const adjustment = await client.get<StockAdjustment>(
        `/stock-adjustments/${args.adjustmentId}`,
        { include: args.include }
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(adjustment, null, 2) }],
      };
    }
  );

  // Create/Update Stock Adjustment
  server.tool(
    'upsert_stock_adjustment',
    'Create or update a stock adjustment to add or remove inventory',
    {
      id: z.string().optional().describe('Adjustment ID (required for updates)'),
      adjustmentDate: z.string().optional().describe('Adjustment date (ISO format)'),
      locationId: z.string().describe('Location ID where adjustment occurs'),
      reasonId: z.string().optional().describe('Adjustment reason ID'),
      items: z.array(stockAdjustmentItemSchema).describe('Items to adjust'),
      remarks: z.string().optional().describe('Notes/remarks'),
      customFields: z.record(z.unknown()).optional(),
      timestamp: z.string().optional(),
    },
    async (args) => {
      // inFlow API requires stockAdjustmentId for both create and update
      // Generate a new UUID if not provided (for creates)
      const stockAdjustmentId = args.id || randomUUID();

      const adjustment: StockAdjustment = {
        stockAdjustmentId: stockAdjustmentId,
        date: args.adjustmentDate,
        locationId: args.locationId,
        adjustmentReasonId: args.reasonId,
        items: args.items as StockAdjustmentItem[],
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<StockAdjustment>('/stock-adjustments', adjustment);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ==================== STOCK TRANSFERS ====================

  // List Stock Transfers
  server.tool(
    'list_stock_transfers',
    'Search and list stock transfers between locations',
    {
      transferNumber: z.string().optional().describe('Filter by transfer number'),
      fromLocationId: z.string().optional().describe('Filter by source location'),
      toLocationId: z.string().optional().describe('Filter by destination location'),
      status: z
        .enum(['Open', 'InTransit', 'Completed', 'Cancelled'])
        .optional()
        .describe('Filter by status'),
      transferDateFrom: z.string().optional(),
      transferDateTo: z.string().optional(),
      include: z.array(z.string()).optional(),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., transferDate, transferNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: StockTransferFilter = {};
      if (args.transferNumber) filters.transferNumber = args.transferNumber;
      if (args.fromLocationId) filters.fromLocationId = args.fromLocationId;
      if (args.toLocationId) filters.toLocationId = args.toLocationId;
      if (args.status) filters.status = args.status;
      if (args.transferDateFrom) filters.transferDateFrom = args.transferDateFrom;
      if (args.transferDateTo) filters.transferDateTo = args.transferDateTo;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<StockTransfer>('/stock-transfers', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: StockTransfer[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Stock Transfer
  server.tool(
    'get_stock_transfer',
    'Get details of a specific stock transfer',
    {
      transferId: z.string().describe('The stock transfer ID'),
      include: z.array(z.string()).optional(),
    },
    async (args) => {
      const transfer = await client.get<StockTransfer>(
        `/stock-transfers/${args.transferId}`,
        { include: args.include }
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(transfer, null, 2) }],
      };
    }
  );

  // Create/Update Stock Transfer
  server.tool(
    'upsert_stock_transfer',
    'Create or update a stock transfer between locations',
    {
      id: z.string().optional().describe('Transfer ID (required for updates)'),
      transferDate: z.string().optional().describe('Transfer date (ISO format)'),
      fromLocationId: z.string().describe('Source location ID'),
      toLocationId: z.string().describe('Destination location ID'),
      items: z.array(stockTransferItemSchema).describe('Items to transfer'),
      remarks: z.string().optional().describe('Notes/remarks'),
      customFields: z.record(z.unknown()).optional(),
      timestamp: z.string().optional(),
    },
    async (args) => {
      // inFlow API requires stockTransferId for both create and update
      // Generate a new UUID if not provided (for creates)
      const stockTransferId = args.id || randomUUID();

      const transfer: StockTransfer = {
        stockTransferId: stockTransferId,
        transferDate: args.transferDate,
        fromLocationId: args.fromLocationId,
        toLocationId: args.toLocationId,
        items: args.items as StockTransferItem[],
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<StockTransfer>('/stock-transfers', transfer);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ==================== STOCK COUNTS ====================

  // List Stock Counts
  server.tool(
    'list_stock_counts',
    'List stock count/inventory count records',
    {
      locationId: z.string().optional().describe('Filter by location ID'),
      status: z
        .enum(['Open', 'InProgress', 'Completed', 'Cancelled'])
        .optional(),
      include: z.array(z.string()).optional(),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., countDate)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: Record<string, string | boolean | number> = {};
      if (args.locationId) filters.locationId = args.locationId;
      if (args.status) filters.status = args.status;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<StockCount>('/stock-counts', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: StockCount[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Stock Count
  server.tool(
    'get_stock_count',
    'Get details of a specific stock count',
    {
      stockCountId: z.string().describe('The stock count ID'),
      include: z.array(z.string()).optional(),
    },
    async (args) => {
      const stockCount = await client.get<StockCount>(
        `/stock-counts/${args.stockCountId}`,
        { include: args.include }
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(stockCount, null, 2) }],
      };
    }
  );

  // Create/Update Stock Count
  server.tool(
    'upsert_stock_count',
    'Create or update a stock count for inventory counting',
    {
      id: z.string().optional().describe('Stock count ID (required for updates)'),
      countDate: z.string().optional().describe('Count date (ISO format)'),
      locationId: z.string().describe('Location ID'),
      remarks: z.string().optional(),
      timestamp: z.string().optional(),
    },
    async (args) => {
      // inFlow API requires stockCountId for both create and update
      // Generate a new UUID if not provided (for creates)
      const stockCountId = args.id || randomUUID();

      const stockCount: StockCount = {
        stockCountId: stockCountId,
        countDate: args.countDate,
        locationId: args.locationId,
        remarks: args.remarks,
        timestamp: args.timestamp,
      };

      const result = await client.put<StockCount>('/stock-counts', stockCount);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ==================== MANUFACTURING ORDERS ====================

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
    'Create or update a manufacturing/work order',
    {
      id: z.string().optional().describe('Order ID (required for updates)'),
      orderDate: z.string().optional().describe('Order date (ISO format)'),
      requiredDate: z.string().optional().describe('Required completion date'),
      locationId: z.string().describe('Location ID'),
      outputProductId: z.string().describe('Product ID being manufactured'),
      outputQuantity: z.number().describe('Quantity to manufacture'),
      inputItems: z
        .array(manufacturingInputItemSchema)
        .optional()
        .describe('Input/component items'),
      remarks: z.string().optional(),
      customFields: z.record(z.unknown()).optional(),
      timestamp: z.string().optional(),
    },
    async (args) => {
      // inFlow API requires manufacturingOrderId for both create and update
      // Generate a new UUID if not provided (for creates)
      const manufacturingOrderId = args.id || randomUUID();

      const order: ManufacturingOrder = {
        manufacturingOrderId: manufacturingOrderId,
        orderDate: args.orderDate,
        dueDate: args.requiredDate,
        locationId: args.locationId,
        primaryFinishedProductId: args.outputProductId,
        lines: buildManufacturingOrderLines(
          args.outputProductId, args.outputQuantity, args.inputItems
        ),
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<ManufacturingOrder>('/manufacturing-orders', order);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
