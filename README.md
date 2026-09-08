# inFlow Inventory MCP Server

A Model Context Protocol (MCP) server that provides comprehensive tools for interacting with the [inFlow Inventory](https://www.inflowinventory.com/) API. This enables AI assistants like Claude to manage your inventory, orders, customers, and more.

Current package version: `1.4.0-alpha.2`

## Features

- **Products**: List, search, create, update products and check inventory levels
- **Sales Orders**: Create customer orders and patch existing orders without dropping unmentioned lines or serial numbers
- **Purchase Orders**: Create vendor purchase orders, receive stock, and reverse received stock
- **Customers & Vendors**: Manage customer and vendor records
- **Inventory Operations**: Stock adjustments, transfers, counts, and manufacturing orders
- **Manufacturing Orders**: Create or patch work orders while preserving output/input lines and serial numbers
- **Product Manufacturing**: Read, compare, preview, and concurrency-check BOM, operation-template, and manufacturing-setting changes
- **Product Groups**: Discover groups, options, variants, and per-location variant quantities
- **Planning & Audit**: Product-group manufacturing audit and exact direct/leaf/net BOM requirements
- **Prices & Traceability**: Exact pricing-scheme rows plus manufacturing-order line/pick/matching trace
- **Mutation Safety**: Signed previews, dual current-state hashes, timestamps, durable status, idempotency, and readback verification
- **Serial Numbers**: Query serial numbers from orders or product inventory lines
- **Reference Data**: Locations, categories, pricing schemes, payment terms, currencies, tax codes
- **Webhooks**: Subscribe to inFlow events

## Prerequisites

- Node.js 22
- An active inFlow Inventory subscription with API add-on
- inFlow API credentials (Company ID and API Key)

## Installation

```bash
git clone https://github.com/bigl34/inflow-mcp-server.git
cd inflow-mcp-server

# Install dependencies
npm install

# Build the TypeScript
npm run build
```



## Configuration

### Getting Your API Credentials

1. Log in to your inFlow Inventory account
2. Go to **Settings** > **Integrations**
3. Find your **Company ID** on the integrations page
4. Click **Add New API Key** to generate a new key

### Environment Variables

Set the following environment variables:

```bash
# Required
export INFLOW_COMPANY_ID="your-company-id"
export INFLOW_API_KEY="your-api-key"

# Optional
export INFLOW_BASE_URL="https://cloudapi.inflowinventory.com"  # Default
export INFLOW_API_VERSION="2026-04-13"  # Default API version
# Safe preview/apply control plane (closed by default)
export INFLOW_ENABLE_SAFE_WRITES="false"
export INFLOW_ENABLE_STOCK_WRITES="false"
# Manufacturing pick-batch additionally requires this gate and its attestation
export INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES="false"
# Deprecated diagnostic compatibility inputs; these authorize no safe writes
export INFLOW_ENABLE_MANUFACTURING_WRITES="false"
export INFLOW_ENABLE_PRICE_WRITES="false"
export INFLOW_ENABLE_PRODUCT_GROUP_WRITES="false"
export INFLOW_ENABLE_MO_SERIAL_WRITES="false"
export INFLOW_ENABLE_STANDARD_WRITES="false"
export INFLOW_STATE_DIR="$HOME/.local/state/inflow-mcp"
export INFLOW_RATE_LIMIT="60"  # Requests per minute (default: 60)
export INFLOW_REQUEST_TIMEOUT="30000"  # Request timeout in ms (default: 30000)
export INFLOW_MAX_RETRIES="3"  # Max retries on 5xx/429 errors (default: 3)
export INFLOW_RETRY_DELAY="1000"  # Initial retry delay in ms (default: 1000)
export INFLOW_DEBUG="true"  # Enable debug logging (default: false)
```

### Manufacturing-run coordinator

The manufacturing-run coordinator is a separate HTTP/worker binary; it does
not run inside the stdio MCP server. Build first, then use
`npm run validate:coordinator` to validate the secure credential environment
without starting the listener, or `npm run start:coordinator` to start the
loopback service. The launcher reads its absolute `0600`, single-link,
current-user-owned credential file from the Mac runtime configuration.
Build identity is derived from the running release artifacts; the coordinator
credential file must not contain `INFLOW_ADAPTER_MANIFEST_HASH` or
`INFLOW_PROBE_BUILD` assertions.

In addition to the normal inFlow company/API values, the coordinator
credential environment requires:

```bash
INFLOW_COORDINATOR_HMAC_CURRENT_KID=coordinator-current
INFLOW_COORDINATOR_HMAC_CURRENT_SECRET=<at-least-32-bytes>
INFLOW_COORDINATOR_RUN_READY_WEBHOOK_URL=https://hooks.zapier.com/...
INFLOW_COORDINATOR_TERMINAL_WEBHOOK_URL=https://hooks.zapier.com/...
```

Optional rotation and delivery controls are:

```bash
INFLOW_COORDINATOR_HMAC_NEXT_KID=coordinator-next
INFLOW_COORDINATOR_HMAC_NEXT_SECRET=<at-least-32-bytes>
INFLOW_COORDINATOR_WEBHOOK_AUDIENCE=zapier-webhook
INFLOW_COORDINATOR_WEBHOOK_MAX_ATTEMPTS=5
INFLOW_COORDINATOR_WEBHOOK_RETRY_DELAY_MS=5000
INFLOW_COORDINATOR_WEBHOOK_TIMEOUT_MS=10000
INFLOW_COORDINATOR_WEBHOOK_CLAIM_TTL_MS=30000
```

Both callback URLs must be HTTPS and must not contain credentials. Callback
events are stored transactionally with their state transition and delivered
at least once with deterministic event IDs. The delivery timeout must be
shorter than the durable claim TTL. Each request body contains a canonical
`manufacturing-run-callback/v1` envelope whose HMAC binds the callback kind,
event and operation identity, state revision, marker, audience, company,
timestamp, nonce, key ID, and payload hash. A callback workflow must verify
that body signature before any status, resolve, claim, or Slack action; HTTP
headers alone are not callback authorization. Terminal claims are bound to the
deterministic notification ID inside the verified payload, so an out-of-order
or replayed callback cannot claim another pending notification. Slack
notification posts use a separate claim/ack outbox: an ambiguous post must be marked
`delivery_unknown` and reconciled explicitly, never reposted automatically.
The coordinator's stock-moving manufacturing write flags remain closed until
their separately approved contract canary and production gate authorize them.
That coordinator boundary is separate from product BOM/config confirmation.

New manufacturing runs use `manufacturing-run-identity/v2`, keeping the
source serial and finished serial as separate immutable identities. Before
component collection, the coordinator validates the complete rooted expanded
MO hierarchy, excludes expanded structural subassemblies from consumption,
and binds the source serial to exactly one quantity-one consumable raw line at
the selected location. The binding is revalidated at readiness and immediately
before the dispatch fence. Exact bound serials may proceed when aggregate
availability covers the requested unit even if unrelated inventory is
allocated (for example, 27 on hand and 24 available); an unavailable binding
blocks with structured evidence and never substitutes another serial.

New v1 begins are refused. Stored v1 runs remain readable: an already-fenced
`dispatch_uncertain` run may perform exact readback-only reconciliation, while
other active v1 states are quarantined as blocked and cannot prepare or
dispatch a provider mutation.

### Claude Desktop Configuration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "inflow-inventory": {
      "command": "node",
      "args": ["/path/to/inflow-mcp-server/dist/index.js"],
      "env": {
        "INFLOW_COMPANY_ID": "your-company-id",
        "INFLOW_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Available Tools

### Product Management

| Tool | Description |
|------|-------------|
| `list_products` | Search and filter products |
| `get_product` | Get product details by ID (use `include=itemBoms` for BOM) |
| `set_product` | Preview/apply a bounded product create/update; patch-mode `customFields` merges supplied keys while preserving siblings |
| `upsert_product` | **Deprecated immediate write** retained only for the 1.4 compatibility window |
| `get_inventory_summary` | Get stock levels across locations |
| `get_inventory_summaries_batch` | Batch get stock levels (max 100) |
| `get_bill_of_materials` | Get enriched BOM/manufacturing state for any product |
| `compare_product_boms` | Compare components, operation templates, and settings for 2-25 products |
| `set_product_manufacturing_config` | Preview or apply an exact-scope explicitly confirmed manufacturing configuration change |
| `list_product_groups` | List product groups with options and variants |
| `get_product_group` | Get one product group with options and variants |
| `get_product_group_variant_quantities` | Get variant quantities for a group at one location |
| `list_operation_types` / `get_operation_type` | Discover manufacturing operation types |
| `get_product_prices` / `set_product_prices` | Read or preview/apply exact pricing-scheme rows |
| `copy_product_manufacturing_config` | Explicitly confirmed copy of selected components, operations, or settings without source row IDs |
| `audit_product_group_manufacturing` | Audit option combinations and manufacturing consistency |
| `calculate_bom_requirements` | Calculate exact direct, leaf, or net material requirements |
| `set_product_group_config` | Preview exact-ID group option/value/variant changes |
| `create_product_group_variants` | Preview deterministic IDs for the create/attach/compensate saga |

### Sales Orders

| Tool | Description |
|------|-------------|
| `list_sales_orders` | Search and filter sales orders |
| `get_sales_order` | Get order details by ID |
| `upsert_sales_order` | Create an order or partially update an existing order. Updates preserve unmentioned header fields and lines, merge item patches by line ID or unambiguous product ID, and remove lines listed in `deleteLineIds`. |

### Purchase Orders

| Tool | Description |
|------|-------------|
| `list_purchase_orders` | Search and filter purchase orders |
| `get_purchase_order` | Get order details by ID |
| `upsert_purchase_order` | **Deprecated immediate write** retained only for the 1.4 compatibility window |
| `receive_purchase_order` | **Deprecated immediate stock write** retained only for the 1.4 compatibility window |
| `unreceive_purchase_order` | **Deprecated immediate stock write** retained only for the 1.4 compatibility window |

### Customers

| Tool | Description |
|------|-------------|
| `list_customers` | Search and filter customers |
| `get_customer` | Get customer details by ID |
| `upsert_customer` | **Deprecated immediate write** retained only for the 1.4 compatibility window |

### Vendors

| Tool | Description |
|------|-------------|
| `list_vendors` | Search and filter vendors |
| `get_vendor` | Get vendor details by ID |
| `upsert_vendor` | **Deprecated immediate write** retained only for the 1.4 compatibility window |

### Inventory Operations

| Tool | Description |
|------|-------------|
| `list_stock_adjustments` | List stock adjustments |
| `get_stock_adjustment` | Get adjustment details |
| `upsert_stock_adjustment` | Create/update stock adjustment |
| `list_stock_transfers` | List stock transfers |
| `get_stock_transfer` | Get transfer details |
| `upsert_stock_transfer` | Create/update stock transfer |
| `list_stock_counts` | List inventory counts |
| `get_stock_count` | Get count details |
| `upsert_stock_count` | Create/update stock count |
| `list_manufacturing_orders` | List work orders |
| `get_manufacturing_order` | Get work order details |
| `upsert_manufacturing_order` | Create a work order or partially update an existing one. Updates preserve unmentioned fields, patch output quantity/serials in place, merge input-line patches, and remove lines listed in `deleteInputLineIds`. |
| `get_manufacturing_order_trace` | Join output lines, pick lines, pick matchings, and serial anomalies |
| `reconcile_manufacturing_order_serials` | Preview exact-ID linked serial changes; apply is canary-gated |

### Status and safe writes

`get_mcp_status` returns additive `mcp-status/v2` data without exposing the
company ID or credentials. `writePolicies.safe.operations` reports each
operation's fixed `ordinary` or `stock` classification, static adapter support,
effective apply state, required gates, and reason. Old per-domain status fields
remain present but are marked deprecated and disabled. `legacyBypassActive` is
always true while deprecated immediate-write tools are registered.

The safe control plane has only two general switches:

- every supported preview/apply dispatch requires
  `INFLOW_ENABLE_SAFE_WRITES=true`;
- stock-affecting dispatch also requires
  `INFLOW_ENABLE_STOCK_WRITES=true`.

Manufacturing pick-batch additionally requires its dedicated environment gate
and valid coordinator attestation for the final build. Product
BOM/manufacturing configuration retains its explicit-confirmation policy and
also requires the master safe-write gate. Every applicable gate is checked
again immediately before network dispatch, so closing a gate invalidates an
existing preview. Closing a gate cannot reverse a completed write; unknown
outcomes remain journalled and are reconciled by readback without redispatch.
`get_mutation_status` reads that durable journal and never repeats a write.

The `1.4.x` compatibility line retains the old immediate `upsert_*`, receipt,
and webhook-delete tools as deprecated interfaces. Their descriptions and
every invocation emit prominent high-severity bypass telemetry, but they remain
callable and are not controlled by `INFLOW_ENABLE_SAFE_WRITES`. New automation
must never fall back to one after a safe rejection and should use
the stable preview-first names: `set_product`, `set_sales_order`,
`set_purchase_order`, `set_purchase_order_receipts`, `set_customer`,
`set_vendor`, `set_stock_adjustment`, `set_stock_transfer`, `set_stock_count`,
`set_manufacturing_order`, `set_taxing_scheme`, `set_webhook`, and
`remove_webhook`. Generic product writes reject fields owned by price,
product-group, or BOM/manufacturing tools. Unknown and mixed operations fail
closed. Static support remains per concrete adapter, so opening a gate cannot
expose an unfinished adapter.

`set_product` is a released ordinary adapter. Patch mode deep-merges supplied
`customFields` keys into the complete current custom-field object, including
explicit falsy and `null` values; omitted sibling keys are preserved. Patch
mode does not delete keys. Replace mode retains whole-object semantics.

Idempotency keys are required for creates, additive changes, stock-affecting
changes, and multi-step mutations. Deterministic full replacement with
conclusive readback does not require a key. Deletes bind the exact target in the
preview, verify absence, and return `already_absent` when repeated against a
missing target.

### Serial Numbers

| Tool | Description |
|------|-------------|
| `get_sales_order_serials` | Extract serial numbers assigned to sales order lines |
| `get_purchase_order_serials` | Extract serial numbers assigned to purchase order lines |
| `search_serial_number` | Search fulfilled sales orders for a serial number |
| `list_serial_numbers` | Aggregate serial numbers from fulfilled sales orders |
| `get_product_serials` | Get all serial numbers for a serialized product using product inventory lines |
| `list_all_serials` | List serial numbers across products that track serials |

### Reference Data

| Tool | Description |
|------|-------------|
| `list_locations` | List warehouse locations |
| `get_location` | Get location details |
| `get_suggested_sublocations` | Get bin/shelf suggestions |
| `list_categories` | List product categories |
| `list_pricing_schemes` | List pricing tiers |
| `list_payment_terms` | List payment terms |
| `list_taxing_schemes` | List tax schemes |
| `upsert_taxing_scheme` | Create/update tax scheme |
| `list_tax_codes` | List tax codes |
| `list_currencies` | List currencies |
| `list_adjustment_reasons` | List adjustment reasons |
| `list_custom_field_definitions` | List custom fields |
| `get_custom_field_dropdown_options` | Get dropdown options |
| `list_team_members` | List inFlow users |

### Webhooks

| Tool | Description |
|------|-------------|
| `list_webhooks` | List webhook subscriptions |
| `upsert_webhook` | Create/update webhook |
| `delete_webhook` | Delete webhook |

## Usage Examples

### List Products

```
List all active products in the "Electronics" category
```

### Create a Sales Order

```
Create a sales order for customer "Acme Corp" with:
- 5 units of product SKU-001 at $29.99 each
- 10 units of product SKU-002 at $15.00 each
Required by next Friday
```

### Patch a Sales Order

```
Update sales order SO-1001:
- change the required date to next Monday
- update line abc123 to quantity 2 with serial numbers SN-001 and SN-002
- remove line def456
```

### Receive a Purchase Order

```
Receive all remaining items on purchase order PO-1001 at the Main Warehouse
```

### Reverse a Purchase Order Receipt

```
Unreceive 1 unit of product SKU-001 from purchase order PO-1001 as a dry run first
```

### Check Inventory

```
What's the current stock level for product "Widget Pro" across all locations?
```

### Compare and update a BOM safely

Call `compare_product_boms` with the target product and analogous variants, then
preview the desired change:

```json
{
  "productId": "target-product-id",
  "mode": "replace",
  "components": [
    { "childProductId": "component-id", "quantity": "1" }
  ],
  "dryRun": true
}
```

Apply only by repeating the request with `dryRun:false`, the signed
`previewToken`, `currentSemanticHash`, `currentWriteShapeHash`,
`entityTimestamp`, `desiredHash`, any returned `idempotencyKey`, and
`confirmation:{scope,confirmationHash}` copied from the reviewed fresh preview.
The confirmation hash must be the full lowercase 64-character value. The
server reconstructs the scope from live state and runtime identity and trusts
neither supplied field. It validates confirmation before no-op, idempotency
creation, journalling, or dispatch; a stale build, tenant, source, target, or
state requires a new preview and confirmation.

The CLI flow is:

```bash
bash "$HOME/biz/scripts/cli-run.sh" inflow-inventory-manager \
  set-bom --id PRODUCT_ID --mode replace --components '[]'

bash "$HOME/biz/scripts/cli-run.sh" inflow-inventory-manager \
  set-bom --id PRODUCT_ID --mode replace --components '[]' \
  --apply true --confirm \
  --confirm-preview-hash FULL_64_CHARACTER_HASH
```

`INFLOW_ENABLE_MANUFACTURING_WRITES` and
`attestations/manufacturing.json` are deprecated compatibility inputs and do
not authorize or block `set_product_manufacturing_config` or
`copy_product_manufacturing_config`. Those tools retain exact preview
confirmation and now require `INFLOW_ENABLE_SAFE_WRITES=true` at apply. The
manufacturing probe remains useful as non-authorizing API/serializer and
optimistic-concurrency characterization. Stock-moving manufacturing-order
writes require both general gates; pick-batch also requires its dedicated
coordinator gate and attestation.

### Manufacturing pick-batch live canary v2

`npm run probe:manufacturing-canary -- --mode pick-batch --scenario <absolute-path> --approvals <absolute-path> --runtime-material <absolute-path>`
runs the checkpointed v2 protocol through the credentialed launcher. The
launcher reads the existing owner-only coordinator credential file, requires
all JSON materials to be absolute owner-only regular files, and refuses to run
unless the master, stock, and coordinator production gates are closed. It never prints
credentials or material bodies. The lower-level
`npm run probe:manufacturing-pick-batch` entry point remains useful for offline
tests but is not the live operator boundary.
The older `manufacturing-pick-batch-canary-scenario/v1` manifest is refused as
not live-executable. Keep
`INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES` absent/false throughout the
canary and use a dedicated idle `INFLOW_RATE_LIMIT=20` process. The command
uses:

  two-subject manifest (`complete` has no operations; `staging` has operations);
  stage approvals printed from the current checkpoint/plan;
  component intents, canary-only component serials, sentinel exclusion
  evidence, and exact expected rejection status/code pairs. V2 accepts only a
  predeclared HTTP status in `400`, `409`, `412`, or `422` plus a non-empty
  provider code; the observed status and code must both match exactly. The
  characterized unavailable-serial response is HTTP `400` with provider code
  `NegativeSerialNumberInventory`.

The command is intentionally multi-run. With no approval it creates an
owner-only checkpoint and prints the exact `create` plan. After each approved
stage it stops at the next approval boundary: `create`, `stock-move`,
`negative-probes`, read-only `manual-completion-read`, generated `cleanup`, and
`attest`. Every mutation is durably fenced before dispatch, is dispatched at
most once, and resumes with readback only. Full manufacturing-order reads use
the provider-supported lines/operations/picks/matchings/puts include set;
operation timesheets are normalized when present but are not a live include
relationship. Cleanup is
generated from the latest full bodies and rowversions; attestation is issued
only after exact canonical inventory/serial restoration and real residual
discovery.
The final `attest` rerun performs fresh full-MO, order-number/marker list, and
product inventory-line reads after approval; cached cleanup evidence cannot
mint an attestation if any provider state has drifted.

Live prerequisites are five already isolated, operator-approved canary
products: two finished products, one nonserialized structural subassembly, one
serialized leaf component with dedicated serials, and one nonserialized leaf
component. Each finished product has only the structural subassembly in its
BOM; the subassembly owns both leaf components so the expanded-subassembly
leaf-only contract is exercised. A dedicated location/reason, exact BOM and
operation shapes, and approval of the two deterministic inert MO IDs are also
required. This command does not provision or seed them. Provisioning, exact
stock-adjustment apply/reversal, and cleanup must first pass through the
separate checkpointed fixture workflow before the higher-risk canary stock
stage runs.

Ordinary-domain canaries are release tests, not expiring runtime permissions.
Every live canary requires separate operator approval for an exact inert
resource; none runs merely because a safe-write gate is open. The approved
inactive-product price fixture must start inactive with no price rows, and its
two exact pricing schemes must be safe for disposable test prices:

```bash
npm run probe:domain -- prices "inactive-product-id" --approve-external-write
```

This probe exercises the production price serializer (including server-assigned
row IDs), stale timestamps, preservation, remove/clear, and cleanup, then emits
release evidence. Product-group and MO-serial release canaries use the same
entry point with `product-groups` or `mo-serials`, exact
They prove full-array preservation/compensation or serial/inventory net-zero
restoration respectively. A passing result does not open a runtime gate or make
an adapter supported; release still requires a code change and normal review.

### Look Up Serial Numbers

```
Show all in-stock serial numbers for product "Widget Pro"
```

### Create Stock Transfer

```
Transfer 50 units of "Widget Pro" from "Main Warehouse" to "Retail Store"
```

## API Features

### Filtering

Most list operations support filtering. For example:

```
list_products with name="Widget" and isActive=true
```

### Pagination

Large result sets are paginated. Use `skip` and `count` parameters:

- `count`: Number of records to return (max 100)
- `skip`: Number of records to skip

**Note:** The default page size is 20 records. Always specify `count` when you need all records.

### Sorting

All list operations support sorting:

- `sort`: Property name to sort by (e.g., "name", "modifiedDate", "orderDate")
- `sortDesc`: Set to `true` for descending order

```
list_products with sort="modifiedDate" and sortDesc=true
```

### Total Count

To get the total number of matching records (useful for pagination UI), use `includeCount`:

```
list_sales_orders with status="Open" and includeCount=true
```

Response includes:
```json
{
  "data": [...],
  "totalCount": 42
}
```

### Smart Search

Some endpoints support `smart` parameter for fuzzy searching across multiple fields:

```
list_customers with smart="acme"  // Searches name, email, phone
list_sales_orders with smart="SO-2025"  // Searches order fields
```

### Includes

Use the `include` parameter to fetch related data:

```
get_sales_order with include=["customer", "lines", "lines.product"]
get_product with include=["inventoryLines"]
```

The `2026-04-13` API rejects `itemBoms.childProduct` even though nested includes
work for relationships such as `productOperations.operationType`. The BOM tools
therefore fetch the product/BOM once, then resolve child products with a
rate-limited concurrency of four. Failed child enrichment produces warnings and
never drops a BOM row.

### Partial Updates

`upsert_sales_order` and `upsert_manufacturing_order` support safe partial updates when `id` is provided:

- Existing fields and lines that are not mentioned are preserved.
- Line patches merge by explicit line ID, or by product ID when there is exactly one matching line.
- Sales order lines listed in `deleteLineIds` are removed.
- Manufacturing order input lines listed in `deleteInputLineIds` are removed.
- Serial numbers can be patched without rebuilding the whole order manually.

### Concurrency Control

When updating records, include the `timestamp` field from the original record to prevent conflicts.

## Rate Limiting

The inFlow API has a rate limit of 60 requests per minute. This server implements:

- **Token bucket rate limiting**: Automatically paces requests to stay within limits
- **Automatic retries**: Retries on 5xx errors and rate limit (429) responses with exponential backoff
- **Configurable limits**: Override via `INFLOW_RATE_LIMIT` environment variable

## Error Handling

The server returns descriptive error messages from the inFlow API. Common errors include:

- **401 Unauthorized**: Invalid API key
- **404 Not Found**: Resource doesn't exist
- **409 Conflict**: Timestamp mismatch (record was modified)
- **429 Too Many Requests**: Rate limit exceeded (automatically retried)

## Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run the server
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## API Documentation

- [inFlow API Documentation](https://cloudapi.inflowinventory.com/docs/index.html)
- [inFlow API Support Guide](https://www.inflowinventory.com/support/cloud/inflows-api)

## License

MIT

