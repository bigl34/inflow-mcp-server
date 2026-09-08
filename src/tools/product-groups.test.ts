import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import {
  normalizeProductGroup,
  registerProductGroupTools,
} from './product-groups.js';

describe('normalizeProductGroup', () => {
  it('returns deterministically ordered options, values, and variants', () => {
    const normalized = normalizeProductGroup({
      productGroupId: 'group-1',
      name: 'Products',
      options: [
        {
          name: 'Colour',
          lineNum: 2,
          optionValues: [
            { name: 'Red', lineNum: 2 },
            { name: 'Black', lineNum: 1 },
          ],
        },
        { name: 'Battery', lineNum: 1 },
      ],
      productVariants: [
        { productId: 'p2', product: { name: 'Second', sku: 'B' } },
        { productId: 'p1', product: { name: 'First', sku: 'A' } },
      ],
    });

    expect(normalized.options.map((option) => option.name)).toEqual([
      'Battery',
      'Colour',
    ]);
    expect(normalized.options[1].optionValues.map((value) => value.name)).toEqual([
      'Black',
      'Red',
    ]);
    expect(normalized.productVariants.map((variant) => variant.productId)).toEqual([
      'p1',
      'p2',
    ]);
  });
});

describe('product-group MCP endpoint wiring', () => {
  it('uses documented includes, pagination, and the location path/query', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    const getList = vi.fn(async () => ({ data: [], totalCount: 0 }));
    const get = vi.fn(async () => []);
    const client = { getList, get } as unknown as InflowClient;
    registerProductGroupTools(server, client, '2026-04-13');

    await handlers.list_product_groups({
      skip: 20,
      count: 10,
      sort: 'name',
      sortDesc: true,
      includeCount: true,
    });
    expect(getList).toHaveBeenCalledWith('/product-groups', {
      pagination: { skip: 20, count: 10 },
      include: ['options.optionValues', 'productVariants.product'],
      sort: 'name',
      sortDesc: true,
      includeCount: true,
    });

    await handlers.get_product_group_variant_quantities({
      productGroupId: 'group-1',
      locationId: 'location-1',
    });
    expect(get).toHaveBeenLastCalledWith(
      '/product-groups/group-1/quantities/location-1',
      { params: { locationId: 'location-1' } }
    );
  });

  it('returns an explicit unsupported error under the rollback API version', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    registerProductGroupTools(
      server,
      { getList: vi.fn(), get: vi.fn() } as unknown as InflowClient,
      '2025-06-24'
    );

    await expect(
      handlers.list_product_groups({ count: 20 })
    ).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
    await expect(
      handlers.get_product_group({ productGroupId: 'group-1' })
    ).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
    await expect(
      handlers.get_product_group_variant_quantities({
        productGroupId: 'group-1',
        locationId: 'location-1',
      })
    ).rejects.toThrow(/UNSUPPORTED_API_VERSION/);
  });
});
