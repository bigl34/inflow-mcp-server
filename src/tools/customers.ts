// Customer and Vendor tools for inFlow MCP Server

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  Customer,
  Vendor,
  CustomerFilter,
  VendorFilter,
  PaginationParams,
  Address,
  Contact,
} from '../types/inflow.js';

const addressSchema = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

const contactSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

export function registerCustomerTools(server: McpServer, client: InflowClient): void {
  // List Customers
  server.tool(
    'list_customers',
    'Search and list customers with optional filtering',
    {
      name: z.string().optional().describe('Filter by customer name (partial match)'),
      email: z.string().optional().describe('Filter by email'),
      phone: z.string().optional().describe('Filter by phone'),
      locationId: z.string().optional().describe('Filter by location ID'),
      pricingSchemeId: z.string().optional().describe('Filter by pricing scheme ID'),
      isActive: z.boolean().optional().describe('Filter by active status'),
      smart: z.string().optional().describe('Smart search across customer fields (name, email, phone)'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., contacts, pricingScheme, paymentTerms)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., name, modifiedDate)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: CustomerFilter = {};
      if (args.name) filters.name = args.name;
      if (args.email) filters.email = args.email;
      if (args.phone) filters.phone = args.phone;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.pricingSchemeId) filters.pricingSchemeId = args.pricingSchemeId;
      if (args.isActive !== undefined) filters.isActive = args.isActive;
      if (args.smart) filters.smart = args.smart;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Customer>('/customers', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Customer[]; totalCount?: number } = { data: result.data };
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

  // Get Customer
  server.tool(
    'get_customer',
    'Get detailed information about a specific customer',
    {
      customerId: z.string().describe('The customer ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include'),
    },
    async (args) => {
      const customer = await client.get<Customer>(
        `/customers/${args.customerId}`,
        { include: args.include }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(customer, null, 2),
          },
        ],
      };
    }
  );

  // Create/Update Customer
  server.tool(
    'upsert_customer',
    'Create a new customer or update an existing one',
    {
      id: z.string().optional().describe('Customer ID (required for updates)'),
      name: z.string().describe('Customer name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      fax: z.string().optional().describe('Fax number'),
      website: z.string().optional().describe('Website URL'),
      billingAddress: addressSchema.optional().describe('Billing address'),
      shippingAddress: addressSchema.optional().describe('Shipping address'),
      pricingSchemeId: z.string().optional().describe('Pricing scheme ID'),
      paymentTermsId: z.string().optional().describe('Payment terms ID'),
      taxingSchemeId: z.string().optional().describe('Taxing scheme ID'),
      currencyCode: z.string().optional().describe('Currency code'),
      contacts: z.array(contactSchema).optional().describe('Contact persons'),
      remarks: z.string().optional().describe('Notes/remarks'),
      customFields: z.record(z.unknown()).optional().describe('Custom field values'),
      isActive: z.boolean().optional().describe('Whether customer is active'),
      timestamp: z.string().optional().describe('Timestamp for concurrency control'),
    },
    async (args) => {
      // inFlow API requires customerId for both create and update
      // Generate a new UUID if not provided (for creates)
      const customerId = args.id || randomUUID();

      const customer: Customer = {
        customerId: customerId,
        name: args.name,
        email: args.email,
        phone: args.phone,
        fax: args.fax,
        website: args.website,
        billingAddress: args.billingAddress as Address,
        shippingAddress: args.shippingAddress as Address,
        pricingSchemeId: args.pricingSchemeId,
        paymentTermsId: args.paymentTermsId,
        taxingSchemeId: args.taxingSchemeId,
        currencyCode: args.currencyCode,
        contacts: args.contacts as Contact[],
        remarks: args.remarks,
        customFields: args.customFields,
        isActive: args.isActive,
        timestamp: args.timestamp,
      };

      // inFlow API uses PUT for both create and update with customerId in body
      const result = await client.put<Customer>('/customers', customer);

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

  // List Vendors
  server.tool(
    'list_vendors',
    'Search and list vendors with optional filtering',
    {
      name: z.string().optional().describe('Filter by vendor name (partial match)'),
      email: z.string().optional().describe('Filter by email'),
      isActive: z.boolean().optional().describe('Filter by active status'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., contacts, paymentTerms)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., name, modifiedDate)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: VendorFilter = {};
      if (args.name) filters.name = args.name;
      if (args.email) filters.email = args.email;
      if (args.isActive !== undefined) filters.isActive = args.isActive;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<Vendor>('/vendors', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: Vendor[]; totalCount?: number } = { data: result.data };
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

  // Get Vendor
  server.tool(
    'get_vendor',
    'Get detailed information about a specific vendor',
    {
      vendorId: z.string().describe('The vendor ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include'),
    },
    async (args) => {
      const vendor = await client.get<Vendor>(`/vendors/${args.vendorId}`, {
        include: args.include,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(vendor, null, 2),
          },
        ],
      };
    }
  );

  // Create/Update Vendor
  server.tool(
    'upsert_vendor',
    'Create a new vendor or update an existing one',
    {
      id: z.string().optional().describe('Vendor ID (required for updates)'),
      name: z.string().describe('Vendor name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      fax: z.string().optional().describe('Fax number'),
      website: z.string().optional().describe('Website URL'),
      address: addressSchema.optional().describe('Vendor address'),
      paymentTermsId: z.string().optional().describe('Payment terms ID'),
      currencyCode: z.string().optional().describe('Currency code'),
      contacts: z.array(contactSchema).optional().describe('Contact persons'),
      customFields: z.record(z.unknown()).optional().describe('Custom field values'),
      isActive: z.boolean().optional().describe('Whether vendor is active'),
      timestamp: z.string().optional().describe('Timestamp for concurrency control'),
    },
    async (args) => {
      // inFlow API requires vendorId for both create and update
      // Generate a new UUID if not provided (for creates)
      const vendorId = args.id || randomUUID();

      const vendor: Vendor = {
        vendorId: vendorId,
        name: args.name,
        email: args.email,
        phone: args.phone,
        fax: args.fax,
        website: args.website,
        address: args.address as Address,
        paymentTermsId: args.paymentTermsId,
        currencyCode: args.currencyCode,
        contacts: args.contacts as Contact[],
        customFields: args.customFields,
        isActive: args.isActive,
        timestamp: args.timestamp,
      };

      // inFlow API uses PUT for both create and update with vendorId in body
      const result = await client.put<Vendor>('/vendors', vendor);

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
