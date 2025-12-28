// Configuration handling for inFlow MCP Server

export interface InflowConfig {
  companyId: string;
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  debug: boolean;
}

export function loadConfig(): InflowConfig {
  const companyId = process.env.INFLOW_COMPANY_ID;
  const apiKey = process.env.INFLOW_API_KEY;

  if (!companyId) {
    throw new Error(
      'INFLOW_COMPANY_ID environment variable is required. ' +
        'Find your Company ID at: inFlow Settings > Integrations > API Keys'
    );
  }

  if (!apiKey) {
    throw new Error(
      'INFLOW_API_KEY environment variable is required. ' +
        'Generate an API key at: inFlow Settings > Integrations > API Keys'
    );
  }

  return {
    companyId,
    apiKey,
    baseUrl:
      process.env.INFLOW_BASE_URL || 'https://cloudapi.inflowinventory.com',
    apiVersion: process.env.INFLOW_API_VERSION || '2025-06-24',
    rateLimitPerMinute: parseInt(
      process.env.INFLOW_RATE_LIMIT || '60',
      10
    ),
    requestTimeoutMs: parseInt(
      process.env.INFLOW_REQUEST_TIMEOUT || '30000',
      10
    ),
    maxRetries: parseInt(process.env.INFLOW_MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.INFLOW_RETRY_DELAY || '1000', 10),
    debug: process.env.INFLOW_DEBUG === 'true',
  };
}
