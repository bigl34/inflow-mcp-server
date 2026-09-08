import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import { assertCapability } from '../core/capabilities.js';
import { textResult } from '../core/results.js';
import { calculateBomRequirements } from '../services/bom-requirements.js';

export function registerBomRequirementTools(server: McpServer, client: InflowClient, apiVersion: string): void {
  server.tool('calculate_bom_requirements', 'Calculate exact direct, leaf, or net BOM requirements at one location.', {
    productId: z.string().min(1),
    buildQuantity: z.string().regex(/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/),
    locationId: z.string().min(1),
    mode: z.enum(['direct', 'leaf', 'net']).default('net'),
    stockBasis: z.enum(['available', 'onHand']).default('available'),
    maxDepth: z.number().int().min(1).max(50).default(12),
    maxProducts: z.number().int().min(1).max(500).default(250),
  }, async (args) => {
    assertCapability('bom-requirements.read', apiVersion);
    return textResult(await calculateBomRequirements(client, args));
  });
}
