// Purchase Order tools for inFlow MCP Server

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type {
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderReceiveLine,
  PurchaseOrderFilter,
  PaginationParams,
  Address,
} from '../types/inflow.js';

const addressSchema = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

const purchaseOrderItemSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number(),
  unitCost: z.number().optional(),
  taxCodeId: z.string().optional(),
  sublocation: z.string().optional(),
  serialNumbers: z.array(z.string()).optional(),
});

const poStatusEnum = z.enum(['Open', 'PartiallyReceived', 'Received', 'Cancelled', 'Closed']);

/**
 * Parse a line quantity that may be a number or an object with standardQuantity/uomQuantity.
 * The inFlow API returns quantity in either format depending on UOM configuration.
 */
function parseLineQuantity(qty: number | string | { standardQuantity: number | string; uomQuantity: number | string; uom?: string; serialNumbers?: string[] } | undefined): number {
  if (qty === undefined || qty === null) return 0;
  if (typeof qty === 'number') return qty;
  if (typeof qty === 'string') return parseFloat(qty) || 0;
  const std = qty.standardQuantity ?? qty.uomQuantity ?? 0;
  return typeof std === 'string' ? parseFloat(std) || 0 : std;
}

/**
 * Strip a receive line to only the writable fields the API expects on PUT.
 * Avoids sending computed/read-only fields back that could cause rejection.
 */
function stripReceiveLineToWritable(rl: PurchaseOrderReceiveLine) {
  return {
    purchaseOrderReceiveLineId: rl.purchaseOrderReceiveLineId,
    productId: rl.productId,
    quantity: rl.quantity,
    locationId: rl.locationId,
    sublocation: rl.sublocation,
    receiveDate: rl.receiveDate,
    timestamp: rl.timestamp,
  };
}

