# inFlow MCP Server Improvement Plan

> **ARCHIVED** - This plan was completed on 2025-12-28. All phases have been implemented.

## Overview

This plan covers implementing the following improvements to the inFlow MCP server:

1. **Sorting support** - Add `sort` and `sortDesc` parameters
2. **Smart search** - Add `filter[smart]` support
3. **Complex filters** - Support date ranges, numeric ranges, and arrays
4. **Include count** - Return total record count for pagination
5. **Negative inventory override** - Support `X-OverrideAllowNegativeInventory` header
6. **Manufacturing BOM auto-fill** - Support auto-filling from default BOM
7. **Webhook secret documentation** - Surface and document HMAC secret
8. **Custom field labels** - Add endpoint for custom field label management
9. **Request timeouts** - Prevent hanging requests
10. **Retry logic** - Handle transient failures
11. **Automated tests** - Add test coverage

---

## Phase 1: Client Infrastructure (Foundation)

These changes affect the core HTTP client and enable subsequent features.

### 1.1 Add Request Timeouts

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// Add to InflowConfig interface in config.ts
requestTimeoutMs?: number; // Default: 30000

// In InflowClient.request()
async request<T>(...): Promise<T> {
  await this.rateLimiter.acquire();

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    this.config.requestTimeoutMs ?? 30000
  );

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    // ... rest of handling
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**Error handling:**
```typescript
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') {
    throw new InflowApiError('Request timed out', 408);
  }
  throw error;
}
```

### 1.2 Add Retry Logic with Exponential Backoff

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// Add to config.ts
maxRetries?: number; // Default: 3
retryDelayMs?: number; // Default: 1000

// Add helper method
private isRetryableError(error: unknown): boolean {
  if (error instanceof InflowApiError) {
    // Retry on 5xx errors and 429 (rate limit)
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  // Retry on network errors
  return error instanceof TypeError && error.message.includes('fetch');
}

private async delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wrap request method
async request<T>(...): Promise<T> {
  const maxRetries = this.config.maxRetries ?? 3;
  const baseDelay = this.config.retryDelayMs ?? 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await this.executeRequest<T>(...);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !this.isRetryableError(error)) {
        throw error;
      }
      // Exponential backoff: 1s, 2s, 4s
      await this.delay(baseDelay * Math.pow(2, attempt));
    }
  }
  throw new Error('Unexpected retry loop exit');
}
```

### 1.3 Support Custom Headers

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// Extend request options
async request<T>(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    filters?: Record<string, unknown>; // Changed from simple types
    pagination?: PaginationParams;
    include?: string[];
    body?: unknown;
    headers?: Record<string, string>; // NEW
  }
): Promise<T> {
  // ...
  const fetchOptions: RequestInit = {
    method,
    headers: {
      ...this.getHeaders(),
      ...options?.headers, // Merge custom headers
    },
  };
}

// Add convenience method for PUT with headers
async putWithHeaders<T>(
  path: string,
  body: unknown,
  options?: {
    params?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
  }
): Promise<T> {
  return this.request<T>('PUT', path, { ...options, body });
}
```

### 1.4 Support Complex Filter Types

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// Update buildFilterParams to handle objects and arrays
private buildFilterParams(
  filters?: Record<string, unknown>
): Record<string, string> {
  const params: Record<string, string> = {};

  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      if (typeof value === 'object') {
        // Arrays and objects get JSON stringified
        params[`filter[${key}]`] = JSON.stringify(value);
      } else {
        params[`filter[${key}]`] = String(value);
      }
    }
  }

  return params;
}
```

### 1.5 Support Sorting Parameters

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// Extend options interface
interface RequestOptions {
  // ... existing
  sort?: string;
  sortDesc?: boolean;
}

// In request method, add to allParams:
if (options?.sort) {
  allParams.sort = options.sort;
}
if (options?.sortDesc !== undefined) {
  allParams.sortDesc = options.sortDesc;
}
```

### 1.6 Support Include Count

**File:** `src/client/inflow.ts`

