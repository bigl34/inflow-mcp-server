import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import { normalizeOperationType, registerOperationTypeTools } from './operation-types.js';

describe('operation type tools', () => {
  it('normalizes required identity and retains the raw row', () => {
    const raw = { operationTypeId: 'op-1', name: 'Assembly', isActive: true, timestamp: 't-1', trackTime: true };
    expect(normalizeOperationType(raw)).toEqual({ operationTypeId: 'op-1', name: 'Assembly', isActive: true, timestamp: 't-1', raw });
    expect(() => normalizeOperationType({ name: 'bad' })).toThrow(/missing operationTypeId/);
  });

  it('forwards filters and pagination and rejects rollback versions', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers[name] = handler; } } as unknown as McpServer;
    const getList = vi.fn(async () => ({ data: [], totalCount: 0 }));
    const client = { getList, get: vi.fn() } as unknown as InflowClient;
    registerOperationTypeTools(server, client, '2026-04-13');
    await handlers.list_operation_types({ skip: 1, count: 10, isActive: true, includeCount: true });
    expect(getList).toHaveBeenCalledWith('/operation-types', { pagination: { skip: 1, count: 10 }, filters: { isActive: true }, sort: undefined, sortDesc: undefined, includeCount: true });

    const rollbackHandlers: typeof handlers = {};
    const rollbackServer = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { rollbackHandlers[name] = handler; } } as unknown as McpServer;
    registerOperationTypeTools(rollbackServer, client, '2025-01-01');
    await expect(rollbackHandlers.list_operation_types({ count: 10 })).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
  });
});
