import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import { assertCapability } from '../core/capabilities.js';
import { textResult } from '../core/results.js';
import { auditProductGroupManufacturing } from '../services/product-group-audit.js';

export function registerProductGroupAuditTools(server: McpServer, client: InflowClient, apiVersion: string): void {
  server.tool('audit_product_group_manufacturing', 'Audit every attached variant against its option matrix and manufacturing baseline.', {
    productGroupId: z.string().min(1),
    baselineProductId: z.string().min(1).optional(),
    locationId: z.string().min(1).optional(),
    includeInactive: z.boolean().default(false),
    maxVariants: z.number().int().min(1).max(500).default(250),
  }, async (args) => {
    assertCapability('group-audit.read', apiVersion);
    return textResult(await auditProductGroupManufacturing(client, args));
  });
}