**Changes:**
```typescript
// New response type for list operations
interface ListResponse<T> {
  data: T[];
  totalCount?: number;
}

// New method for list operations that need count
async getList<T>(
  path: string,
  options?: RequestOptions & { includeCount?: boolean }
): Promise<ListResponse<T>> {
  await this.rateLimiter.acquire();

  const allParams = { ...this.buildParams(options) };
  if (options?.includeCount) {
    allParams.includeCount = true;
  }

  const url = this.buildUrl(path, allParams);
  const response = await fetch(url, { method: 'GET', headers: this.getHeaders() });

  if (!response.ok) {
    // ... error handling
  }

  const data = await response.json() as T[];
  const totalCount = options?.includeCount
    ? parseInt(response.headers.get('X-listCount') ?? '0', 10)
    : undefined;

  return { data, totalCount };
}
```

---

## Phase 2: Update Type Definitions

**File:** `src/types/inflow.ts`

### 2.1 Add Sorting Types

```typescript
export interface SortParams {
  sort?: string;
  sortDesc?: boolean;
}

// Update PaginationParams or create QueryParams
export interface QueryParams extends PaginationParams, SortParams {
  includeCount?: boolean;
}
```

### 2.2 Add Date Range Filter Type

```typescript
export interface DateRangeFilter {
  fromDate?: string; // ISO date
  toDate?: string;   // ISO date
}

export interface NumericRangeFilter {
  from?: number;
  to?: number;
}
```

### 2.3 Update Filter Types

```typescript
// Example: Updated SalesOrderFilter
export interface SalesOrderFilter {
  orderNumber?: string;
  status?: OrderStatus | OrderStatus[]; // Support array
  customerId?: string;
  locationId?: string;
  orderDate?: DateRangeFilter; // Changed from two separate fields
  requiredDate?: DateRangeFilter;
  total?: NumericRangeFilter;
  balance?: NumericRangeFilter;
  smart?: string; // Smart search
}
```

### 2.4 Add Webhook Secret Type

```typescript
export interface WebhookCreateResponse extends Webhook {
  secret: string; // HMAC secret for signature verification
}
```

### 2.5 Add Custom Field Labels Type

```typescript
export interface CustomFieldLabels {
  entityType: CustomFieldEntityType;
  labels: {
    custom1?: string;
    custom2?: string;
    custom3?: string;
    custom4?: string;
    custom5?: string;
    custom6?: string;
    custom7?: string;
    custom8?: string;
    custom9?: string;
    custom10?: string;
  };
}
```

---

## Phase 3: Update Tool Implementations

### 3.1 Add Sorting to All List Tools

**Files:** All files in `src/tools/`

**Pattern for each list tool:**
```typescript
server.tool(
  'list_products',
  'Search and list products from inFlow Inventory with optional filtering',
  {
    // ... existing params
    sort: z.string().optional()
      .describe('Property to sort by (e.g., name, sku, modifiedDate)'),
    sortDesc: z.boolean().optional()
      .describe('Sort in descending order'),
    includeCount: z.boolean().optional()
      .describe('Include total record count in response'),
  },
  async (args) => {
    // ... existing filter building

    const result = await client.getList<Product[]>('/products', {
      filters,
      pagination,
      include: args.include,
      sort: args.sort,
      sortDesc: args.sortDesc,
      includeCount: args.includeCount,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          data: result.data,
          ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
        }, null, 2),
      }],
    };
  }
);
```

**Apply to these tools:**
- `list_products`
- `list_sales_orders`
- `list_purchase_orders`
- `list_customers`
- `list_vendors`
- `list_stock_adjustments`
- `list_stock_transfers`
- `list_stock_counts`
- `list_manufacturing_orders`
- `list_locations`
- `list_categories`

### 3.2 Add Smart Search to Relevant Tools

**Files:** `products.ts`, `sales-orders.ts`, `purchase-orders.ts`, `customers.ts`

```typescript
// In list_products
smart: z.string().optional()
  .describe('Smart search across multiple fields (name, description, SKU, barcode)'),

// In handler
if (args.smart) filters.smart = args.smart;
```

### 3.3 Update Date Range Filters

**File:** `src/tools/sales-orders.ts`

