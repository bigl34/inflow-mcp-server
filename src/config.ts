// Configuration handling for inFlow MCP Server

import { computeBuildIdentities, verifyBuildIdentityOverride } from './build-identity.js';

export interface InflowConfig {
  companyId: string;
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  readRetryBudgetMs: number;
  debug: boolean;
  /** Master authorization gate for every preview-first safe apply. */
  safeWritesEnabled: boolean;
  /** Additional authorization gate for stock-affecting safe applies. */
  stockWritesEnabled: boolean;
  /** @deprecated Does not authorize product BOM/config writes. */
  enableManufacturingWrites?: boolean;
  stateDir: string;
  adapterManifestHash: string;
  probeBuild: string;
  enableLegacyWrites: boolean;
  /**
   * @deprecated Per-domain gates are diagnostics only. Safe writes use
   * safeWritesEnabled and stockWritesEnabled; pick-batch also uses its
   * dedicated coordinator attestation.
   */
  writeGates: Record<
    'manufacturing' | 'prices' | 'product-groups' | 'mo-serials' | 'standard',
    boolean
  > & Partial<Record<
    'manufacturing-pick-batch-v1' | 'manufacturing-operation-completion-v1',
    boolean
  >>;
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

  const buildIdentities = computeBuildIdentities();

  return {
    companyId,
    apiKey,
    baseUrl:
      process.env.INFLOW_BASE_URL || 'https://cloudapi.inflowinventory.com',
    apiVersion: process.env.INFLOW_API_VERSION || '2026-04-13',
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
    readRetryBudgetMs: parseInt(process.env.INFLOW_READ_RETRY_BUDGET || '30000', 10),
    debug: process.env.INFLOW_DEBUG === 'true',
    safeWritesEnabled: process.env.INFLOW_ENABLE_SAFE_WRITES === 'true',
    stockWritesEnabled: process.env.INFLOW_ENABLE_STOCK_WRITES === 'true',
    enableManufacturingWrites:
      process.env.INFLOW_ENABLE_MANUFACTURING_WRITES === 'true',
    stateDir: process.env.INFLOW_STATE_DIR || `${process.env.XDG_STATE_HOME || `${process.env.HOME || '/tmp'}/.local/state`}/inflow-mcp`,
    // These are derived from the running source/dist artifacts. Optional env
    // values are assertions for deployment tooling, never authority to choose
    // an identity that survives code drift.
    adapterManifestHash: verifyBuildIdentityOverride('INFLOW_ADAPTER_MANIFEST_HASH', process.env.INFLOW_ADAPTER_MANIFEST_HASH, buildIdentities.adapterManifestHash),
    probeBuild: verifyBuildIdentityOverride('INFLOW_PROBE_BUILD', process.env.INFLOW_PROBE_BUILD, buildIdentities.probeBuild),
    enableLegacyWrites: process.env.INFLOW_ENABLE_LEGACY_WRITES === 'true',
    writeGates: {
      // Compatibility/diagnostic state only. Product BOM/config adapters use
      // exact-scope confirmation and never resolve this gate.
      manufacturing: process.env.INFLOW_ENABLE_MANUFACTURING_WRITES === 'true',
      'manufacturing-pick-batch-v1':
        process.env.INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES === 'true',
      'manufacturing-operation-completion-v1':
        process.env.INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES ===
        'true',
      prices: process.env.INFLOW_ENABLE_PRICE_WRITES === 'true',
      'product-groups': process.env.INFLOW_ENABLE_PRODUCT_GROUP_WRITES === 'true',
      'mo-serials': process.env.INFLOW_ENABLE_MO_SERIAL_WRITES === 'true',
      standard: process.env.INFLOW_ENABLE_STANDARD_WRITES === 'true',
    },
  };
}
