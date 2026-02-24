// Product tools for inFlow MCP Server

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  Product,
  ProductSummary,
  ProductFilter,
  PaginationParams,
  Category,
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
      categoryName: z.string().optional().describe('Filter by category name (case-insensitive, resolves to categoryId)'),
      isActive: z.boolean().optional().describe('Filter by active status'),
      smart: z.string().optional().describe('Smart search across multiple fields (name, description, SKU, barcode)'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include. Options: category, customFields, inventoryLines (serial numbers). Use filter trackSerials=true to get only serialized products.'),
      trackSerials: z.boolean().optional().describe('Filter to only return products that track serial numbers (serial numbers)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., name, sku, modifiedDate)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      // Resolve categoryName to categoryId if provided
      let resolvedCategoryId = args.categoryId;
      if (args.categoryName && !args.categoryId) {
        const categories = await client.getList<Category>('/categories', {
          pagination: { count: 100 }
        });
        const match = categories.data.find((c: Category) =>
          c.name?.toLowerCase() === args.categoryName?.toLowerCase()
        );
        if (match?.categoryId) {
          resolvedCategoryId = match.categoryId;
        } else {
          throw new Error(`Category not found: ${args.categoryName}`);
        }
      }

      const filters: ProductFilter = {};
      if (args.name) filters.name = args.name;
      if (args.description) filters.description = args.description;
      if (args.barcode) filters.barcode = args.barcode;
      if (args.sku) filters.sku = args.sku;
      if (resolvedCategoryId) filters.categoryId = resolvedCategoryId;
      if (args.isActive !== undefined) filters.isActive = args.isActive;
      if (args.smart) filters.smart = args.smart;
      if (args.trackSerials !== undefined) filters.trackSerials = args.trackSerials;

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
    'Get detailed information about a specific product by ID. Use include=itemBoms to get the bill of materials (components needed to manufacture this product).',
    {
      productId: z.string().describe('The product ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include. Options: category, customFields, itemBoms (bill of materials), inventoryLines (serial numbers/serial numbers for trackSerials products)'),
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
      // API expects 'productId' not 'id' - use entity-specific field name
      const productPayload = {
        productId: args.id || randomUUID(),
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

      const result = await client.put<Product>('/products', productPayload);

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

  // Get Bill of Materials
  server.tool(
    'get_bill_of_materials',
    'Get the bill of materials (BOM) for a manufacturable product. Returns the list of component products and quantities required to manufacture this product. Only products with isManufacturable=true have a BOM.',
    {
      productId: z.string().describe('The product ID to get the BOM for'),
    },
    async (args) => {
      const product = await client.get<Product>(`/products/${args.productId}`, {
        include: ['itemBoms'],
      });

      if (!product.isManufacturable) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                productId: args.productId,
                productName: product.name,
                isManufacturable: false,
                message: 'This product is not manufacturable and has no bill of materials.',
                itemBoms: [],
              }, null, 2),
            },
          ],
        };
      }

      // If we have BOMs, fetch the child product names
      const itemBoms = product.itemBoms || [];
      const childProductIds = itemBoms
        .map((bom) => bom.childProductId)
        .filter((id): id is string => !!id);

      // Fetch child product details if we have any
      let childProducts: Record<string, Product> = {};
      if (childProductIds.length > 0) {
        // Fetch each child product to get names
        const childProductPromises = childProductIds.map((id) =>
          client.get<Product>(`/products/${id}`).catch(() => null)
        );
        const results = await Promise.all(childProductPromises);
        results.forEach((p) => {
          if (p) {
            if (p.productId) {
              childProducts[p.productId] = p;
            }
          }
        });
      }

      // Build enriched BOM response
      const enrichedBoms = itemBoms.map((bom) => ({
        childProductId: bom.childProductId,
        childProductName: bom.childProductId ? childProducts[bom.childProductId]?.name : undefined,
        childProductSku: bom.childProductId ? childProducts[bom.childProductId]?.sku : undefined,
        quantity: bom.quantity?.standardQuantity || '1',
        uom: bom.quantity?.uom || '',
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              productId: args.productId,
              productName: product.name,
              productSku: product.sku,
              isManufacturable: true,
              componentCount: enrichedBoms.length,
              components: enrichedBoms,
            }, null, 2),
          },
        ],
      };
    }
  );
}