```typescript
// Before (two separate params):
orderDateFrom: z.string().optional(),
orderDateTo: z.string().optional(),

// After (structured object):
orderDate: z.object({
  fromDate: z.string().optional().describe('Start date (ISO format)'),
  toDate: z.string().optional().describe('End date (ISO format)'),
}).optional().describe('Filter by order date range'),

// In handler:
if (args.orderDate) {
  filters.orderDate = args.orderDate; // Client will JSON.stringify
}
```

**Apply to:**
- Sales orders: `orderDate`, `requiredDate`
- Purchase orders: `orderDate`, `expectedDate`
- Stock adjustments: `adjustmentDate`
- Stock transfers: `transferDate`
- Manufacturing orders: `orderDate`

### 3.4 Add Array Status Filters

**File:** `src/tools/sales-orders.ts`

```typescript
// Before:
status: z.enum(['Open', 'PartiallyFulfilled', ...]).optional(),

// After (support multiple):
status: z.union([
  z.enum(['Quote', 'Open', 'PartiallyFulfilled', 'Fulfilled', 'Cancelled', 'Closed']),
  z.array(z.enum(['Quote', 'Open', 'PartiallyFulfilled', 'Fulfilled', 'Cancelled', 'Closed'])),
]).optional().describe('Filter by status (single value or array)'),
```

### 3.5 Add Negative Inventory Override

**File:** `src/tools/inventory.ts`

```typescript
// In upsert_stock_adjustment
server.tool(
  'upsert_stock_adjustment',
  'Create or update a stock adjustment to add or remove inventory',
  {
    // ... existing params
    allowNegativeInventory: z.boolean().optional()
      .describe('Allow inventory to go negative (override default restriction)'),
  },
  async (args) => {
    const headers: Record<string, string> = {};
    if (args.allowNegativeInventory) {
      headers['X-OverrideAllowNegativeInventory'] = 'TRUE';
    }

    const result = await client.putWithHeaders<StockAdjustment>(
      '/stock-adjustments',
      adjustment,
      { headers }
    );
    // ...
  }
);
```

**Apply to:**
- `upsert_stock_adjustment`
- `upsert_stock_transfer`
- `upsert_sales_order` (for fulfillment)

### 3.6 Add Manufacturing BOM Auto-fill

**File:** `src/tools/inventory.ts`

```typescript
// In upsert_manufacturing_order
autofillFromBOM: z.boolean().optional()
  .describe('Auto-fill input items from product default bill of materials'),

// In handler:
const params: Record<string, boolean> = {};
if (args.autofillFromBOM) {
  params.autofillFromDefaultBillOfMaterials = true;
}

const result = await client.put<ManufacturingOrder>(
  '/manufacturing-orders',
  order,
  { params }
);
```

### 3.7 Update Webhook Tool for Secret

**File:** `src/tools/reference.ts`

```typescript
// Update upsert_webhook to use WebhookCreateResponse type
const result = await client.put<WebhookCreateResponse>('/webhooks', webhook);

// Update description
server.tool(
  'upsert_webhook',
  'Create or update a webhook subscription. When creating, returns a secret for HMAC signature verification (x-inflow-hmac-sha256 header).',
  // ...
);
```

### 3.8 Add Custom Field Labels Tool

**File:** `src/tools/reference.ts`

```typescript
// Get Custom Field Labels
server.tool(
  'get_custom_field_labels',
  'Get custom field display labels for an entity type',
  {
    entityType: z.enum([
      'Product', 'Customer', 'Vendor', 'SalesOrder',
      'PurchaseOrder', 'StockAdjustment', 'StockTransfer', 'ManufacturingOrder',
    ]).describe('The entity type'),
  },
  async (args) => {
    const labels = await client.get<CustomFieldLabels>(
      `/custom-fields/${args.entityType}`
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
    };
  }
);

// Update Custom Field Labels
server.tool(
  'upsert_custom_field_labels',
  'Update custom field display labels for an entity type',
  {
    entityType: z.enum([...]).describe('The entity type'),
    labels: z.object({
      custom1: z.string().optional(),
      custom2: z.string().optional(),
      custom3: z.string().optional(),
      custom4: z.string().optional(),
      custom5: z.string().optional(),
      custom6: z.string().optional(),
      custom7: z.string().optional(),
      custom8: z.string().optional(),
      custom9: z.string().optional(),
      custom10: z.string().optional(),
    }).describe('Label names for each custom field'),
  },
  async (args) => {
    const result = await client.put<CustomFieldLabels>(
      `/custom-fields/${args.entityType}`,
      { labels: args.labels }
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

---

## Phase 4: Configuration Updates

**File:** `src/config.ts`

```typescript
export interface InflowConfig {
  baseUrl: string;
  companyId: string;
  apiKey: string;
  apiVersion: string;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;  // NEW
  maxRetries: number;        // NEW
  retryDelayMs: number;      // NEW
  debug: boolean;            // NEW
}

