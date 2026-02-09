// Reference data tools for inFlow MCP Server
// Includes: Locations, Categories, Pricing Schemes, Payment Terms, Currencies, Tax Codes, etc.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  Location,
  Category,
  PricingScheme,
  PaymentTerms,
  TaxingScheme,
  TaxCode,
  Currency,
  CustomFieldDefinition,
  AdjustmentReason,
  TeamMember,
  Webhook,
  PaginationParams,
} from '../types/inflow.js';

export function registerReferenceTools(server: McpServer, client: InflowClient): void {
  // ==================== LOCATIONS ====================

  // List Locations
  server.tool(
    'list_locations',
    'List all warehouse/inventory locations',
    {
      include: z.array(z.string()).optional().describe('Related data to include'),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Location>('/locations', {
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Location[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Location
  server.tool(
    'get_location',
    'Get details of a specific location',
    {
      locationId: z.string().describe('The location ID'),
      include: z.array(z.string()).optional(),
    },
    async (args) => {
      const location = await client.get<Location>(`/locations/${args.locationId}`, {
        include: args.include,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(location, null, 2) }],
      };
    }
  );

  // Get Suggested Sublocations
  server.tool(
    'get_suggested_sublocations',
    'Get suggested sublocations (bins/shelves) for a location',
    {
      locationId: z.string().describe('The location ID'),
    },
    async (args) => {
      const suggestions = await client.get<string[]>(
        `/locations/${args.locationId}/suggested-sublocations`
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(suggestions, null, 2) }],
      };
    }
  );

  // ==================== CATEGORIES ====================

  // List Categories
  server.tool(
    'list_categories',
    'List all product categories',
    {
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., parentCategory, subCategories)'),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Category>('/categories', {
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Category[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== PRICING SCHEMES ====================

  // List Pricing Schemes
  server.tool(
    'list_pricing_schemes',
    'List all pricing schemes/price levels',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<PricingScheme>('/pricing-schemes', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: PricingScheme[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== PAYMENT TERMS ====================

  // List Payment Terms
  server.tool(
    'list_payment_terms',
    'List all payment terms',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<PaymentTerms>('/payment-terms', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: PaymentTerms[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== TAXING SCHEMES ====================

  // List Taxing Schemes
  server.tool(
    'list_taxing_schemes',
    'List all taxing schemes',
    {
      include: z.array(z.string()).optional().describe('Related data to include'),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<TaxingScheme>('/taxing-schemes', {
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: TaxingScheme[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Create/Update Taxing Scheme
  server.tool(
    'upsert_taxing_scheme',
    'Create or update a taxing scheme',
    {
      id: z.string().optional().describe('Scheme ID (required for updates)'),
      name: z.string().describe('Taxing scheme name'),
      isDefault: z.boolean().optional().describe('Whether this is the default scheme'),
    },
    async (args) => {
      const scheme: TaxingScheme = {
        id: args.id,
        name: args.name,
        isDefault: args.isDefault,
      };

      const result = await client.put<TaxingScheme>('/taxing-schemes', scheme);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ==================== TAX CODES ====================

  // List Tax Codes
  server.tool(
    'list_tax_codes',
    'List all tax codes',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<TaxCode>('/tax-codes', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: TaxCode[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== CURRENCIES ====================

  // List Currencies
  server.tool(
    'list_currencies',
    'List all currencies configured in inFlow',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name, code)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Currency>('/currencies', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Currency[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== ADJUSTMENT REASONS ====================

  // List Adjustment Reasons
  server.tool(
    'list_adjustment_reasons',
    'List all stock adjustment reasons',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<AdjustmentReason>('/adjustment-reasons', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: AdjustmentReason[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== CUSTOM FIELDS ====================

  // List Custom Field Definitions
  server.tool(
    'list_custom_field_definitions',
    'List all custom field definitions',
    {
      entityType: z
        .enum([
          'Product',
          'Customer',
          'Vendor',
          'SalesOrder',
          'PurchaseOrder',
          'StockAdjustment',
          'StockTransfer',
          'ManufacturingOrder',
        ])
        .optional()
        .describe('Filter by entity type'),
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name, entityType)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const filters: Record<string, string> = {};
      if (args.entityType) filters.entityType = args.entityType;

      const result = await client.getList<CustomFieldDefinition>(
        '/custom-field-definitions',
        {
          pagination,
          filters,
          sort: args.sort,
          sortDesc: args.sortDesc,
          includeCount: args.includeCount,
        }
      );

      const response: { data: CustomFieldDefinition[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // Get Custom Field Dropdown Options
  server.tool(
    'get_custom_field_dropdown_options',
    'Get dropdown options for custom fields of a specific entity type',
    {
      entityType: z
        .enum([
          'Product',
          'Customer',
          'Vendor',
          'SalesOrder',
          'PurchaseOrder',
          'StockAdjustment',
          'StockTransfer',
          'ManufacturingOrder',
        ])
        .describe('The entity type'),
    },
    async (args) => {
      const options = await client.get<Record<string, string[]>>(
        `/custom-field-dropdown-options/${args.entityType}`
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(options, null, 2) }],
      };
    }
  );

  // ==================== TEAM MEMBERS ====================

  // List Team Members
  server.tool(
    'list_team_members',
    'List all team members/users in the inFlow account',
    {
      skip: z.number().optional(),
      count: z.number().optional(),
      sort: z.string().optional().describe('Property to sort by (e.g., name, email)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<TeamMember>('/team-members', {
        pagination,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: TeamMember[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );

  // ==================== WEBHOOKS ====================

  // List Webhooks
  server.tool(
    'list_webhooks',
    'List all webhook subscriptions',
    {},
    async () => {
      const webhooks = await client.get<Webhook[]>('/webhooks');

      return {
        content: [{ type: 'text', text: JSON.stringify(webhooks, null, 2) }],
      };
    }
  );

  // Create/Update Webhook
  server.tool(
    'upsert_webhook',
    'Create or update a webhook subscription',
    {
      id: z.string().optional().describe('Webhook ID (required for updates)'),
      url: z.string().describe('Webhook endpoint URL'),
      events: z
        .array(
          z.enum([
            'customer.created',
            'customer.updated',
            'vendor.created',
            'vendor.updated',
            'product.created',
            'product.updated',
            'salesOrder.created',
            'salesOrder.updated',
            'purchaseOrder.created',
            'purchaseOrder.updated',
          ])
        )
        .describe('Events to subscribe to'),
      isActive: z.boolean().optional().describe('Whether webhook is active'),
    },
    async (args) => {
      const webhook: Webhook = {
        id: args.id,
        url: args.url,
        events: args.events,
        isActive: args.isActive,
      };

      const result = await client.put<Webhook>('/webhooks', webhook);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Delete Webhook
  server.tool(
    'delete_webhook',
    'Delete a webhook subscription',
    {
      webhookId: z.string().describe('The webhook ID to delete'),
    },
    async (args) => {
      await client.delete(`/webhooks/${args.webhookId}`);

      return {
        content: [{ type: 'text', text: `Webhook ${args.webhookId} deleted successfully` }],
      };
    }
  );
}
