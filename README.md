# inFlow Inventory MCP Server

A Model Context Protocol (MCP) server that provides comprehensive tools for interacting with the [inFlow Inventory](https://www.inflowinventory.com/) API. This enables AI assistants like Claude to manage your inventory, orders, customers, and more.

## Features

- **Products**: List, search, create, update products and check inventory levels
- **Sales Orders**: Create and manage customer orders
- **Purchase Orders**: Create and manage vendor purchase orders
- **Customers & Vendors**: Manage customer and vendor records
- **Inventory Operations**: Stock adjustments, transfers, counts, and manufacturing orders
- **Reference Data**: Locations, categories, pricing schemes, payment terms, currencies, tax codes
- **Webhooks**: Subscribe to inFlow events

## Prerequisites

- Node.js 18 or higher
- An active inFlow Inventory subscription with API add-on
- inFlow API credentials (Company ID and API Key)

## Installation

```bash
# Clone or copy the server files
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
export INFLOW_API_VERSION="2025-06-24"  # Default API version
export INFLOW_RATE_LIMIT="60"  # Requests per minute (default: 60)
export INFLOW_REQUEST_TIMEOUT="30000"  # Request timeout in ms (default: 30000)
export INFLOW_MAX_RETRIES="3"  # Max retries on 5xx/429 errors (default: 3)
export INFLOW_RETRY_DELAY="1000"  # Initial retry delay in ms (default: 1000)
export INFLOW_DEBUG="true"  # Enable debug logging (default: false)
```

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
| `upsert_product` | Create or update a product |
| `get_inventory_summary` | Get stock levels across locations |
| `get_inventory_summaries_batch` | Batch get stock levels (max 100) |
| `get_bill_of_materials` | Get BOM components for a manufacturable product |

### Sales Orders

| Tool | Description |
|------|-------------|
| `list_sales_orders` | Search and filter sales orders |
| `get_sales_order` | Get order details by ID |
| `upsert_sales_order` | Create or update a sales order |

### Purchase Orders

| Tool | Description |
|------|-------------|
| `list_purchase_orders` | Search and filter purchase orders |
| `get_purchase_order` | Get order details by ID |
| `upsert_purchase_order` | Create or update a purchase order |

### Customers

| Tool | Description |
|------|-------------|
| `list_customers` | Search and filter customers |
| `get_customer` | Get customer details by ID |
| `upsert_customer` | Create or update a customer |

### Vendors

| Tool | Description |
|------|-------------|
| `list_vendors` | Search and filter vendors |
| `get_vendor` | Get vendor details by ID |
| `upsert_vendor` | Create or update a vendor |

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
| `upsert_manufacturing_order` | Create/update work order |

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

### Check Inventory

```
What's the current stock level for product "Widget Pro" across all locations?
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
get_sales_order with include=["customer", "items", "items.product"]
```

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
