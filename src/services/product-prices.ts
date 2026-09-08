import type { InflowClient } from '../client/inflow.js';
import { normalizeDecimal } from '../core/decimal.js';
import type { Product, ProductPrice } from '../types/inflow.js';

export interface CanonicalPrice {
  productPriceId?: string;
  pricingSchemeId: string;
  unitPrice: string | null;
  fixedMarkup: string | null;
  priceType: string | null;
}

export interface PriceInput {
  productPriceId?: string;
  pricingSchemeId: string;
  unitPrice?: string | null;
  fixedMarkup?: string | null;
  priceType?: string | null;
}

export interface ProductPriceState {
  productId: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  timestamp?: string;
  prices: ProductPrice[];
  defaultPrice?: ProductPrice;
}

function decimal(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : normalizeDecimal(value);
}

export function canonicalPrice(row: ProductPrice): CanonicalPrice {
  if (!row.pricingSchemeId) throw new Error('INVALID_PRODUCT_PRICE: pricingSchemeId is required');
  return {
    ...(row.productPriceId ? { productPriceId: row.productPriceId } : {}),
    pricingSchemeId: row.pricingSchemeId,
    unitPrice: decimal(row.unitPrice),
    fixedMarkup: decimal(row.fixedMarkup),
    priceType: row.priceType ?? null,
  };
}

export function canonicalPrices(rows: ProductPrice[]): CanonicalPrice[] {
  return rows.map(canonicalPrice).sort((a, b) => a.pricingSchemeId.localeCompare(b.pricingSchemeId));
}

export async function fetchProductPrices(client: InflowClient, productId: string): Promise<ProductPriceState> {
  const row = await client.get<Product>(`/products/${productId}`, {
    include: ['prices', 'prices.pricingScheme', 'defaultPrice'],
  });
  return {
    productId: row.productId ?? productId,
    name: row.name,
    sku: row.sku ?? null,
    isActive: row.isActive ?? false,
    timestamp: row.timestamp,
    prices: row.prices ?? [],
    defaultPrice: row.defaultPrice,
  };
}

function unique<T>(rows: T[], label: string): T | undefined {
  if (rows.length > 1) throw new Error(`AMBIGUOUS_PRICE_MATCH: ${label}`);
  return rows[0];
}

function merge(existing: ProductPrice | undefined, input: PriceInput, productId: string): ProductPrice {
  const has = (key: keyof PriceInput) => Object.prototype.hasOwnProperty.call(input, key);
  return {
    productPriceId: existing?.productPriceId,
    productId,
    pricingSchemeId: input.pricingSchemeId,
    timestamp: existing?.timestamp,
    unitPrice: has('unitPrice') ? decimal(input.unitPrice) : decimal(existing?.unitPrice),
    fixedMarkup: has('fixedMarkup') ? decimal(input.fixedMarkup) : decimal(existing?.fixedMarkup),
    priceType: has('priceType') ? input.priceType ?? undefined : existing?.priceType,
  };
}

export function buildDesiredPrices(args: {
  current: ProductPriceState;
  mode: 'patch' | 'replace';
  prices?: PriceInput[];
  removeProductPriceIds?: string[];
}): ProductPriceState {
  const existing: ProductPrice[] = args.current.prices.map((row) => {
    const { pricingScheme: _enrichment, ...writable } = row;
    return writable;
  });
  if (args.mode === 'replace' && (args.removeProductPriceIds?.length ?? 0) > 0) {
    throw new Error('PRICE_REMOVALS_ONLY_VALID_IN_PATCH');
  }
  const seenSchemes = new Set<string>();
  for (const input of args.prices ?? []) {
    if (seenSchemes.has(input.pricingSchemeId)) throw new Error(`DUPLICATE_PRICING_SCHEME: ${input.pricingSchemeId}`);
    seenSchemes.add(input.pricingSchemeId);
  }
  let next = args.mode === 'replace' && args.prices !== undefined ? [] : [...existing];
  if (args.mode === 'patch') {
    const removals = new Set(args.removeProductPriceIds ?? []);
    for (const id of removals) {
      if (!existing.some((row) => row.productPriceId === id)) throw new Error(`UNKNOWN_PRODUCT_PRICE_REMOVAL: ${id}`);
    }
    next = next.filter((row) => !row.productPriceId || !removals.has(row.productPriceId));
  }
  for (const input of args.prices ?? []) {
    const match = input.productPriceId
      ? unique(existing.filter((row) => row.productPriceId === input.productPriceId), `productPriceId ${input.productPriceId}`)
      : unique(existing.filter((row) => row.pricingSchemeId === input.pricingSchemeId), `pricingSchemeId ${input.pricingSchemeId}`);
    if (input.productPriceId && !match) throw new Error(`UNKNOWN_PRODUCT_PRICE_ID: ${input.productPriceId}`);
    if (match && match.pricingSchemeId !== input.pricingSchemeId) throw new Error(`PRICE_SCHEME_ID_IMMUTABLE: ${input.productPriceId}`);
    const row = merge(match, input, args.current.productId);
    const index = next.findIndex((candidate) => candidate.productPriceId && candidate.productPriceId === match?.productPriceId);
    if (index >= 0) next[index] = row;
    else next.push(row);
  }
  const desiredSchemes = next.map((row) => row.pricingSchemeId);
  if (desiredSchemes.some((id) => !id) || new Set(desiredSchemes).size !== desiredSchemes.length) {
    throw new Error('DUPLICATE_PRICING_SCHEME_IN_DESIRED_STATE');
  }
  return { ...args.current, prices: next };
}

export function writablePrices(state: ProductPriceState): ProductPrice[] {
  return state.prices.map((row) => ({
    productPriceId: row.productPriceId,
    productId: state.productId,
    pricingSchemeId: row.pricingSchemeId,
    timestamp: row.timestamp,
    unitPrice: decimal(row.unitPrice),
    fixedMarkup: decimal(row.fixedMarkup),
    priceType: row.priceType,
  }));
}

export function priceSemantic(state: ProductPriceState) {
  return {
    productId: state.productId,
    name: state.name,
    sku: state.sku,
    isActive: state.isActive,
    prices: canonicalPrices(state.prices).map(({ productPriceId: _id, ...row }) => row),
  };
}

export function priceWriteShape(state: ProductPriceState) {
  return {
    productId: state.productId,
    timestamp: state.timestamp ?? null,
    prices: canonicalPrices(state.prices),
  };
}
