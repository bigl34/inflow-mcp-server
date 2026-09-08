import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from './client/inflow.js';
import type { InflowConfig } from './config.js';
import { registerProductTools } from './tools/products.js';
import { registerProductManufacturingTools } from './tools/product-manufacturing.js';
import { registerProductGroupTools } from './tools/product-groups.js';
import { registerSalesOrderTools } from './tools/sales-orders.js';
import { registerPurchaseOrderTools } from './tools/purchase-orders.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerManufacturingOrderTools } from './tools/manufacturing-orders.js';
import { registerReferenceTools } from './tools/reference.js';
import { registerSerialTools } from './tools/serials.js';
import { registerOperationTypeTools } from './tools/operation-types.js';
import { registerStatusTools } from './tools/status.js';
import { registerProductPriceTools } from './tools/product-prices.js';
import { registerManufacturingCopyTool } from './tools/product-manufacturing-copy.js';
import { registerProductGroupAuditTools } from './tools/product-group-audit.js';
import { registerBomRequirementTools } from './tools/bom-requirements.js';
import { registerManufacturingOrderTraceTools } from './tools/manufacturing-order-trace.js';
import { registerProductGroupMutationTools } from './tools/product-group-mutations.js';
import { registerSafeStandardWriteTools } from './tools/safe-standard-writes.js';

export const LEGACY_WRITE_REPLACEMENTS = {
  upsert_product: 'set_product',
  upsert_sales_order: 'set_sales_order',
  upsert_purchase_order: 'set_purchase_order',
  receive_purchase_order: 'set_purchase_order_receipts',
  unreceive_purchase_order: 'set_purchase_order_receipts',
  upsert_customer: 'set_customer',
  upsert_vendor: 'set_vendor',
  upsert_stock_adjustment: 'set_stock_adjustment',
  upsert_stock_transfer: 'set_stock_transfer',
  upsert_stock_count: 'set_stock_count',
  upsert_manufacturing_order: 'set_manufacturing_order',
  upsert_taxing_scheme: 'set_taxing_scheme',
  upsert_webhook: 'set_webhook',
  delete_webhook: 'remove_webhook',
} as const;

type LegacyWriteTool = keyof typeof LEGACY_WRITE_REPLACEMENTS;
type ToolCallback = (...args: unknown[]) => unknown;

function isLegacyWriteTool(name: unknown): name is LegacyWriteTool {
  return typeof name === 'string' && name in LEGACY_WRITE_REPLACEMENTS;
}

function legacyWriteWarning(tool: LegacyWriteTool): string {
  return `[LEGACY IMMEDIATE WRITE — HIGH RISK: BYPASSES INFLOW_ENABLE_SAFE_WRITES] Use ${LEGACY_WRITE_REPLACEMENTS[tool]} instead. `;
}

function emitLegacyWriteTelemetry(tool: LegacyWriteTool): void {
  const replacement = LEGACY_WRITE_REPLACEMENTS[tool];
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'warn',
    severity: 'high',
    event: 'inflow_legacy_immediate_write_invoked',
    deprecated: true,
    tool,
    safeReplacement: replacement,
    bypassesSafeWriteGate: true,
    bypassedGate: 'INFLOW_ENABLE_SAFE_WRITES',
    gateEffect: 'not_enforced',
    message: `Legacy immediate write ${tool} bypasses INFLOW_ENABLE_SAFE_WRITES; the master gate controls only the safe preview/apply path. Migrate to ${replacement}.`,
  }));
}

/**
 * Wrap the legacy registrars at their common registration boundary. The
 * underlying tools remain callable, but their descriptions and every use make
 * the safe-write bypass explicit. No request arguments are logged.
 */
function withLegacyWriteTelemetry(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'tool') return Reflect.get(target, property, receiver);
      return (...registrationArgs: unknown[]) => {
        const tool = registrationArgs[0];
        if (!isLegacyWriteTool(tool)) {
          return Reflect.apply(target.tool, target, registrationArgs);
        }

        const callbackIndex = registrationArgs.length - 1;
        if (typeof registrationArgs[callbackIndex] !== 'function') {
          throw new Error(`LEGACY_WRITE_REGISTRATION_MISSING_CALLBACK: ${tool}`);
        }

        const wrappedArgs = [...registrationArgs];
        if (typeof wrappedArgs[1] === 'string') {
          wrappedArgs[1] = legacyWriteWarning(tool) + wrappedArgs[1];
        }
        const callback = wrappedArgs[callbackIndex] as ToolCallback;
        wrappedArgs[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
          emitLegacyWriteTelemetry(tool);
          return Reflect.apply(callback, this, callbackArgs);
        };
        return Reflect.apply(target.tool, target, wrappedArgs);
      };
    },
  });
}

export function registerAllTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  const legacyTelemetryServer = withLegacyWriteTelemetry(server);

  registerProductTools(legacyTelemetryServer, client);
  registerProductManufacturingTools(server, client, config);
  registerProductGroupTools(server, client, config.apiVersion);
  registerSalesOrderTools(legacyTelemetryServer, client);
  registerPurchaseOrderTools(legacyTelemetryServer, client);
  registerCustomerTools(legacyTelemetryServer, client);
  registerInventoryTools(legacyTelemetryServer, client);
  registerManufacturingOrderTools(legacyTelemetryServer, client);
  registerReferenceTools(legacyTelemetryServer, client);
  registerSerialTools(server, client);
  registerOperationTypeTools(server, client, config.apiVersion);
  registerStatusTools(server, client, config);
  registerProductPriceTools(server, client, config);
  registerManufacturingCopyTool(server, client, config);
  registerProductGroupAuditTools(server, client, config.apiVersion);
  registerBomRequirementTools(server, client, config.apiVersion);
  registerManufacturingOrderTraceTools(server, client, config);
  registerProductGroupMutationTools(server, client, config);
  registerSafeStandardWriteTools(server, client, config);
}
