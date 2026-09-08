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
 *   INFLOW_BASE_URL          - API base URL (default: https://cloudapi.inflowinventory.com)
 *   INFLOW_API_VERSION       - API version (default: 2026-04-13)
 *   INFLOW_ENABLE_SAFE_WRITES - master gate for every preview-first apply
 *   INFLOW_ENABLE_STOCK_WRITES - additional gate for stock-affecting applies
 *   INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES - dedicated coordinator gate;
 *     manufacturing pick-batch also requires the master and stock gates plus
 *     its existing coordinator attestation
 *   INFLOW_ENABLE_MANUFACTURING_WRITES - deprecated compatibility input for
 *     product BOM/config; ignored for authorization
 *   INFLOW_ENABLE_PRICE_WRITES, INFLOW_ENABLE_PRODUCT_GROUP_WRITES,
 *   INFLOW_ENABLE_MO_SERIAL_WRITES, INFLOW_ENABLE_STANDARD_WRITES - deprecated
 *     diagnostic inputs; ignored for authorization
 *   INFLOW_ENABLE_LEGACY_WRITES - legacy immediate-write compatibility input;
 *     safe-write gates do not disable legacy write tools
 *   INFLOW_RATE_LIMIT        - Requests per minute (default: 60)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { InflowClient } from './client/inflow.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { registerAllTools } from './registry.js';

async function main(): Promise<void> {
  // Load configuration from environment variables
  const config = loadConfig();

  // Create the inFlow API client
  const client = new InflowClient(config);

  // Create the MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tool groups
  registerAllTools(server, client, config);

  // Set up the stdio transport
  const transport = new StdioServerTransport();

  // Connect and start the server
  await server.connect(transport);

  // Log startup message to stderr (stdout is reserved for MCP communication)
  console.error('inFlow Inventory MCP Server started');
  console.error(`API Version: ${config.apiVersion}`);
  console.error(`Rate Limit: ${config.rateLimitPerMinute} req/min`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
