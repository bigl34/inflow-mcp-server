#!/usr/bin/env node

// Load environment variables from .env file
import 'dotenv/config';

/**
 * inFlow Inventory MCP Server
 *
 * A Model Context Protocol (MCP) server that provides tools for interacting
 * with the inFlow Inventory API. Enables AI assistants to manage products,
 * orders, customers, vendors, and inventory operations.
 *
 * Environment Variables Required:
 *   INFLOW_COMPANY_ID - Your inFlow company ID
 *   INFLOW_API_KEY    - Your inFlow API key
 *
 * Optional Environment Variables:
 *   INFLOW_BASE_URL      - API base URL (default: https://cloudapi.inflowinventory.com)
 *   INFLOW_API_VERSION   - API version (default: 2025-06-24)
 *   INFLOW_RATE_LIMIT    - Requests per minute (default: 60)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { InflowClient } from './client/inflow.js';
import { registerProductTools } from './tools/products.js';
import { registerSalesOrderTools } from './tools/sales-orders.js';
import { registerPurchaseOrderTools } from './tools/purchase-orders.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerReferenceTools } from './tools/reference.js';
import { registerSerialTools } from './tools/serials.js';

async function main(): Promise<void> {
  // Load configuration from environment variables
  const config = loadConfig();

  // Create the inFlow API client
  const client = new InflowClient(config);

  // Create the MCP server
  const server = new McpServer({
    name: 'inflow-inventory',
    version: '1.0.0',
  });

  // Register all tool groups
  registerProductTools(server, client);
  registerSalesOrderTools(server, client);
  registerPurchaseOrderTools(server, client);
  registerCustomerTools(server, client);
  registerInventoryTools(server, client);
  registerReferenceTools(server, client);
  registerSerialTools(server, client);

  // Set up the stdio transport
  const transport = new StdioServerTransport();

  // Connect and start the server
  await server.connect(transport);

  // Log startup message to stderr (stdout is reserved for MCP communication)
  console.error('inFlow Inventory MCP Server started');
  console.error(`Company ID: ${config.companyId}`);
  console.error(`API Version: ${config.apiVersion}`);
  console.error(`Rate Limit: ${config.rateLimitPerMinute} req/min`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