export function loadConfig(): InflowConfig {
  // ... existing validation

  return {
    baseUrl: process.env.INFLOW_BASE_URL || 'https://cloudapi.inflowinventory.com',
    companyId: process.env.INFLOW_COMPANY_ID!,
    apiKey: process.env.INFLOW_API_KEY!,
    apiVersion: process.env.INFLOW_API_VERSION || '2025-06-24',
    rateLimitPerMinute: parseInt(process.env.INFLOW_RATE_LIMIT || '60', 10),
    requestTimeoutMs: parseInt(process.env.INFLOW_REQUEST_TIMEOUT || '30000', 10),
    maxRetries: parseInt(process.env.INFLOW_MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.INFLOW_RETRY_DELAY || '1000', 10),
    debug: process.env.INFLOW_DEBUG === 'true',
  };
}
```

---

## Phase 5: Add Debug Logging

**File:** `src/client/inflow.ts`

```typescript
private log(message: string, data?: unknown): void {
  if (this.config.debug) {
    console.error(`[inFlow] ${message}`, data ? JSON.stringify(data) : '');
  }
}

// Usage in request method:
this.log(`${method} ${path}`, { params: allParams });
// After response:
this.log(`Response ${response.status}`, { path });
// On retry:
this.log(`Retrying (attempt ${attempt + 1}/${maxRetries})`, { path, error: error.message });
```

---

## Phase 6: Testing

### 6.1 Setup

```bash
npm install -D vitest @vitest/coverage-v8
```

**File:** `vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

**File:** `package.json`
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 6.2 Test Files to Create

**File:** `src/__tests__/rate-limiter.test.ts`
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../client/inflow.js';

describe('RateLimiter', () => {
  it('should allow requests up to limit', async () => {
    const limiter = new RateLimiter(10);
    const start = Date.now();

    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
    }

    // Should complete quickly (no waiting)
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('should wait when tokens exhausted', async () => {
    const limiter = new RateLimiter(1); // 1 per minute
    await limiter.acquire(); // Use the one token

    const start = Date.now();
    await limiter.acquire(); // Should wait
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThan(500); // Should have waited
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(60); // 1 per second
    await limiter.acquire();

    await new Promise(r => setTimeout(r, 1100)); // Wait 1.1 seconds

    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(100); // Should not wait
  });
});
```

**File:** `src/__tests__/client.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InflowClient } from '../client/inflow.js';

describe('InflowClient', () => {
  describe('buildFilterParams', () => {
    it('should handle simple string filters', () => {
      // Test implementation
    });

    it('should JSON stringify object filters', () => {
      // Test date range filters
    });

    it('should JSON stringify array filters', () => {
      // Test status array filters
    });
  });

  describe('request', () => {
    it('should timeout after configured duration', async () => {
      // Mock fetch to hang, verify timeout error
    });

    it('should retry on 5xx errors', async () => {
      // Mock fetch to fail twice then succeed
    });

    it('should not retry on 4xx errors', async () => {
      // Mock 400 error, verify no retry
    });
  });

  describe('getList', () => {
    it('should return totalCount when includeCount is true', async () => {
      // Mock response with X-listCount header
    });
  });
});
```

**File:** `src/__tests__/tools/products.test.ts`
```typescript
import { describe, it, expect, vi } from 'vitest';
// Integration tests for product tools
```

### 6.3 Test Coverage Goals

| Component | Target Coverage |
|-----------|----------------|
| RateLimiter | 100% |
| InflowClient | 90% |
| Tool handlers | 80% |
| Config | 100% |

---

## Phase 7: Documentation Updates

**File:** `README.md`

### 7.1 Add Sorting Documentation

```markdown
## Sorting Results