export function registerPurchaseOrderTools(server: McpServer, client: InflowClient): void {
  // List Purchase Orders
  server.tool(
    'list_purchase_orders',
    'Search and list purchase orders with optional filtering',
    {
      orderNumber: z.string().optional().describe('Filter by order number'),
      vendorId: z.string().optional().describe('Filter by vendor ID'),
      status: z.union([
        poStatusEnum,
        z.array(poStatusEnum),
      ]).optional().describe('Filter by order status (single value or array)'),
      locationId: z.string().optional().describe('Filter by destination location ID'),
      orderDateFrom: z.string().optional().describe('Filter by order date (from) - ISO format'),
      orderDateTo: z.string().optional().describe('Filter by order date (to) - ISO format'),
      expectedDateFrom: z.string().optional().describe('Filter by expected date (from)'),
      expectedDateTo: z.string().optional().describe('Filter by expected date (to)'),
      smart: z.string().optional().describe('Smart search across order fields'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., vendor, items, items.product)'),
      skip: z.number().optional().describe('Number of records to skip'),
      count: z.number().optional().describe('Number of records to return (max 100)'),
      sort: z.string().optional().describe('Property to sort by (e.g., orderDate, orderNumber)'),
      sortDesc: z.boolean().optional().describe('Sort in descending order'),
      includeCount: z.boolean().optional().describe('Include total record count in response'),
    },
    async (args) => {
      const filters: PurchaseOrderFilter = {};
      if (args.orderNumber) filters.orderNumber = args.orderNumber;
      if (args.vendorId) filters.vendorId = args.vendorId;
      if (args.status) filters.status = args.status;
      if (args.locationId) filters.locationId = args.locationId;
      if (args.orderDateFrom) filters.orderDateFrom = args.orderDateFrom;
      if (args.orderDateTo) filters.orderDateTo = args.orderDateTo;
      if (args.expectedDateFrom) filters.expectedDateFrom = args.expectedDateFrom;
      if (args.expectedDateTo) filters.expectedDateTo = args.expectedDateTo;
      if (args.smart) filters.smart = args.smart;

      const pagination: PaginationParams = {};
      if (args.skip !== undefined) pagination.skip = args.skip;
      if (args.count !== undefined) pagination.count = args.count;

      const result = await client.getList<PurchaseOrder>('/purchase-orders', {
        filters,
        pagination,
        include: args.include,
        sort: args.sort,
        sortDesc: args.sortDesc,
        includeCount: args.includeCount,
      });

      const response: { data: PurchaseOrder[]; totalCount?: number } = { data: result.data };
      if (result.totalCount !== undefined) {
        response.totalCount = result.totalCount;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );

  // Get Purchase Order
  server.tool(
    'get_purchase_order',
    'Get detailed information about a specific purchase order',
    {
      purchaseOrderId: z.string().describe('The purchase order ID'),
      include: z
        .array(z.string())
        .optional()
        .describe('Related data to include (e.g., vendor, location, items, items.product)'),
    },
    async (args) => {
      const order = await client.get<PurchaseOrder>(
        `/purchase-orders/${args.purchaseOrderId}`,
        { include: args.include }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(order, null, 2),
          },
        ],
      };
    }
  );

  // Create/Update Purchase Order
  server.tool(
    'upsert_purchase_order',
    'Create a new purchase order or update an existing one',
    {
      id: z.string().optional().describe('Purchase order ID (required for updates)'),
      orderNumber: z.string().optional().describe('Order number'),
      orderDate: z.string().optional().describe('Order date (ISO format)'),
      expectedDate: z.string().optional().describe('Expected delivery date (ISO format)'),
      vendorId: z.string().describe('Vendor ID'),
      locationId: z.string().optional().describe('Destination location/warehouse ID'),
      shippingAddress: addressSchema.optional().describe('Shipping address'),
      currencyCode: z.string().optional().describe('Currency code (e.g., USD)'),
      items: z.array(purchaseOrderItemSchema).optional().describe('Order line items'),
      remarks: z.string().optional().describe('Order remarks/notes'),
      customFields: z.record(z.unknown()).optional().describe('Custom field values'),
      timestamp: z.string().optional().describe('Timestamp for concurrency control'),
    },
    async (args) => {
      // inFlow API requires purchaseOrderId for both create and update
      // Generate a new UUID if not provided (for creates)
      const purchaseOrderId = args.id || randomUUID();

      // Transform items to lines with correct inFlow API format:
      // - quantity must be { standardQuantity, uomQuantity } object
      // - use unitPrice not unitCost
      // - each line needs purchaseOrderLineId GUID
      const lines = args.items?.map((item) => ({
        purchaseOrderLineId: (item as any).id || randomUUID(),
        productId: item.productId,
        description: item.description,
        quantity: {
          standardQuantity: item.quantity,
          uomQuantity: item.quantity,
        },
        unitPrice: item.unitCost,
        taxCodeId: item.taxCodeId,
        sublocation: item.sublocation,
        serialNumbers: item.serialNumbers,
      }));

      const order: PurchaseOrder = {
        purchaseOrderId: purchaseOrderId,
        orderNumber: args.orderNumber,
        orderDate: args.orderDate,
        expectedDate: args.expectedDate,
        vendorId: args.vendorId,
        locationId: args.locationId,
        shippingAddress: args.shippingAddress as Address,
        currencyCode: args.currencyCode,
        lines: lines as PurchaseOrderItem[],
        remarks: args.remarks,
        customFields: args.customFields,
        timestamp: args.timestamp,
      };

      // inFlow API uses PUT for both create and update with purchaseOrderId in body
      const result = await client.put<PurchaseOrder>('/purchase-orders', order);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Receive Purchase Order Items
  server.tool(
    'receive_purchase_order',
    'Receive items on a purchase order by adding entries to the PO\'s receiveLines[] array via PUT.',
    {
      purchaseOrderId: z.string().describe('The purchase order ID'),
      receiveAll: z.boolean().optional().describe('Receive all remaining quantity on every line'),
      items: z.array(z.object({
        purchaseOrderLineId: z.string().optional().describe('Order line ID — used to resolve productId (convenience)'),
        productId: z.string().optional().describe('Product ID to receive'),
        quantity: z.number().describe('Quantity to receive'),
        serialNumbers: z.array(z.string()).optional().describe('Serial numbers / serial numbers for serialized items'),
      })).optional().describe('Specific items to receive (creates new receive line entries)'),
      locationId: z.string().optional().describe('Warehouse location ID for received items'),
      receiveDate: z.string().optional().describe('Receive date (ISO 8601, defaults to now)'),
      allowOverReceive: z.boolean().optional().describe('Allow receiving more than ordered quantity'),
    },
    async (args) => {
      const { purchaseOrderId, receiveAll, items, allowOverReceive } = args;

      // Validate: must provide exactly one of receiveAll or items
      if (receiveAll && items && items.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Cannot use both receiveAll and items — they are mutually exclusive' }),
          }],
        };
      }
      if (!receiveAll && (!items || items.length === 0)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Provide either receiveAll=true or items array' }),
          }],
        };
      }

      // Phase 1 — GET current PO state with lines, products, and existing receiveLines
      const currentPO = await client.get<PurchaseOrder>(
        `/purchase-orders/${purchaseOrderId}`,
        { include: ['lines', 'lines.product', 'receiveLines'] }
      );

      if (!currentPO || !currentPO.lines || currentPO.lines.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Purchase order not found or has no lines' }),
          }],
        };
      }

      // Phase 2 — Validate PO status
      if (currentPO.status && ['Cancelled', 'Closed'].includes(currentPO.status)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: `Cannot receive on PO with status "${currentPO.status}"`,
              currentStatus: currentPO.status,
            }),
          }],
        };
      }

      // Phase 3 — Compute current received totals per product from existing receiveLines
      const existingReceiveLines: PurchaseOrderReceiveLine[] = currentPO.receiveLines || [];
      const receivedByProduct = new Map<string, number>();
      for (const rl of existingReceiveLines) {
        if (!rl.productId) continue;
        const qty = parseLineQuantity(rl.quantity as any);
        receivedByProduct.set(rl.productId, (receivedByProduct.get(rl.productId) || 0) + qty);
      }

      // Build lookup maps for order lines
      const lineMap = new Map<string, PurchaseOrderItem>();
      const productLineMap = new Map<string, PurchaseOrderItem[]>();
      for (const line of currentPO.lines) {
        if (line.purchaseOrderLineId) {
          lineMap.set(line.purchaseOrderLineId, line);
        }
        if (line.productId) {
          const existing = productLineMap.get(line.productId) || [];
          existing.push(line);
          productLineMap.set(line.productId, existing);
        }
      }

      // Phase 4 — Build new receive lines
      const errors: string[] = [];
      const newReceiveLines: PurchaseOrderReceiveLine[] = [];
      const receiveDate = args.receiveDate || new Date().toISOString();
      const locationId = args.locationId || currentPO.locationId;

      // Track what we're receiving for the response summary
      const receiveSummary: Array<{
        productId: string;
        productName?: string;
        quantity: number;
        ordered: number;
        previouslyReceived: number;
        totalAfterReceive: number;
        fullyReceived: boolean;
      }> = [];

      if (receiveAll) {
        // Create receive lines for full remaining qty on all order lines
        for (const line of currentPO.lines) {
          if (!line.productId) continue;
          const ordered = parseLineQuantity(line.quantity);
          const alreadyReceived = receivedByProduct.get(line.productId) || 0;
          const remaining = ordered - alreadyReceived;

          if (remaining <= 0) continue; // Already fully received

          const receiveLine: PurchaseOrderReceiveLine = {
            purchaseOrderReceiveLineId: randomUUID(),
            productId: line.productId,
            quantity: {
              standardQuantity: remaining.toFixed(4),
              uomQuantity: remaining.toFixed(4),
            },
            receiveDate,
          };
          if (locationId) receiveLine.locationId = locationId;
          newReceiveLines.push(receiveLine);

          receiveSummary.push({
            productId: line.productId,
            productName: line.product?.name,
            quantity: remaining,
            ordered,
            previouslyReceived: alreadyReceived,
            totalAfterReceive: ordered,
            fullyReceived: true,
          });
        }

        if (newReceiveLines.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: true, message: 'All lines are already fully received' }),
            }],
          };
        }
      } else {
        // Process specific items
        for (const item of items!) {
          // Resolve productId from purchaseOrderLineId if needed
          let resolvedProductId: string | undefined;
          let matchedLine: PurchaseOrderItem | undefined;

          if (item.purchaseOrderLineId) {
            matchedLine = lineMap.get(item.purchaseOrderLineId);
            if (!matchedLine) {
              errors.push(`Line ID "${item.purchaseOrderLineId}" not found on this PO`);
              continue;
            }
            resolvedProductId = matchedLine.productId;
          } else if (item.productId) {
            resolvedProductId = item.productId;
            // Find the matching order line for ordered quantity info
            const candidates = productLineMap.get(item.productId) || [];
            matchedLine = candidates[0]; // Use first match for summary data
            if (!matchedLine) {
              errors.push(`Product "${item.productId}" not found on this PO`);
              continue;
            }
          } else {
            errors.push('Each item must have purchaseOrderLineId or productId');
            continue;
          }

          if (!resolvedProductId) {
            errors.push(`Could not resolve productId for line "${item.purchaseOrderLineId}"`);
            continue;
          }

          // Over-receive guard
          const alreadyReceived = receivedByProduct.get(resolvedProductId) || 0;
          // Sum ordered qty across all order lines for this product
          const orderedForProduct = (productLineMap.get(resolvedProductId) || [])
            .reduce((sum, l) => sum + parseLineQuantity(l.quantity), 0);

          if (!allowOverReceive && (alreadyReceived + item.quantity) > orderedForProduct) {
            errors.push(
              `Product "${matchedLine?.product?.name || resolvedProductId}": would receive ${alreadyReceived + item.quantity} total but only ${orderedForProduct} ordered (already received: ${alreadyReceived}, max more: ${orderedForProduct - alreadyReceived}). Use allowOverReceive=true to override.`
            );
            continue;
          }

          // Validate serial number count matches quantity
          if (item.serialNumbers && item.serialNumbers.length > 0 && item.serialNumbers.length !== item.quantity) {
            errors.push(
              `Product "${matchedLine?.product?.name || resolvedProductId}": serial number count (${item.serialNumbers.length}) must match quantity (${item.quantity})`
            );
            continue;
          }

          // Build the receive line
          const receiveLine: PurchaseOrderReceiveLine = {
            purchaseOrderReceiveLineId: randomUUID(),
            productId: resolvedProductId,
            quantity: {
              standardQuantity: item.quantity.toFixed(4),
              uomQuantity: item.quantity.toFixed(4),
              ...(item.serialNumbers && item.serialNumbers.length > 0
                ? { serialNumbers: item.serialNumbers }
                : {}),
            },
            receiveDate,
          };
          if (locationId) receiveLine.locationId = locationId;
          newReceiveLines.push(receiveLine);

          // Update running total for subsequent over-receive checks within the same call
          receivedByProduct.set(resolvedProductId, alreadyReceived + item.quantity);

          receiveSummary.push({
            productId: resolvedProductId,
            productName: matchedLine?.product?.name,
            quantity: item.quantity,
            ordered: orderedForProduct,
            previouslyReceived: alreadyReceived,
            totalAfterReceive: alreadyReceived + item.quantity,
            fullyReceived: (alreadyReceived + item.quantity) >= orderedForProduct,
          });
        }
      }

      // If validation errors prevented all items from being processed
      if (errors.length > 0 && newReceiveLines.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Validation failed', errors }),
          }],
        };
      }

      // Phase 5 — Build PUT body with existing + new receive lines
      const strippedExisting = existingReceiveLines.map(stripReceiveLineToWritable);

      const putBody: Record<string, unknown> = {
        purchaseOrderId: currentPO.purchaseOrderId,
        vendorId: currentPO.vendorId,
        receiveLines: [...strippedExisting, ...newReceiveLines],
        timestamp: currentPO.timestamp,
      };

      // Phase 6 — PUT and build response
      const result = await client.put<PurchaseOrder>('/purchase-orders', putBody);

      const summary = {
        purchaseOrderId: result.purchaseOrderId || currentPO.purchaseOrderId,
        orderNumber: result.orderNumber || currentPO.orderNumber,
        previousStatus: currentPO.status,
        newStatus: result.status,
        received: receiveSummary.map(r => ({
          productName: r.productName,
          quantityReceived: r.quantity,
          ordered: r.ordered,
          previouslyReceived: r.previouslyReceived,
          totalReceived: r.totalAfterReceive,
          fullyReceived: r.fullyReceived,
        })),
        totalReceiveLinesNow: (result.receiveLines?.length) || (strippedExisting.length + newReceiveLines.length),
        ...(errors.length > 0 ? { warnings: errors } : {}),
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    }
  );

  // Unreceive Purchase Order Items
  server.tool(
    'unreceive_purchase_order',
    'Remove receive line entries from a PO to reverse received stock. Supports exact ID removal, product-based LIFO removal, or full unreceive.',
    {
      purchaseOrderId: z.string().describe('The purchase order ID'),
      receiveLineIds: z.array(z.string()).optional()
        .describe('Specific receive line IDs to remove entirely'),
      items: z.array(z.object({
        productId: z.string().describe('Product ID to unreceive'),
        quantity: z.number().describe('Quantity to unreceive (LIFO — newest receive lines first)'),
      })).optional()
        .describe('Products to unreceive by quantity — auto-matches receive lines newest-first'),
      unreceiveAll: z.boolean().optional()
        .describe('Remove ALL receive lines (fully unreceive the entire PO)'),
      dryRun: z.boolean().optional()
        .describe('Preview what would be removed without making changes'),
    },
    async (args) => {
      const { purchaseOrderId, receiveLineIds, items, unreceiveAll, dryRun } = args;

      // Phase 1 — Validate input (mutually exclusive)
      const modes = [receiveLineIds, items, unreceiveAll].filter(Boolean).length;
      if (modes === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Provide exactly one of: receiveLineIds, items, or unreceiveAll' }),
          }],
        };
      }
      if (modes > 1) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Use only one of: receiveLineIds, items, or unreceiveAll — they are mutually exclusive' }),
          }],
        };
      }

      // Phase 2 — GET current PO
      const currentPO = await client.get<PurchaseOrder>(
        `/purchase-orders/${purchaseOrderId}`,
        { include: ['lines', 'lines.product', 'receiveLines'] }
      );

      if (!currentPO) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Purchase order not found' }),
          }],
        };
      }

      if (currentPO.status && ['Cancelled', 'Closed'].includes(currentPO.status)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: `Cannot unreceive on PO with status "${currentPO.status}"`,
            }),
          }],
        };
      }

      const existingReceiveLines: PurchaseOrderReceiveLine[] = currentPO.receiveLines || [];
      if (existingReceiveLines.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'PO has no receive lines to unreceive' }),
          }],
        };
      }

      // Build lookup map: receiveLineId → receiveLine
      const receiveLineMap = new Map<string, PurchaseOrderReceiveLine>();
      for (const rl of existingReceiveLines) {
        if (rl.purchaseOrderReceiveLineId) {
          receiveLineMap.set(rl.purchaseOrderReceiveLineId, rl);
        }
      }

      // Build product name lookup from order lines
      const productNameMap = new Map<string, string>();
      for (const line of currentPO.lines || []) {
        if (line.productId && line.product?.name) {
          productNameMap.set(line.productId, line.product.name);
        }
      }

      // Phase 3 — Determine which receive lines to remove/modify
      const removeSet = new Set<string>(); // receiveLineIds to remove entirely
      const partialMods: Array<{ id: string; newQty: number; oldQty: number }> = [];
      const errors: string[] = [];

      if (unreceiveAll) {
        // Mark all receive lines for removal
        for (const rl of existingReceiveLines) {
          if (rl.purchaseOrderReceiveLineId) {
            removeSet.add(rl.purchaseOrderReceiveLineId);
          }
        }
      } else if (receiveLineIds) {
        // Validate each ID exists on this PO
        for (const id of receiveLineIds) {
          if (!receiveLineMap.has(id)) {
            errors.push(`Receive line ID "${id}" not found on this PO`);
          } else {
            removeSet.add(id);
          }
        }
        if (errors.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: true, message: 'Validation failed', errors }),
            }],
          };
        }
      } else if (items) {
        // LIFO removal by product
        for (const item of items) {
          // Find all receive lines for this product
          const productLines = existingReceiveLines.filter(
            rl => rl.productId === item.productId && rl.purchaseOrderReceiveLineId
          );

          if (productLines.length === 0) {
            errors.push(`No receive lines found for product "${productNameMap.get(item.productId) || item.productId}"`);
            continue;
          }

          // Calculate total received for this product
          const totalReceived = productLines.reduce((sum, rl) => sum + parseLineQuantity(rl.quantity as any), 0);
          if (item.quantity > totalReceived) {
            errors.push(
              `Product "${productNameMap.get(item.productId) || item.productId}": ` +
              `requested unreceive of ${item.quantity} but only ${totalReceived} received`
            );
            continue;
          }

          // Sort LIFO: newest first by receiveDate, then by ID as tiebreaker
          const sorted = [...productLines].sort((a, b) => {
            // receiveDate desc
            const dateA = a.receiveDate || '';
            const dateB = b.receiveDate || '';
            if (dateB > dateA) return 1;
            if (dateB < dateA) return -1;
            // timestamp desc
            const tsA = a.timestamp || '';
            const tsB = b.timestamp || '';
            if (tsB > tsA) return 1;
            if (tsB < tsA) return -1;
            // ID desc as stable tiebreaker
            const idA = a.purchaseOrderReceiveLineId || '';
            const idB = b.purchaseOrderReceiveLineId || '';
            if (idB > idA) return 1;
            if (idB < idA) return -1;
            return 0;
          });

          let remaining = item.quantity;
          for (const rl of sorted) {
            if (remaining <= 0) break;
            const lineQty = parseLineQuantity(rl.quantity as any);
            const rlId = rl.purchaseOrderReceiveLineId!;

            if (lineQty <= remaining) {
              // Remove entire line
              removeSet.add(rlId);
              remaining -= lineQty;
            } else {
              // Partial: reduce quantity in-place
              const newQty = lineQty - remaining;
              partialMods.push({ id: rlId, newQty, oldQty: lineQty });
              remaining = 0;
            }
          }
        }

        if (errors.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: true, message: 'Validation failed', errors }),
            }],
          };
        }
      }

      // Phase 4 — Build summary of what will be removed/modified
      const removed: Array<{ receiveLineId: string; productId: string; productName?: string; quantity: number; receiveDate?: string }> = [];
      const modified: Array<{ receiveLineId: string; productId: string; productName?: string; oldQty: number; newQty: number }> = [];

      for (const rlId of removeSet) {
        const rl = receiveLineMap.get(rlId)!;
        removed.push({
          receiveLineId: rlId,
          productId: rl.productId || '',
          productName: productNameMap.get(rl.productId || ''),
          quantity: parseLineQuantity(rl.quantity as any),
          receiveDate: rl.receiveDate,
        });
      }

      for (const mod of partialMods) {
        const rl = receiveLineMap.get(mod.id)!;
        modified.push({
          receiveLineId: mod.id,
          productId: rl.productId || '',
          productName: productNameMap.get(rl.productId || ''),
          oldQty: mod.oldQty,
          newQty: mod.newQty,
        });
      }

      // Phase 5 — Dry run or PUT
      if (dryRun) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dryRun: true,
              purchaseOrderId,
              orderNumber: currentPO.orderNumber,
              currentReceiveLines: existingReceiveLines.length,
              wouldRemove: removed,
              wouldModify: modified,
              remainingReceiveLines: existingReceiveLines.length - removeSet.size,
            }, null, 2),
          }],
        };
      }

      // Build remaining receiveLines array
      const remainingLines = existingReceiveLines
        .filter(rl => !removeSet.has(rl.purchaseOrderReceiveLineId || ''))
        .map(stripReceiveLineToWritable);

      // Apply partial quantity modifications
      for (const mod of partialMods) {
        const line = remainingLines.find(rl => rl.purchaseOrderReceiveLineId === mod.id);
        if (line) {
          line.quantity = {
            standardQuantity: mod.newQty.toFixed(4),
            uomQuantity: mod.newQty.toFixed(4),
          };
        }
      }

      const putBody: Record<string, unknown> = {
        purchaseOrderId: currentPO.purchaseOrderId,
        vendorId: currentPO.vendorId,
        receiveLines: remainingLines,
        unstockLines: currentPO.unstockLines || [],
        timestamp: currentPO.timestamp,
      };

      const result = await client.put<PurchaseOrder>('/purchase-orders', putBody);

      // Phase 6 — Build response summary
      const summary = {
        purchaseOrderId: result.purchaseOrderId || currentPO.purchaseOrderId,
        orderNumber: result.orderNumber || currentPO.orderNumber,
        previousStatus: currentPO.status,
        newStatus: result.status,
        removed,
        modified,
        remainingReceiveLines: result.receiveLines?.length ?? remainingLines.length,
        dryRun: false,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    }
  );
}
