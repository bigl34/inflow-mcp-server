import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { OperationType } from '../types/inflow.js';
import { assertCapability } from '../core/capabilities.js';
import { textResult } from '../core/results.js';

export function normalizeOperationType(row: OperationType) {
  if (!row.operationTypeId) throw new Error('INVALID_OPERATION_TYPE: missing operationTypeId');
  return {
    operationTypeId: row.operationTypeId,
    name: row.name ?? null,
    isActive: row.isActive ?? null,
    timestamp: row.timestamp ?? null,
    raw: row,
  };
}
export function registerOperationTypeTools(server: McpServer, client: InflowClient, apiVersion: string): void {
  server.tool('list_operation_types', 'List manufacturing operation types.', {
    skip: z.number().int().min(0).optional(),
    count: z.number().int().min(1).max(100).default(20),
    sort: z.string().optional(),
    sortDesc: z.boolean().optional(),
    includeCount: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }, async (args) => {
    assertCapability('operation-types.read', apiVersion);
    const result = await client.getList<OperationType>('/operation-types', {
      pagination: { skip: args.skip, count: args.count },
      filters: { isActive: args.isActive },
      sort: args.sort,
      sortDesc: args.sortDesc,
      includeCount: args.includeCount,
    });
    return textResult({ data: result.data.map(normalizeOperationType), ...(result.totalCount === undefined ? {} : { totalCount: result.totalCount }) });
  });

  server.tool('get_operation_type', 'Get one manufacturing operation type.', {
    operationTypeId: z.string().min(1),
  }, async ({ operationTypeId }) => {
    assertCapability('operation-types.read', apiVersion);
    return textResult(normalizeOperationType(await client.get<OperationType>(`/operation-types/${operationTypeId}`)));
  });
}