All list operations support sorting:

```bash
# Sort products by name ascending
list_products --sort name

# Sort by modified date descending
list_products --sort modifiedDate --sortDesc true
```

### 7.2 Add Smart Search Documentation

```markdown
## Smart Search

Use the `smart` parameter to search across multiple fields:

```bash
# Search products by any field
list_products --smart "widget"

# Search customers
list_customers --smart "acme"
```

### 7.3 Add Date Range Filter Documentation

```markdown
## Filtering by Date Ranges

Use structured date filters for range queries:

```bash
# Orders from Q1 2024
list_sales_orders --orderDate '{"fromDate":"2024-01-01","toDate":"2024-03-31"}'
```

### 7.4 Add Pagination with Count Documentation

```markdown
## Pagination

Use `includeCount` to get total records for pagination:

```bash
list_products --count 10 --includeCount true
# Response includes { data: [...], totalCount: 150 }
```

### 7.5 Add Negative Inventory Documentation

```markdown
## Allowing Negative Inventory

By default, operations that would make inventory negative will fail.
Override this with the `allowNegativeInventory` flag:

```bash
upsert_stock_adjustment --allowNegativeInventory true --items '[...]'
```

### 7.6 Add Configuration Documentation

```markdown
## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| INFLOW_COMPANY_ID | required | Your company ID |
| INFLOW_API_KEY | required | Your API key |
| INFLOW_BASE_URL | cloudapi.inflowinventory.com | API base URL |
| INFLOW_API_VERSION | 2025-06-24 | API version |
| INFLOW_RATE_LIMIT | 60 | Requests per minute |
| INFLOW_REQUEST_TIMEOUT | 30000 | Request timeout (ms) |
| INFLOW_MAX_RETRIES | 3 | Max retry attempts |
| INFLOW_RETRY_DELAY | 1000 | Initial retry delay (ms) |
| INFLOW_DEBUG | false | Enable debug logging |
```

---

## Implementation Order

### Week 1: Foundation
1. Phase 1.1: Request timeouts
2. Phase 1.2: Retry logic
3. Phase 1.3: Custom headers support
4. Phase 1.4: Complex filter types
5. Phase 6.1-6.2: Test setup and core tests

### Week 2: Features
6. Phase 1.5: Sorting parameters
7. Phase 1.6: Include count
8. Phase 2: Type definitions
9. Phase 3.1-3.2: Sorting and smart search in tools

### Week 3: Complete Tools
10. Phase 3.3-3.4: Date range and array filters
11. Phase 3.5-3.6: Negative inventory and BOM auto-fill
12. Phase 3.7-3.8: Webhook secret and custom field labels

### Week 4: Polish
13. Phase 4: Configuration updates
14. Phase 5: Debug logging
15. Phase 7: Documentation
16. Phase 6.3: Achieve coverage goals

---

## File Changes Summary

| File | Type | Changes |
|------|------|---------|
| `src/config.ts` | Modify | Add timeout, retry, debug config |
| `src/client/inflow.ts` | Modify | Timeouts, retries, headers, filters, sorting, getList |
| `src/types/inflow.ts` | Modify | Add filter types, sorting, webhook secret |
| `src/tools/products.ts` | Modify | Add sorting, smart search, includeCount |
| `src/tools/sales-orders.ts` | Modify | Add sorting, filters, date ranges |
| `src/tools/purchase-orders.ts` | Modify | Add sorting, filters, date ranges |
| `src/tools/customers.ts` | Modify | Add sorting, smart search |
| `src/tools/inventory.ts` | Modify | Add negative inventory, BOM auto-fill |
| `src/tools/reference.ts` | Modify | Add custom field labels, webhook secret |
| `vitest.config.ts` | Create | Test configuration |
| `src/__tests__/*.test.ts` | Create | Test files |
| `README.md` | Modify | Documentation updates |
| `package.json` | Modify | Add test scripts and dependencies |
