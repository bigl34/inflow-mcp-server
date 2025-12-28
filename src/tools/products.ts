// Product tools for inFlow MCP Server

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  Product,
  ProductSummary,
  ProductFilter,
  PaginationParams,
} from '../types/inflow.js';

export function registerProductTools(server: McpServer, client: InflowClient): void {
  // List Products
  server.tool(
    'list_products',
    'Search and list products from inFlow Inventory with optional filtering',
    {
      name: z.string().optional().describe('Filter by product name (partial match)'),
      description: z.string().optional().describe('Filter by description'),
      barcode: z.string().optional().describe('Filter by barcode'),
      sku: z.string().optional().describe('Filter by SKU'),
      categoryId: z.string().optional().describe('Filter by category ID'),
      isActive: z.boolean().optional().describe('Filter by active status'),
      smart: z.string().optional().describe('Smart search across multiple fields (name, description, SKU, barcode)'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., category, customFields)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., name, sku, modifiedDate)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: ProductFilter = {};
      if (args.name) filters.name = args.name;
      if (args.description) filters.description = args.description;
      if (args.barcode) filters.barcode = args.barcode;
      if (args.sku) filters.sku = args.sku;
      if (args.categoryId) filters.categoryId = args.categoryId;
      if (args.isActive !== undefined) filters.isActive = args.isActive;
      if (args.smart) filters.smart = args.smart;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Product>('/products', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Product[]; totalCount?: number } = { data: result.data };
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

  // Get Product
  server.tool(
    'get_product',
    'Get detailed information about a specific product by ID',
    {
      productId: z.string().describe('The product ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., category, customFields)'),
    },
    async (args) => {
      const product = await client.get<Product>(`/products/${args.productId}`, {
        include: args.include,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(product, null, 2),
          },
        ],
      };
    }
  );

  // Create/Update Product
  server.tool(
    'upsert_product',
    'Create a new product or update an existing one. Include ID to update.',
    {
      id: z.string().optional().describe('Product ID (required for updates)'),
      name: z.string().describe('Product name'),
      description: z.string().optional().describe('Product description'),
      barcode: z.string().optional().describe('Product barcode'),
      sku: z.string().optional().describe('Product SKU'),
      categoryId: z.string().optional().describe('Category ID'),
      isActive: z.boolean().optional().describe('Whether product is active'),
      cost: z.number().optional().describe('Product cost'),
      defaultPrice: z.number().optional().describe('Default selling price'),
      reorderPoint: z.number().optional().describe('Reorder point quantity'),
      reorderQuantity: z.number().optional().describe('Quantity to reorder'),
      weight: z.number().optional().describe('Product weight'),
      weightUnit: z.string().optional().describe('Weight unit (e.g., kg, lb)'),
      customFields: z
        .record(z.unknown())
        .optional()
        .describe('Custom field values'),
      timestamp: z
        .string()
        .optional()
        .describe('Timestamp for concurrency control (required for updates)'),
    },
    async (args) => {
      const product: Product = {
        id: args.id,
        name: args.name,
        description: args.description,
        barcode: args.barcode,
        sku: args.sku,
        categoryId: args.categoryId,
        isActive: args.isActive,
        cost: args.cost,
        defaultPrice: args.defaultPrice,
        reorderPoint: args.reorderPoint,
        reorderQuantity: args.reorderQuantity,
        weight: args.weight,
        weightUnit: args.weightUnit,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      const result = await client.put<Product>('/products', product);

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

  // Get Inventory Summary
  server.tool(
    'get_inventory_summary',
    'Get inventory quantities for a product across all locations',
    {
      productId: z.string().describe('The product ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., locationSummaries, sublocationSummaries)'),
    },
    async (args) => {
      const summary = await client.get<ProductSummary>(
        `/products/${args.productId}/summary`,
        { include: args.include }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );

  // Batch Inventory Summary
  server.tool(
    'get_inventory_summaries_batch',
    'Get inventory summaries for multiple products at once (max 100)',
    {
      productIds: z
        .array(z.string())
        .max(100)
        .describe('Array of product IDs (max 100)'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include'),
    },
    async (args) => {
      const summaries = await client.post<ProductSummary[]>(
        '/products/summary',
        { productIds: args.productIds },
        { params: args.include ? { include: args.include.join(',') } : undefined }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summaries, null, 2),
          },
        ],
      };
    }
  );
}
