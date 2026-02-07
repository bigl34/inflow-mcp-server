/**
 * Currency Code to ID Mapper
 * Maps ISO currency codes (USD, GBP, etc.) to inFlow currency IDs
 *
 * These IDs are account-specific. Get the full list for your account via the /currencies endpoint.
 * This hardcoded mapping covers the most common currencies as a starting point.
 */

// Mapping of ISO currency codes to inFlow currency IDs
// These may be account-specific — verify against your /currencies endpoint
const CURRENCY_CODE_TO_ID: Record<string, string> = {
  // Common currencies (GBP as base currency)
  'GBP': 'a69ee070-a51d-4cca-82da-0c0d130027e4',  // British Pound - BASE CURRENCY (exchangeRate: 1.0)
  'USD': '64c0b8e6-3d41-45e6-8692-f689fb8cb083',  // US Dollar (exchangeRate: ~1.356)
  'CNY': '5a1b62ca-adc8-4dac-bce0-e0d857ff31ef',  // Chinese Yuan (exchangeRate: ~9.691)

  // Add more as needed - query /currencies endpoint for complete list
};

/**
 * Convert currency code (e.g., "USD") to inFlow currency ID
 * @param currencyCode - ISO currency code (e.g., "USD", "GBP")
 * @returns Currency ID or undefined if not found
 * @throws Error if currency code is invalid or not configured
 */
export function getCurrencyId(currencyCode: string | undefined): string | undefined {
  if (!currencyCode) return undefined;

  const upperCode = currencyCode.toUpperCase();
  const currencyId = CURRENCY_CODE_TO_ID[upperCode];

  if (!currencyId) {
    throw new Error(
      `Currency code '${currencyCode}' not found in mapping. ` +
      `Configured currencies: ${Object.keys(CURRENCY_CODE_TO_ID).join(', ')}. ` +
      `To add a currency, update CURRENCY_CODE_TO_ID mapping in currency-mapper.ts`
    );
  }

  return currencyId;
}

/**
 * Get all configured currency codes
 */
export function getConfiguredCurrencies(): string[] {
  return Object.keys(CURRENCY_CODE_TO_ID);
}
