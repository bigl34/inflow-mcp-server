import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  ProductGroup,
  ProductGroupQuantity,
  ProductVariant,
} from '../types/inflow.js';
import { assertManufacturingApiVersion } from './product-manufacturing.js';

const GROUP_INCLUDE = [
  'options.optionValues',
  'productVariants.product',
];

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function normalizeVariant(variant: ProductVariant) {
  return {
    productVariantId: variant.productVariantId,
    productGroupId: variant.productGroupId,
    productId: variant.productId,
    productName: variant.product?.name,
    productSku: variant.product?.sku,
    productIsActive: variant.product?.isActive,
    variantOption: variant.variantOption,
    timestamp: variant.timestamp,
  };
}

export function normalizeProductGroup(group: ProductGroup) {
  const options = (group.options ?? [])
    .map((option) => ({
      productGroupOptionId: option.productGroupOptionId,
      name: option.name,
      lineNum: option.lineNum,
      timestamp: option.timestamp,
      optionValues: (option.optionValues ?? [])
        .map((value) => ({
          productGroupOptionValueId: value.productGroupOptionValueId,
          name: value.name ?? value.value ?? value.optionValue,
          lineNum: value.lineNum,
          timestamp: value.timestamp,
        }))
        .sort((a, b) =>
          (a.lineNum ?? Number.MAX_SAFE_INTEGER) -
            (b.lineNum ?? Number.MAX_SAFE_INTEGER) ||
          (a.name ?? '').localeCompare(b.name ?? '')
        ),
    }))
    .sort((a, b) =>
      (a.lineNum ?? Number.MAX_SAFE_INTEGER) -
        (b.lineNum ?? Number.MAX_SAFE_INTEGER) ||
      (a.name ?? '').localeCompare(b.name ?? '')
    );

  return {
    productGroupId: group.productGroupId,
    name: group.name,
    description: group.description,
    isActive: group.isActive,
    categoryId: group.categoryId,
    defaultProductId: group.defaultProductId,
    defaultImageId: group.defaultImageId,
    images: group.images,
    timestamp: group.timestamp,
    options,
    productVariants: (group.productVariants ?? [])
      .map(normalizeVariant)
      .sort((a, b) =>
        (a.productSku ?? '').localeCompare(b.productSku ?? '') ||
        (a.productId ?? '').localeCompare(b.productId ?? '')
      ),
    raw: group,
  };
}

export function registerProductGroupTools(
  server: McpServer,
  client: InflowClient,
  apiVersion: string
): void {
  server.tool(
    'list_product_groups',
    'List inFlow product groups with ordered options and attached variants.',
    {
      skip: z.number().int().min(0).optional(),
      count: z.number().int().min(1).max(100).default(20),
      sort: z.string().optional(),
      sortDesc: z.boolean().optional(),
      includeCount: z.boolean().optional(),
    },
    async (args) => {
      assertManufacturingApiVersion(apiVersion);
      const result = await client.getList<ProductGroup>('/product-groups', {
        pagination: { skip: args.skip, count: args.count },
        include: GROUP_INCLUDE,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });
      return textResult({
        data: result.data.map(normalizeProductGroup),
        ...(result.totalCount === undefined
          ? {}
          : { totalCount: result.totalCount }),
      });
    }
  );

  server.tool(
    'get_product_group',
    'Get one product group with ordered options, option values, and attached product variants.',
    { productGroupId: z.string().min(1) },
    async ({ productGroupId }) => {
      assertManufacturingApiVersion(apiVersion);
      const group = await client.get<ProductGroup>(
        `/product-groups/${productGroupId}`,
        { include: GROUP_INCLUDE }
      );
      return textResult(normalizeProductGroup(group));
    }
  );

  server.tool(
    'get_product_group_variant_quantities',
    'Get product-variant quantities for one product group at one location.',
    {
      productGroupId: z.string().min(1),
      locationId: z.string().min(1),
    },
    async ({ productGroupId, locationId }) => {
      assertManufacturingApiVersion(apiVersion);
      const quantities = await client.get<ProductGroupQuantity[] | { data: ProductGroupQuantity[] }>(
        `/product-groups/${productGroupId}/quantities/${locationId}`,
        { params: { locationId } }
      );
      const data = Array.isArray(quantities) ? quantities : quantities.data;
      return textResult({ productGroupId, locationId, data });
    }
  );
}
