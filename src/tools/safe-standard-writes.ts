import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { assertCapability } from '../core/capabilities.js';
import { canonicalHash, stableStringify } from '../core/canonical-json.js';
import { executeMutation, type MutationAdapter, type MutationControl } from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { textResult } from '../core/results.js';
import { normalizeDecimal } from '../core/decimal.js';
import { assertSafeWriteAuthorized, getSafeWritePolicy } from '../core/write-policy.js';
import { loadCustomFieldKinds, type CustomFieldKinds } from './custom-field-kinds.js';

type JsonRow = Record<string, unknown>;
interface StandardInput extends MutationControl {
  mode: 'patch' | 'replace';
  values: JsonRow;
  [key: string]: unknown;
}

interface ReceiptInput extends MutationControl {
  purchaseOrderId: string;
  action: 'receive' | 'unreceive';
  receiveLines: JsonRow[];
}

interface WebhookDeleteInput extends MutationControl {
  webhookId: string;
}

interface WebhookDeleteState {
  webhookId: string;
  absent: boolean;
  webhook?: JsonRow;
}

interface Definition {
  tool: string;
  resourceType: string;
  idField: string;
  wireIdField: string;
  endpoint: string;
  writableFields: string[];
  requiredCreateFields: string[];
  include?: string[];
  plannedRows?: { field: string; idField: string };
  customFieldEntity?: string;
  decimalPaths?: string[];
  adapterVersion: string;
  providesTimestamp?: false;
  tags(id?: string): string[];
}

const QUANTITY_DECIMAL_PATHS = (field: string) => [`${field}[].quantity.standardQuantity`, `${field}[].quantity.uomQuantity`];
const ORDER_LINE_DECIMAL_PATHS = ['lines[].unitPrice', 'lines[].subTotal', 'lines[].tax1Rate', 'lines[].tax2Rate', ...QUANTITY_DECIMAL_PATHS('lines')];

const PRODUCT_DEFINITION: Definition = {
  tool: 'set_product', resourceType: 'product', idField: 'productId', wireIdField: 'productId', endpoint: '/products',
  writableFields: ['name', 'description', 'sku', 'categoryId', 'isActive', 'weight', 'customFields'], requiredCreateFields: ['name'], customFieldEntity: 'product', decimalPaths: ['weight'],
  adapterVersion: 'product/safe-v5',
  tags: (id) => [`product:${id ?? 'new'}`, `bom:${id ?? 'new'}`],
};

const LEGACY_PRODUCT_ADAPTER_VERSIONS = new Set(['product/safe-v2', 'product/safe-v3', 'product/safe-v4']);

const LEGACY_PRODUCT_DEFINITION: Definition = {
  ...PRODUCT_DEFINITION,
  writableFields: ['name', 'description', 'barcode', 'sku', 'categoryId', 'isActive', 'cost', 'reorderPoint', 'reorderQuantity', 'weight', 'weightUnit', 'customFields'],
};

const PRODUCT_UNSUPPORTED_FIELDS: Record<string, string> = {
  barcode: 'barcodes are productBarcodes[] rows rather than a product property (read them with include=productBarcodes); no bounded barcode writer exists yet',
  cost: 'cost is the read-only ProductCost relation (read it with include=cost) that inFlow maintains from purchase-order receipts; a target unit cost is written through PUT /product-cost-adjustments (unitCost), which has no bounded MCP writer yet',
  reorderPoint: 'reorder thresholds are per-location reorderSettings[] rows rather than a product property (read them with include=reorderSettings)',
  reorderQuantity: 'reorder thresholds are per-location reorderSettings[] rows rather than a product property (read them with include=reorderSettings)',
  weightUnit: 'the weight unit is a company-wide inFlow setting rather than a product property',
};

