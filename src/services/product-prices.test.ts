import { describe, expect, it } from 'vitest';
import { buildDesiredPrices, canonicalPrices, priceSemantic } from './product-prices.js';

const current = {
  productId: 'p-1', name: 'Product', sku: 'SKU', isActive: true, timestamp: 't-1',
  prices: [
    { productPriceId: 'row-1', pricingSchemeId: 'scheme-1', unitPrice: '10.00', fixedMarkup: null, priceType: 'fixedPrice' },
    { productPriceId: 'row-2', pricingSchemeId: 'scheme-2', unitPrice: '8', fixedMarkup: null, priceType: 'fixedPrice' },
  ],
};

describe('product price normalization', () => {
  it('patches by exact scheme ID and preserves unmentioned schemes', () => {
    const desired = buildDesiredPrices({ current, mode: 'patch', prices: [{ pricingSchemeId: 'scheme-1', unitPrice: '12.500' }] });
    expect(canonicalPrices(desired.prices)).toEqual([
      { productPriceId: 'row-1', pricingSchemeId: 'scheme-1', unitPrice: '12.5', fixedMarkup: null, priceType: 'fixedPrice' },
      { productPriceId: 'row-2', pricingSchemeId: 'scheme-2', unitPrice: '8', fixedMarkup: null, priceType: 'fixedPrice' },
    ]);
    expect(priceSemantic(desired).prices.every((row) => !('productPriceId' in row))).toBe(true);
  });

  it('rejects unknown exact row removals and duplicate schemes', () => {
    expect(() => buildDesiredPrices({ current, mode: 'patch', removeProductPriceIds: ['missing'] })).toThrow(/UNKNOWN_PRODUCT_PRICE_REMOVAL/);
    expect(() => buildDesiredPrices({ current, mode: 'replace', prices: [{ pricingSchemeId: 'scheme-1' }, { pricingSchemeId: 'scheme-1' }] })).toThrow(/DUPLICATE_PRICING_SCHEME/);
    expect(() => buildDesiredPrices({ current, mode: 'patch', prices: [{ productPriceId: 'row-1', pricingSchemeId: 'scheme-2', unitPrice: '9' }] })).toThrow(/PRICE_SCHEME_ID_IMMUTABLE/);
  });
});
