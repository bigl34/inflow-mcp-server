/**
 * Currency Code to ID Mapper
 * Maps ISO currency codes (USD, EUR, etc.) to inFlow currency IDs
 *
 * These IDs are account-specific. Get the full list for your account via the /currencies endpoint.
 * This hardcoded mapping covers the most common currencies as a starting point.
 */

// Mapping of ISO currency codes to inFlow currency IDs
// These may be account-specific — verify against your /currencies endpoint
const CURRENCY_CODE_TO_ID: Record<string, string> = {
  // Common currencies (example currency mapping)
  'USD': 'YOUR_BASE_CURRENCY_ID',  // Base currency placeholder
  'EUR': 'YOUR_SECONDARY_CURRENCY_ID',  // Secondary currency placeholder
  'CAD': 'YOUR_ADDITIONAL_CURRENCY_ID',  // Additional currency placeholder

  // Add more as needed - query /currencies endpoint for complete list
};

/**
 * Convert currency code (e.g., "USD") to inFlow currency ID
 * @param currencyCode - ISO currency code (e.g., "USD", "EUR")
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
