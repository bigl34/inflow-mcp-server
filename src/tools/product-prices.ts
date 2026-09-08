import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { assertCapability } from '../core/capabilities.js';
import { executeMutation, type MutationAdapter, type MutationControl } from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { textResult } from '../core/results.js';
import { assertSafeWriteAuthorized, getSafeWritePolicy } from '../core/write-policy.js';
import {
  buildDesiredPrices,
  canonicalPrices,
  fetchProductPrices,
  priceSemantic,
  priceWriteShape,
  writablePrices,
  type PriceInput,
  type ProductPriceState,
} from '../services/product-prices.js';
import type { Product } from '../types/inflow.js';

interface SetPricesInput extends MutationControl {
  productId: string;
  mode: 'patch' | 'replace';
  prices?: PriceInput[];
  removeProductPriceIds?: string[];
}

const nullableDecimal = z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).nullable();
const priceSchema = z.object({
  productPriceId: z.string().min(1).optional(),
  pricingSchemeId: z.string().min(1),
  unitPrice: nullableDecimal.optional(),
  fixedMarkup: nullableDecimal.optional(),
  priceType: z.string().nullable().optional(),
});

export function registerProductPriceTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  server.tool('get_product_prices', 'Get all price rows for a product using exact pricing-scheme IDs.', {
    productId: z.string().min(1),
  }, async ({ productId }) => {
    assertCapability('prices.read', config.apiVersion);
    const state = await fetchProductPrices(client, productId);
    return textResult({ ...state, canonicalPrices: canonicalPrices(state.prices) });
  });

  server.tool('set_product_prices', 'Preview or safely apply product price rows. Apply requires the master safe-write gate.', {
    productId: z.string().min(1),
    mode: z.enum(['patch', 'replace']),
    prices: z.array(priceSchema).optional(),
    removeProductPriceIds: z.array(z.string().min(1)).optional(),
    dryRun: z.boolean().default(true),
    previewToken: z.string().optional(),
    idempotencyKey: z.string().min(1).optional(),
    expectedSemanticHash: z.string().optional(),
    expectedWriteShapeHash: z.string().optional(),
    expectedEntityTimestamp: z.string().optional(),
    expectedDesiredHash: z.string().optional(),
  }, async (args) => {
    assertCapability('prices.write', config.apiVersion);
    const policy = getSafeWritePolicy('set_product_prices');
    const adapter: MutationAdapter<SetPricesInput, ProductPriceState, ProductPriceState, ProductPriceState> = {
      operation: 'set_product_prices',
      resourceType: 'product-prices',
      resourceId: (input) => input.productId,
      mode: (input) => input.mode,
      adapterVersion: 'product-prices/v1',
      read: (input) => fetchProductPrices(client, input.productId),
      buildDesired: (input, current) => buildDesiredPrices({ current: current!, mode: input.mode, prices: input.prices, removeProductPriceIds: input.removeProductPriceIds }),
      semantic: priceSemantic,
      writeShape: (current) => current ? priceWriteShape(current) : null,
      timestamp: (current) => current?.timestamp,
      output: (value) => value,
      validate: (_input, _current, desired) => { canonicalPrices(desired.prices); },
      prepareDispatch: async (_input, current, desired) => {
        const prepared = await client.prepareMutation<Product>('PUT', '/products', { body: {
          productId: desired.productId,
          timestamp: current?.timestamp,
          prices: writablePrices(desired),
        } });
        return prepared.dispatch;
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: (input) => [{ type: 'product', id: input.productId }, { type: 'product-prices', id: input.productId }],
      invalidationTags: (input) => [`product:${input.productId}`, `prices:${input.productId}`],
      writesEnabled: policy.staticSupport,
      authorizeApply: () => assertSafeWriteAuthorized(config, 'set_product_prices'),
      requiresIdempotency: (input, current) => input.mode === 'patch' && (
        (input.removeProductPriceIds?.length ?? 0) > 0 ||
        (input.prices ?? []).some((candidate) => !candidate.productPriceId &&
          !(current?.prices ?? []).some((existing) => existing.pricingSchemeId === candidate.pricingSchemeId))
      ),
      disabledCode: 'OPERATION_UNSUPPORTED',
      disabledMessage: 'Price apply is not supported by this server build.',
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, args as SetPricesInput));
  });
}