const DEFINITIONS: Definition[] = [
  PRODUCT_DEFINITION,
  {
    tool: 'set_sales_order', resourceType: 'sales-order', idField: 'salesOrderId', wireIdField: 'salesOrderId', endpoint: '/sales-orders',
    writableFields: ['orderNumber', 'orderDate', 'dueDate', 'requestedShipDate', 'customerId', 'locationId', 'contactName', 'email', 'phone', 'poNumber', 'billingAddress', 'shippingAddress', 'sameBillingAndShipping', 'shipToCompanyName', 'pricingSchemeId', 'taxingSchemeId', 'paymentTermsId', 'currencyId', 'exchangeRate', 'isTaxInclusive', 'isQuote', 'isPrioritized', 'isCancelled', 'isCompleted', 'assignedToTeamMemberId', 'salesRepTeamMemberId', 'lines', 'orderRemarks', 'pickRemarks', 'packRemarks', 'shipRemarks', 'customFields'], requiredCreateFields: ['customerId'], include: ['lines'], plannedRows: { field: 'lines', idField: 'salesOrderLineId' }, customFieldEntity: 'salesOrder', decimalPaths: ['exchangeRate', ...ORDER_LINE_DECIMAL_PATHS], adapterVersion: 'sales-order/safe-v5',
    tags: (id) => [`sales-order:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_purchase_order', resourceType: 'purchase-order', idField: 'purchaseOrderId', wireIdField: 'purchaseOrderId', endpoint: '/purchase-orders',
    writableFields: ['orderNumber', 'orderDate', 'dueDate', 'requestShipDate', 'vendorId', 'vendorOrderNumber', 'locationId', 'contactName', 'email', 'phone', 'carrier', 'vendorAddress', 'shipToAddress', 'shipToCompanyName', 'taxingSchemeId', 'paymentTermsId', 'currencyId', 'exchangeRate', 'isTaxInclusive', 'isQuote', 'isCancelled', 'isCompleted', 'assignedToTeamMemberId', 'lines', 'orderRemarks', 'receiveRemarks', 'customFields'], requiredCreateFields: ['vendorId'], include: ['lines'], plannedRows: { field: 'lines', idField: 'purchaseOrderLineId' }, customFieldEntity: 'purchaseOrder', decimalPaths: ['exchangeRate', ...ORDER_LINE_DECIMAL_PATHS, 'lines[].productHeight', 'lines[].productLength', 'lines[].productWeight', 'lines[].productWidth'], adapterVersion: 'purchase-order/safe-v5',
    tags: (id) => [`purchase-order:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_customer', resourceType: 'customer', idField: 'customerId', wireIdField: 'customerId', endpoint: '/customers',
    writableFields: ['name', 'contactName', 'email', 'phone', 'fax', 'website', 'pricingSchemeId', 'taxingSchemeId', 'taxExemptNumber', 'discount', 'defaultPaymentTermsId', 'defaultPaymentMethod', 'defaultCarrier', 'defaultLocationId', 'defaultSalesRep', 'defaultSalesRepTeamMemberId', 'defaultBillingAddressId', 'defaultShippingAddressId', 'remarks', 'customFields', 'isActive'], requiredCreateFields: ['name'], customFieldEntity: 'customer', decimalPaths: ['discount'], adapterVersion: 'customer/safe-v5',
    tags: (id) => [`customer:${id ?? 'new'}`],
  },
  {
    tool: 'set_vendor', resourceType: 'vendor', idField: 'vendorId', wireIdField: 'vendorId', endpoint: '/vendors',
    writableFields: ['name', 'contactName', 'email', 'phone', 'fax', 'website', 'currencyId', 'taxingSchemeId', 'isTaxInclusivePricing', 'leadTimeDays', 'discount', 'defaultPaymentTermsId', 'defaultPaymentMethod', 'defaultCarrier', 'defaultAddressId', 'remarks', 'customFields', 'isActive'], requiredCreateFields: ['name'], customFieldEntity: 'vendor', decimalPaths: ['discount'], adapterVersion: 'vendor/safe-v5',
    tags: (id) => [`vendor:${id ?? 'new'}`],
  },
  {
    tool: 'set_stock_adjustment', resourceType: 'stock-adjustment', idField: 'stockAdjustmentId', wireIdField: 'stockAdjustmentId', endpoint: '/stock-adjustments',
    writableFields: ['date', 'locationId', 'adjustmentReasonId', 'lines', 'remarks', 'isCancelled', 'customFields'], requiredCreateFields: ['locationId', 'lines'], include: ['lines'], plannedRows: { field: 'lines', idField: 'stockAdjustmentLineId' }, customFieldEntity: 'stockAdjustment', decimalPaths: QUANTITY_DECIMAL_PATHS('lines'), adapterVersion: 'stock-adjustment/safe-v5',
    tags: (id) => [`stock-adjustment:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_stock_transfer', resourceType: 'stock-transfer', idField: 'stockTransferId', wireIdField: 'stockTransferId', endpoint: '/stock-transfers',
    writableFields: ['transferNumber', 'transferDate', 'sentDate', 'receivedDate', 'fromLocationId', 'toLocationId', 'status', 'assignedToTeamMemberId', 'lines', 'remarks', 'isCancelled', 'customFields'], requiredCreateFields: ['fromLocationId', 'toLocationId', 'lines'], include: ['lines'], plannedRows: { field: 'lines', idField: 'stockTransferLineId' }, customFieldEntity: 'stockTransfer', decimalPaths: QUANTITY_DECIMAL_PATHS('lines'), adapterVersion: 'stock-transfer/safe-v5',
    tags: (id) => [`stock-transfer:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_stock_count', resourceType: 'stock-count', idField: 'stockCountId', wireIdField: 'stockCountId', endpoint: '/stock-counts',
    writableFields: ['stockCountNumber', 'locationId', 'assignedToTeamMemberId', 'startedDate', 'completedDate', 'isStarted', 'isPrepared', 'isReviewed', 'isCompleted', 'isCancelled', 'remarks'], requiredCreateFields: ['locationId'], adapterVersion: 'stock-count/safe-v2',
    tags: (id) => [`stock-count:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_manufacturing_order', resourceType: 'manufacturing-order', idField: 'manufacturingOrderId', wireIdField: 'manufacturingOrderId', endpoint: '/manufacturing-orders',
    writableFields: ['manufacturingOrderNumber', 'orderDate', 'dueDate', 'locationId', 'primaryFinishedProductId', 'assignedToTeamMemberId', 'isPrioritized', 'lines', 'pickLines', 'pickMatchings', 'putLines', 'remarks', 'pickRemarks', 'putAwayRemarks', 'isCancelled', 'isCompleted', 'customFields'], requiredCreateFields: ['primaryFinishedProductId', 'lines'], include: ['lines', 'pickLines', 'pickMatchings', 'putLines'], customFieldEntity: 'manufacturingOrder', decimalPaths: [...QUANTITY_DECIMAL_PATHS('lines'), ...QUANTITY_DECIMAL_PATHS('pickLines'), ...QUANTITY_DECIMAL_PATHS('putLines'), 'pickMatchings[].matchedQuantity', 'lines[].manufacturingOrderOperations[].cost', 'lines[].manufacturingOrderOperations[].estimatedPerHourCost', 'lines[].manufacturingOrderOperations[].estimatedSeconds'], adapterVersion: 'manufacturing-order/safe-v5',
    tags: (id) => [`mo:${id ?? 'new'}`, 'inventory:stock'],
  },
  {
    tool: 'set_taxing_scheme', resourceType: 'taxing-scheme', idField: 'taxingSchemeId', wireIdField: 'taxingSchemeId', endpoint: '/taxing-schemes',
    writableFields: ['name', 'isDefault', 'isActive', 'calculateTax2OnTax1', 'defaultTaxCodeId', 'tax1Name', 'tax2Name', 'tax1OnShipping', 'tax2OnShipping'], requiredCreateFields: ['name'], adapterVersion: 'taxing-scheme/safe-v2',
    tags: (id) => [`taxing-scheme:${id ?? 'new'}`],
  },
  {
    tool: 'set_webhook', resourceType: 'webhook', idField: 'webhookId', wireIdField: 'webHookSubscriptionId', endpoint: '/webhooks',
    writableFields: ['url', 'events'], requiredCreateFields: ['url', 'events'], providesTimestamp: false, adapterVersion: 'webhook/safe-v2',
    tags: (id) => [`webhook:${id ?? 'new'}`],
  },
];

const PRODUCT_DEDICATED_FIELDS = new Set([
  'defaultPrice', 'price', 'prices', 'pricingSchemeId', 'productPriceId',
  'productGroupId', 'productVariantId', 'productVariants', 'options', 'optionValues',
  'bom', 'boms', 'billOfMaterials', 'components', 'itemBoms', 'manufacturing',
  'manufacturingConfig', 'manufacturingConfiguration', 'productOperations',
  'productOperation', 'autoAssemble', 'includeQuantityBuildable',
  'productVariant', 'settings', 'removeItemBomIds', 'removeProductOperationIds',
]);

const PROVIDER_METADATA_FIELDS = new Set([
  'timestamp', 'createdDate', 'modifiedDate', 'lastModifiedDateTime', 'lastModifiedById',
]);

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as JsonRow).filter(([, child]) => child !== undefined).map(([key, child]) => [key, compact(child)]));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_NUMERIC_VALUE');
    return normalizeDecimal(value);
  }
  return value;
}

function isJsonRow(value: unknown): value is JsonRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergePatchCustomFields(
  input: StandardInput,
  current: JsonRow | undefined,
  values: JsonRow,
  definition: Definition
): JsonRow {
  if (
    !definition.writableFields.includes('customFields') ||
    input.mode !== 'patch' ||
    !Object.prototype.hasOwnProperty.call(values, 'customFields')
  ) {
    return values;
  }

  const patch = values.customFields;
  if (!isJsonRow(patch)) {
    throw new Error('INVALID_CUSTOM_FIELDS: patch customFields must be an object');
  }

  const existing = current?.customFields;
  if (existing !== undefined && existing !== null && !isJsonRow(existing)) {
    throw new Error('INVALID_CURRENT_CUSTOM_FIELDS: provider customFields must be an object');
  }

  return {
    ...values,
    // Patch keys overwrite the same keys, including explicit falsy and null
    // values. Omitted keys are preserved. Deleting a key is intentionally not
    // supported by patch mode; use replace mode for whole-object semantics.
    customFields: { ...(existing ?? {}), ...patch },
  };
}

function standardDispatchBody(
  input: StandardInput,
  current: JsonRow | undefined,
  desired: JsonRow,
  definition: Definition
): JsonRow {
  if (definition.tool !== 'set_product' || input.mode !== 'patch' || !current) return desired;

  const currentId = current[definition.wireIdField];
  const desiredId = desired[definition.wireIdField];
  if (typeof currentId !== 'string' || currentId !== desiredId) {
    throw new Error('MUTATION_IDENTITY_MISMATCH: current product does not match the requested product');
  }
  if (typeof current.name !== 'string' || !current.name) {
    throw new Error('MUTATION_PRECONDITION_REQUIRED: product name');
  }
  if (typeof current.timestamp !== 'string' || !current.timestamp) {
    throw new Error('MUTATION_PRECONDITION_REQUIRED: product timestamp');
  }

  const body: JsonRow = {
    [definition.wireIdField]: currentId,
    name: current.name,
    timestamp: current.timestamp,
  };
  for (const field of Object.keys(input.values)) {
    body[field] = desired[field];
  }
  return compact(body) as JsonRow;
}

const CHECKBOX_TEXT = /^(?:true|false)$/i;
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?(?:Z|\+00:00)?)?$/;
const PROVIDER_DATE_ONLY = /^(\d{2})\/(\d{2})\/(\d{4}) 00:00:00$/;

function calendarDate(year: string, month: string, day: string): string | undefined {
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const roundTrips = parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day);
  return roundTrips ? `${year}-${month}-${day}` : undefined;
}

function canonicalCheckbox(value: unknown): unknown {
  if (typeof value === 'string' && CHECKBOX_TEXT.test(value)) return value.toLowerCase() === 'true';
  return compact(value);
}

function canonicalDate(value: unknown): unknown {
  if (typeof value !== 'string') return compact(value);
  const isoDate = ISO_DATE_ONLY.exec(value);
  if (isoDate) return calendarDate(isoDate[1], isoDate[2], isoDate[3]) ?? value;
  const providerDate = PROVIDER_DATE_ONLY.exec(value);
  if (providerDate) return calendarDate(providerDate[3], providerDate[1], providerDate[2]) ?? value;
  return value;
}

function canonicalCustomFieldValue(kind: string | undefined, value: unknown): unknown {
  if (kind === 'checkbox') return canonicalCheckbox(value);
  if (kind === 'date') return canonicalDate(value);
  return compact(value);
}

function canonicalCustomFields(value: JsonRow, kinds: CustomFieldKinds): JsonRow {
  if (!isJsonRow(value.customFields)) return value;
  const customFields = Object.fromEntries(
    Object.entries(value.customFields).map(([key, child]) => [key, canonicalCustomFieldValue(kinds[key], child)])
  );
  return { ...value, customFields };
}

function projected(value: JsonRow, definition: Definition, nullMissing = true): JsonRow {
  return Object.fromEntries([
    [definition.wireIdField, value[definition.wireIdField] ?? null],
    ...definition.writableFields.map((field) => [field, Object.prototype.hasOwnProperty.call(value, field) ? value[field] : null]),
  ].filter(([, child]) => nullMissing || child !== null));
}

function canonicalDecimalAt(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return canonicalScalar(value);
  const [segment, ...rest] = segments;
  if (segment.endsWith('[]')) {
    const field = segment.slice(0, -2);
    if (!isJsonRow(value) || !Array.isArray(value[field])) return value;
    const rows = value[field].map((row) => canonicalDecimalAt(row, rest));
    return { ...value, [field]: rows };
  }
  if (!isJsonRow(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return value;
  return { ...value, [segment]: canonicalDecimalAt(value[segment], rest) };
}

function canonicalDecimalPaths(value: JsonRow, definition: Definition): JsonRow {
  const decimalPaths = definition.decimalPaths ?? [];
  return decimalPaths.reduce<JsonRow>((current, path) => canonicalDecimalAt(current, path.split('.')) as JsonRow, value);
}

function semantic(value: JsonRow, definition?: Definition, kinds: CustomFieldKinds = {}) {
  if (definition) return withoutProviderMetadata(canonicalDecimalPaths(canonicalCustomFields(projected(value, definition), kinds), definition));
  const omit = new Set(['timestamp', 'createdDate', 'modifiedDate']);
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => !omit.has(key) && child !== undefined).map(([key, child]) => [key, compact(child)]));
}

export function productWriteSemantic(
  value: Record<string, unknown>,
  kinds: CustomFieldKinds = {},
  adapterVersion: string = PRODUCT_DEFINITION.adapterVersion
): unknown {
  const definition = LEGACY_PRODUCT_ADAPTER_VERSIONS.has(adapterVersion) ? LEGACY_PRODUCT_DEFINITION : PRODUCT_DEFINITION;
  return semantic(value, definition, kinds);
}

const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

function canonicalScalar(value: unknown): unknown {
  if (typeof value === 'string' && DECIMAL_TEXT.test(value)) return normalizeDecimal(value);
  return compact(value);
}

function requestedShape(actual: unknown, requested: unknown): unknown {
  if (Array.isArray(requested)) {
    if (!Array.isArray(actual)) return canonicalScalar(actual);
    return requested.map((row, index) => requestedShape(actual[index], row));
  }
  if (isJsonRow(requested)) {
    if (!isJsonRow(actual)) return canonicalScalar(actual);
    return Object.fromEntries(
      Object.keys(requested)
        .map((key) => [key, requestedShape(actual[key], requested[key])] as const)
        .filter(([, child]) => child !== undefined)
    );
  }
  return canonicalScalar(actual);
}

function withoutProviderMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProviderMetadata);
  if (!value || typeof value !== 'object') return compact(value);
  return Object.fromEntries(Object.entries(value as JsonRow)
    .filter(([key, child]) => !PROVIDER_METADATA_FIELDS.has(key) && child !== undefined)
    .map(([key, child]) => [key, withoutProviderMetadata(child)]));
}

export function productObservedSemantic(value: Record<string, unknown>): unknown {
  return withoutProviderMetadata(value);
}

function writeShape(value: JsonRow | undefined, definition: Definition): unknown {
  if (!value) return null;
  const identities = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(identities);
    if (!child || typeof child !== 'object') return compact(child);
    return Object.fromEntries(Object.entries(child as JsonRow)
      .filter(([key]) => /(?:Id|Ids|timestamp)$/.test(key))
      .map(([key, nested]) => [key, identities(nested)]));
  };
  return {
    ...(compact(projected(value, definition)) as JsonRow),
    timestamp: value.timestamp ?? null,
    nestedIdentities: identities(projected(value, definition)),
  };
}

function validateValues(input: StandardInput, current: JsonRow | undefined, desired: JsonRow, definition: Definition): void {
  if (definition.tool === 'set_product') {
    const dedicated = Object.keys(input.values).filter((key) => PRODUCT_DEDICATED_FIELDS.has(key));
    if (dedicated.length) {
      throw new Error(`OPERATION_UNSUPPORTED: generic product writes cannot change fields owned by dedicated price, group, or BOM tools: ${dedicated.sort().join(',')}`);
    }
    if (Object.prototype.hasOwnProperty.call(input.values, 'customFields') && !isJsonRow(input.values.customFields)) {
      throw new Error('INVALID_CUSTOM_FIELDS: customFields must be an object');
    }
    const unsupported = Object.keys(input.values).filter((key) => Object.prototype.hasOwnProperty.call(PRODUCT_UNSUPPORTED_FIELDS, key)).sort();
    if (unsupported.length) {
      const reasons = unsupported.map((key) => `${key}: ${PRODUCT_UNSUPPORTED_FIELDS[key]}`).join('; ');
      throw new Error(`OPERATION_UNSUPPORTED: the product PUT ignores these fields, so generic product writes reject them: ${unsupported.join(',')} (${reasons})`);
    }
  }
  const allowed = new Set(definition.writableFields);
  const unknown = Object.keys(input.values).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`UNSUPPORTED_WRITABLE_FIELDS: ${unknown.sort().join(',')}`);
  if (!current) {
    const missing = definition.requiredCreateFields.filter((field) => desired[field] === undefined || desired[field] === null || desired[field] === '');
    if (missing.length) throw new Error(`MISSING_REQUIRED_CREATE_FIELDS: ${missing.join(',')}`);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | undefined)?.statusCode === 404;
}

async function getOptional(client: InflowClient, path: string, include?: string[]): Promise<JsonRow | undefined> {
  try {
    return await client.get<JsonRow>(path, include ? { include } : undefined);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function writableReceiptLine(value: JsonRow): JsonRow {
  return Object.fromEntries([
    ['purchaseOrderReceiveLineId', value.purchaseOrderReceiveLineId],
    ['productId', value.productId],
    ['quantity', value.quantity],
    ['locationId', value.locationId],
    ['sublocation', value.sublocation],
    ['receiveDate', value.receiveDate],
    ['timestamp', value.timestamp],
  ].filter(([, child]) => child !== undefined).map(([key, child]) => [key, compact(child)]));
}

function canonicalReceiptLine(value: JsonRow): JsonRow {
  const writable = writableReceiptLine(value);
  delete writable.timestamp;
  return writable;
}

function receiptSemantic(value: JsonRow): unknown {
  const receiveLines = Array.isArray(value.receiveLines)
    ? value.receiveLines.map((row) => canonicalReceiptLine(row as JsonRow)).sort((left, right) =>
        String(left.purchaseOrderReceiveLineId ?? '').localeCompare(String(right.purchaseOrderReceiveLineId ?? '')))
    : [];
  return {
    purchaseOrderId: value.purchaseOrderId,
    receiveLines,
    unstockLines: withoutProviderMetadata(Array.isArray(value.unstockLines) ? value.unstockLines : []),
  };
}

function receiptWriteShape(value: JsonRow | undefined): unknown {
  if (!value) return null;
  return {
    ...receiptSemantic(value) as JsonRow,
    timestamp: value.timestamp ?? null,
  };
}

function validateReceiptQuantity(value: unknown, index: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}].quantity must be an exact quantity object`);
  }
  const quantity = value as JsonRow;
  const allowed = new Set(['standardQuantity', 'uomQuantity', 'uom', 'serialNumbers']);
  const unknown = Object.keys(quantity).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}].quantity has unsupported fields: ${unknown.sort().join(',')}`);
  }
  const standard = Number(quantity.standardQuantity);
  const uom = Number(quantity.uomQuantity);
  if (!Number.isFinite(standard) || standard <= 0 || !Number.isFinite(uom) || uom <= 0) {
    throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}].quantity requires positive standardQuantity and uomQuantity`);
  }
  if (quantity.serialNumbers !== undefined &&
      (!Array.isArray(quantity.serialNumbers) || quantity.serialNumbers.some((serial) => typeof serial !== 'string' || !serial))) {
    throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}].quantity.serialNumbers must contain non-empty strings`);
  }
}

function validateReceiptInput(input: ReceiptInput, current: JsonRow | undefined): void {
  if (!current) throw new Error(`PURCHASE_ORDER_NOT_FOUND: ${input.purchaseOrderId}`);
  if (typeof current.timestamp !== 'string' || !current.timestamp) {
    throw new Error('MUTATION_PRECONDITION_REQUIRED: purchase order timestamp');
  }
  const seen = new Set<string>();
  for (const [index, row] of input.receiveLines.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}] must be an object`);
    }
    const allowed = input.action === 'receive'
      ? new Set(['productId', 'quantity'])
      : new Set(['purchaseOrderReceiveLineId']);
    const unknown = Object.keys(row).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new Error(`OPERATION_UNSUPPORTED: ${input.action} row ${index} must use exact ${input.action === 'receive' ? 'productId+quantity' : 'purchaseOrderReceiveLineId'} fields; got ${unknown.sort().join(',')}`);
    }
    if (input.action === 'receive') {
      if (typeof row.productId !== 'string' || !row.productId || row.quantity === undefined) {
        throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}] requires exact productId and quantity`);
      }
      validateReceiptQuantity(row.quantity, index);
      continue;
    }
    const id = row.purchaseOrderReceiveLineId;
    if (typeof id !== 'string' || !id) {
      throw new Error(`OPERATION_UNSUPPORTED: receiveLines[${index}] requires purchaseOrderReceiveLineId`);
    }
    if (seen.has(id)) throw new Error(`OPERATION_UNSUPPORTED: duplicate purchaseOrderReceiveLineId ${id}`);
    seen.add(id);
  }
  if (input.action === 'unreceive') {
    const existing = new Set((Array.isArray(current.receiveLines) ? current.receiveLines : [])
      .map((row) => (row as JsonRow).purchaseOrderReceiveLineId)
      .filter((id): id is string => typeof id === 'string'));
    const missing = [...seen].filter((id) => !existing.has(id));
    if (missing.length) throw new Error(`RECEIVE_LINE_NOT_FOUND: ${missing.sort().join(',')}`);
  }
}

function desiredReceiptState(
  input: ReceiptInput,
  current: JsonRow,
  plannedIds: Record<string, string[]>
): JsonRow {
  const existing = (Array.isArray(current.receiveLines) ? current.receiveLines : [])
    .map((row) => writableReceiptLine(row as JsonRow));
  let receiveLines: JsonRow[];
  if (input.action === 'receive') {
    const receiptLineIds = plannedIds.receiptLineIds ?? [];
    if (receiptLineIds.length !== input.receiveLines.length) {
      throw new Error('MISSING_PLANNED_RECEIPT_LINE_IDS');
    }
    receiveLines = [
      ...existing,
      ...input.receiveLines.map((row, index) => ({
        purchaseOrderReceiveLineId: receiptLineIds[index],
        productId: row.productId,
        quantity: compact(row.quantity),
      })),
    ];
  } else {
    const removeIds = new Set(input.receiveLines.map((row) => row.purchaseOrderReceiveLineId as string));
    receiveLines = existing.filter((row) => !removeIds.has(row.purchaseOrderReceiveLineId as string));
  }
  return {
    purchaseOrderId: input.purchaseOrderId,
    ...(current.vendorId !== undefined ? { vendorId: current.vendorId } : {}),
    receiveLines,
    unstockLines: compact(Array.isArray(current.unstockLines) ? current.unstockLines : []),
    timestamp: current.timestamp,
  };
}

function applyPlannedRowIds(values: JsonRow, definition: Definition, plannedIds: Record<string, string[]>): JsonRow {
  if (!definition.plannedRows) return values;
  const { field, idField } = definition.plannedRows;
  const rows = values[field];
  if (!Array.isArray(rows)) return values;
  const planned = plannedIds.rowIds ?? [];
  let index = 0;
  return {
    ...values,
    [field]: rows.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`INVALID_NESTED_ROWS: ${field}`);
      const row = raw as JsonRow;
      return row[idField] ? { ...row } : { ...row, [idField]: planned[index++] };
    }),
  };
}

export function registerSafeStandardWriteTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  for (const definition of DEFINITIONS) {
    const policy = getSafeWritePolicy(definition.tool);
    const schema = {
      [definition.idField]: z.string().min(1).optional(),
      mode: z.enum(['patch', 'replace']).default('patch'),
      values: z.record(z.string(), z.unknown()).default({}),
      dryRun: z.boolean().default(true), previewToken: z.string().optional(), idempotencyKey: z.string().min(1).optional(),
      expectedSemanticHash: z.string().optional(), expectedWriteShapeHash: z.string().optional(), expectedEntityTimestamp: z.string().optional(), expectedDesiredHash: z.string().optional(),
    };
    const description = policy.staticSupport
      ? `Preview or apply a bounded ${definition.resourceType} write with signed preconditions and verified readback.`
      : `Preview-first replacement for the deprecated immediate ${definition.resourceType} write. Apply remains unavailable until its domain adapter and canary are complete.`;
    server.tool(definition.tool, description, schema as any, async (raw: any) => {
      assertCapability('standard-writes.safe', config.apiVersion);
      const input = raw as StandardInput;
      const suppliedId = input[definition.idField] as string | undefined;
      let resolvedId = suppliedId;
      const kinds = definition.customFieldEntity ? await loadCustomFieldKinds(client, definition.customFieldEntity) : {};
      const adapter: MutationAdapter<StandardInput, JsonRow, JsonRow, JsonRow> = {
        operation: definition.tool,
        resourceType: definition.resourceType,
        resourceId: () => resolvedId,
        mode: (args) => args.mode,
        adapterVersion: definition.adapterVersion,
        isCreate: (_args, current) => current === undefined,
        read: async () => resolvedId
          ? getOptional(client, `${definition.endpoint}/${resolvedId}`, definition.include)
          : undefined,
        planIds: (args): Record<string, string[]> => {
          const ids: Record<string, string[]> = suppliedId ? {} : { resourceIds: [randomUUID()] };
          if (definition.plannedRows) {
            const rows = args.values[definition.plannedRows.field];
            ids.rowIds = Array.isArray(rows)
              ? rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row) && !(row as JsonRow)[definition.plannedRows!.idField]).map(() => randomUUID())
              : [];
          }
          return ids;
        },
        buildDesired: (args, current, planned) => {
          const id = suppliedId ?? planned.resourceIds?.[0];
          if (!id) throw new Error('MISSING_PLANNED_RESOURCE_ID');
          resolvedId = id;
          const base = args.mode === 'patch' ? projected(current ?? {}, definition, false) : {};
          const plannedValues = applyPlannedRowIds(args.values, definition, planned);
          const values = mergePatchCustomFields(args, current, plannedValues, definition);
          const desired = { ...base, ...values, [definition.wireIdField]: id };
          if (current?.timestamp) desired.timestamp = current.timestamp;
          return desired;
        },
        semantic: (value) => semantic(value, definition, kinds),
        inputHash: (args, current) => definition.tool === 'set_product' && current === undefined
          ? canonicalHash(compact(args.values), 'input/product-create/v1')
          : undefined,
        writeShape: (current) => writeShape(current, definition),
        sourceHashes: (_args, current): Record<string, string> => {
          if (definition.tool !== 'set_product' || !current) return {};
          return { productObserved: canonicalHash(productObservedSemantic(current), 'source/product-observed/v1') };
        },
        timestamp: (current) => typeof current?.timestamp === 'string' ? current.timestamp : undefined,
        output: (value) => projected(value, definition),
        validate: (args, current, desired) => validateValues(args, current, desired, definition),
        verifyReadback: (args, current, desired, actual) => {
          if (actual === undefined) return false;
          if (current === undefined) {
            const fields = [definition.wireIdField, ...Object.keys(compact(args.values) as JsonRow)];
            const requested = (value: JsonRow) => {
              const selected = Object.fromEntries(fields.map((field) => [field, value[field]]));
              if (isJsonRow(args.values.customFields) && isJsonRow(selected.customFields)) {
                const actualFields = selected.customFields;
                selected.customFields = Object.fromEntries(
                  Object.keys(compact(args.values.customFields) as JsonRow).map((field) => [field, actualFields[field]])
                );
              }
              return requestedShape(withoutProviderMetadata(canonicalCustomFields(selected, kinds)), { [definition.wireIdField]: null, ...args.values });
            };
            return stableStringify(requested(actual)) === stableStringify(requested(desired));
          }
          return stableStringify(semantic(actual, definition, kinds)) === stableStringify(semantic(desired, definition, kinds));
        },
        prepareDispatch: async (args, current, desired) => {
          const body = standardDispatchBody(args, current, desired, definition);
          const prepared = await client.prepareMutation<JsonRow>('PUT', definition.endpoint, { body });
          return prepared.dispatch;
        },
        dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
        affectedResources: (_args, desired) => [{ type: definition.resourceType, id: desired[definition.wireIdField] as string }],
        invalidationTags: (_args, desired) => definition.tags(desired[definition.wireIdField] as string),
        writesEnabled: policy.staticSupport,
        disabledCode: 'OPERATION_UNSUPPORTED',
        disabledMessage: policy.unsupportedReason ?? `The ${definition.resourceType} adapter has a bounded writable projection and readback contract, but apply remains disabled until its operation-specific release canary is complete.`,
        authorizeApply: () => assertSafeWriteAuthorized(config, definition.tool),
        requiresIdempotency: policy.idempotency === 'required'
          ? true
          : policy.idempotency === 'create-only'
            ? (_args, current) => current === undefined
            : false,
        requireTimestamp: suppliedId !== undefined && definition.providesTimestamp !== false,
      };
      return textResult(await executeMutation(createMutationRuntime(config), adapter, input));
    });
  }

  server.tool('set_purchase_order_receipts', 'Preview exact purchase-order receipt changes. Apply remains blocked until receipt/unreceipt stock semantics are canary-proven.', {
    purchaseOrderId: z.string().min(1), action: z.enum(['receive', 'unreceive']), receiveLines: z.array(z.record(z.string(), z.unknown())).min(1),
    receiveAll: z.unknown().optional(), unreceiveAll: z.unknown().optional(),
    items: z.unknown().optional(), receiveLineIds: z.unknown().optional(),
    dryRun: z.boolean().default(true), previewToken: z.string().optional(), idempotencyKey: z.string().min(1).optional(), expectedSemanticHash: z.string().optional(), expectedWriteShapeHash: z.string().optional(), expectedEntityTimestamp: z.string().optional(), expectedDesiredHash: z.string().optional(),
  }, async (raw) => {
    assertCapability('standard-writes.safe', config.apiVersion);
    for (const unsupported of ['receiveAll', 'unreceiveAll', 'items', 'receiveLineIds']) {
      if (Object.prototype.hasOwnProperty.call(raw, unsupported)) {
        throw new Error(`OPERATION_UNSUPPORTED: ${unsupported} is not supported by exact receipt replacement`);
      }
    }
    const policy = getSafeWritePolicy('set_purchase_order_receipts');
    const input = raw as ReceiptInput;
    const adapter: MutationAdapter<ReceiptInput, JsonRow, JsonRow, JsonRow> = {
      operation: 'set_purchase_order_receipts', resourceType: 'purchase-order-receipts', resourceId: () => input.purchaseOrderId, mode: () => input.action, adapterVersion: 'purchase-order-receipts/safe-v2',
      read: () => client.get<JsonRow>(`/purchase-orders/${raw.purchaseOrderId}`, { include: ['lines', 'receiveLines', 'unstockLines'] }),
      planIds: (args) => ({ receiptLineIds: args.action === 'receive' ? args.receiveLines.map(() => randomUUID()) : [] }),
      buildDesired: (args, current, plannedIds) => desiredReceiptState(args, current!, plannedIds),
      semantic: receiptSemantic,
      writeShape: receiptWriteShape,
      timestamp: (current) => typeof current?.timestamp === 'string' ? current.timestamp : undefined,
      output: (value) => receiptSemantic(value) as JsonRow,
      validate: (args, current) => validateReceiptInput(args, current),
      verifyReadback: (_args, _current, desired, actual) => actual !== undefined &&
        stableStringify(receiptSemantic(actual)) === stableStringify(receiptSemantic(desired)),
      prepareDispatch: async (_args, _current, desired) => {
        const prepared = await client.prepareMutation<JsonRow>('PUT', '/purchase-orders', { body: desired });
        return prepared.dispatch;
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: () => [{ type: 'purchase-order', id: input.purchaseOrderId }, { type: 'inventory' }],
      invalidationTags: () => [`purchase-order:${input.purchaseOrderId}`, 'inventory:stock'],
      writesEnabled: policy.staticSupport,
      disabledCode: 'OPERATION_UNSUPPORTED',
      disabledMessage: policy.unsupportedReason ?? 'Receipt apply requires an approved stock-safe release canary.',
      authorizeApply: () => assertSafeWriteAuthorized(config, 'set_purchase_order_receipts'),
      requiresIdempotency: true,
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, input));
  });

  server.tool('remove_webhook', 'Preview exact webhook removal. Apply remains blocked until delete/readback semantics are canary-proven.', {
    webhookId: z.string().min(1), dryRun: z.boolean().default(true), previewToken: z.string().optional(), idempotencyKey: z.string().min(1).optional(), expectedSemanticHash: z.string().optional(), expectedWriteShapeHash: z.string().optional(), expectedEntityTimestamp: z.string().optional(), expectedDesiredHash: z.string().optional(),
  }, async (raw) => {
    assertCapability('standard-writes.safe', config.apiVersion);
    const policy = getSafeWritePolicy('remove_webhook');
    const input = raw as WebhookDeleteInput;
    const adapter: MutationAdapter<WebhookDeleteInput, WebhookDeleteState, WebhookDeleteState, WebhookDeleteState> = {
      operation: 'remove_webhook', resourceType: 'webhook', resourceId: () => input.webhookId, mode: () => 'delete', adapterVersion: 'webhook-delete/safe-v2',
      isCreate: () => false,
      read: async () => {
        const webhook = await getOptional(client, `/webhooks/${input.webhookId}`);
        return webhook ? { webhookId: input.webhookId, absent: false, webhook } : undefined;
      },
      buildDesired: () => ({ webhookId: input.webhookId, absent: true }),
      semantic: (value) => value.absent
        ? { webhookId: value.webhookId, absent: true }
        : { webhookId: value.webhookId, absent: false, webhook: withoutProviderMetadata(value.webhook) },
      writeShape: (current) => current ? withoutProviderMetadata(current) : null,
      timestamp: () => undefined,
      output: (value) => value,
      isNoOp: (_args, current) => current === undefined,
      noOpResultCode: () => 'already_absent',
      verifyReadback: (_args, _current, _desired, actual) => actual === undefined,
      prepareDispatch: async () => {
        const prepared = await client.prepareMutation<JsonRow>('DELETE', `/webhooks/${input.webhookId}`);
        return prepared.dispatch;
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: () => [{ type: 'webhook', id: input.webhookId }],
      invalidationTags: () => [`webhook:${input.webhookId}`],
      writesEnabled: policy.staticSupport,
      disabledCode: 'OPERATION_UNSUPPORTED',
      disabledMessage: policy.unsupportedReason ?? 'Webhook deletion remains unsupported until provider absence/readback semantics pass a release canary.',
      authorizeApply: () => assertSafeWriteAuthorized(config, 'remove_webhook'),
      requiresIdempotency: false,
      requireTimestamp: false,
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, input));
  });
}
