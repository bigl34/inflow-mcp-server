// Serial Number (serial number) tools for inFlow MCP Server
//
// Two approaches for serial number retrieval:
// 1. Order-based: Use `include=lines` on sales/purchase orders to get serial numbers assigned to orders
// 2. Product-based: Use `include=inventoryLines` on products to get all serial numbers for a product
//
// Product-based is faster and more complete (gets ALL serials, not just sold ones).
// Order-based is needed when you need serial→Order mapping.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { SalesOrder, PurchaseOrder, PaginationParams, Product } from '../types/inflow.js';

interface SerialEntry {
  serial: string;
  orderType: 'sales' | 'purchase';
  orderId: string;
  orderNumber: string;
  orderDate: string;
  productId: string;
  lineId: string;
}

interface ProductSerialEntry {
  serial: string;
  productId: string;
  productName: string;
  locationId: string;
  quantityOnHand: string;
  sublocation: string;
  inStock: boolean;  // true if quantityOnHand > 0
}

export function registerSerialTools(server: McpServer, client: InflowClient): void {
  // Get serial numbers from Sales Order
  server.tool(
    'get_sales_order_serials',
    'Extract serial numbers (serial numbers) from a specific sales order. Returns all serial numbers assigned to line items on this order.',
    {
      salesOrderId: z.string().describe('The sales order ID'),
    },
    async (args) => {
      const order = await client.get<SalesOrder>(
        `/sales-orders/${args.salesOrderId}`,
        { include: ['lines'] }
      );

      const serials: SerialEntry[] = [];
      for (const line of order.lines || []) {
        const qty = line.quantity;
        const serialNumbers = typeof qty === 'object' && qty !== null
          ? (qty.serialNumbers || [])
          : [];
        for (const serial of serialNumbers) {
          serials.push({
            serial: serial,
            orderType: 'sales',
            orderId: order.salesOrderId || '',
            orderNumber: order.orderNumber || '',
            orderDate: order.orderDate || '',
            productId: line.productId || '',
            lineId: line.salesOrderLineId || '',
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                salesOrderId: order.salesOrderId,
                orderNumber: order.orderNumber,
                orderDate: order.orderDate,
                status: order.inventoryStatus,
                serialCount: serials.length,
                serials,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Get serial numbers from Purchase Order
  server.tool(
    'get_purchase_order_serials',
    'Extract serial numbers (serial numbers) from a specific purchase order. Returns all serial numbers assigned to line items on this order.',
    {
      purchaseOrderId: z.string().describe('The purchase order ID'),
    },
    async (args) => {
      const order = await client.get<PurchaseOrder>(
        `/purchase-orders/${args.purchaseOrderId}`,
        { include: ['lines'] }
      );

      const serials: SerialEntry[] = [];
      for (const line of order.lines || []) {
        const qty = line.quantity;
        const serialNumbers = typeof qty === 'object' && qty !== null
          ? (qty.serialNumbers || [])
          : [];
        for (const serial of serialNumbers) {
          serials.push({
            serial: serial,
            orderType: 'purchase',
            orderId: order.purchaseOrderId || '',
            orderNumber: order.orderNumber || '',
            orderDate: order.orderDate || '',
            productId: line.productId || '',
            lineId: line.purchaseOrderLineId || '',
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                purchaseOrderId: order.purchaseOrderId,
                orderNumber: order.orderNumber,
                orderDate: order.orderDate,
                status: order.inventoryStatus,
                serialCount: serials.length,
                serials,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Search serial number across orders
  server.tool(
    'search_serial_number',
    'Search for a serial number/serial number across fulfilled sales orders. Returns the order details if found. WARNING: This searches by fetching orders - may be slow for large order volumes.',
    {
      serialNumber: z.string().describe('The serial number to search for'),
      maxOrders: z
        .number()
        .optional()
        .describe('Maximum number of orders to search (default: 500, max: 2000)'),
    },
    async (args) => {
      const searchSerial = args.serialNumber.trim().toUpperCase();
      const maxOrders = Math.min(args.maxOrders || 500, 2000);
      let skip = 0;
      const pageSize = 100;
      let ordersSearched = 0;

      while (ordersSearched < maxOrders) {
        const result = await client.getList<SalesOrder>('/sales-orders', {
          filters: { status: 'Fulfilled' },
          pagination: { skip, count: pageSize } as PaginationParams,
          include: ['lines'],
        });

        for (const order of result.data) {
          ordersSearched++;
          for (const line of order.lines || []) {
            const qty = line.quantity;
            const serialNumbers = typeof qty === 'object' && qty !== null
              ? (qty.serialNumbers || [])
              : [];
            for (const serial of serialNumbers) {
              if (serial.trim().toUpperCase() === searchSerial) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          found: true,
                          serial: searchSerial,
                          salesOrderId: order.salesOrderId,
                          orderNumber: order.orderNumber,
                          orderDate: order.orderDate,
                          productId: line.productId,
                          lineId: line.salesOrderLineId,
                          orderUrl: order.customFields?.custom4 || null,  // custom4 = external order URL (configure per account)
                          ordersSearched,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }
            }
          }
        }

        if (result.data.length < pageSize) break;
        skip += pageSize;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                found: false,
                serial: searchSerial,
                ordersSearched,
                message:
                  'Serial number not found in fulfilled sales orders. Check your authoritative product database for serial number data.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // List all serial numbers from fulfilled orders
  server.tool(
    'list_serial_numbers',
    'List all serial numbers (serial numbers) from fulfilled sales orders. Useful for building a serial number inventory. WARNING: This fetches all orders and may be slow.',
    {
      maxOrders: z
        .number()
        .optional()
        .describe('Maximum number of orders to fetch (default: 200, max: 1000)'),
      productId: z.string().optional().describe('Filter by product ID'),
    },
    async (args) => {
      const maxOrders = Math.min(args.maxOrders || 200, 1000);
      let skip = 0;
      const pageSize = 100;
      let ordersFetched = 0;
      const allSerials: SerialEntry[] = [];

      while (ordersFetched < maxOrders) {
        const result = await client.getList<SalesOrder>('/sales-orders', {
          filters: { status: 'Fulfilled' },
          pagination: { skip, count: pageSize } as PaginationParams,
          include: ['lines'],
          sortDesc: true,
          sort: 'orderDate',
        });

        for (const order of result.data) {
          ordersFetched++;
          for (const line of order.lines || []) {
            // Filter by product if specified
            if (args.productId && line.productId !== args.productId) continue;

            const qty = line.quantity;
            const serialNumbers = typeof qty === 'object' && qty !== null
              ? (qty.serialNumbers || [])
              : [];
            for (const serial of serialNumbers) {
              allSerials.push({
                serial: serial,
                orderType: 'sales',
                orderId: order.salesOrderId || '',
                orderNumber: order.orderNumber || '',
                orderDate: order.orderDate || '',
                productId: line.productId || '',
                lineId: line.salesOrderLineId || '',
              });
            }
          }
        }

        if (result.data.length < pageSize) break;
        skip += pageSize;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalSerials: allSerials.length,
                ordersFetched,
                productIdFilter: args.productId || null,
                serials: allSerials,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ============================================================================
  // PRODUCT-BASED SERIAL TOOLS (faster, more complete)
  // ============================================================================

  // Get serials from a specific product
  server.tool(
    'get_product_serials',
    'Get all serial numbers (serial numbers) for a specific product using inventoryLines. Much faster than order-based lookup. Returns serials with stock status (quantityOnHand=0 means sold/shipped).',
    {
      productId: z.string().describe('The product ID'),
    },
    async (args) => {
      const product = await client.get<Product>(
        `/products/${args.productId}`,
        { include: ['inventoryLines'] }
      );

      const inventoryLines = product.inventoryLines || [];
      const serials: ProductSerialEntry[] = inventoryLines
        .filter((line) => line.serial)
        .map((line) => ({
          serial: line.serial || '',
          productId: product.productId || '',
          productName: product.name || '',
          locationId: line.locationId || '',
          quantityOnHand: line.quantityOnHand || '0',
          sublocation: line.sublocation || '',
          inStock: parseFloat(line.quantityOnHand || '0') > 0,
        }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                productId: product.productId,
                productName: product.name,
                trackSerials: product.trackSerials,
                serialCount: serials.length,
                inStockCount: serials.filter((s) => s.inStock).length,
                soldCount: serials.filter((s) => !s.inStock).length,
                serials,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // List all serials across all serialized products
  server.tool(
    'list_all_serials',
    'List all serial numbers (serial numbers) across ALL products that track serials. Uses inventoryLines for fast retrieval. Much faster than order-based aggregation.',
    {
      maxProducts: z
        .number()
        .optional()
        .describe('Maximum number of products to fetch (default: 100, max: 500)'),
      inStockOnly: z
        .boolean()
        .optional()
        .describe('Only return serials that are still in stock (quantityOnHand > 0)'),
    },
    async (args) => {
      const maxProducts = Math.min(args.maxProducts || 100, 500);
      let skip = 0;
      const pageSize = 100;
      const allSerials: ProductSerialEntry[] = [];
      let productsFetched = 0;

      while (productsFetched < maxProducts) {
        const result = await client.getList<Product>('/products', {
          filters: { trackSerials: true },
          pagination: { skip, count: Math.min(pageSize, maxProducts - productsFetched) } as PaginationParams,
          include: ['inventoryLines'],
        });

        for (const product of result.data) {
          productsFetched++;
          const inventoryLines = product.inventoryLines || [];

          for (const line of inventoryLines) {
            if (!line.serial) continue;

            const inStock = parseFloat(line.quantityOnHand || '0') > 0;

            // Skip if filtering for in-stock only
            if (args.inStockOnly && !inStock) continue;

            allSerials.push({
              serial: line.serial,
              productId: product.productId || '',
              productName: product.name || '',
              locationId: line.locationId || '',
              quantityOnHand: line.quantityOnHand || '0',
              sublocation: line.sublocation || '',
              inStock,
            });
          }
        }

        if (result.data.length < pageSize) break;
        skip += pageSize;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                totalSerials: allSerials.length,
                inStockCount: allSerials.filter((s) => s.inStock).length,
                soldCount: allSerials.filter((s) => !s.inStock).length,
                productsFetched,
                inStockOnlyFilter: args.inStockOnly || false,
                serials: allSerials,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
