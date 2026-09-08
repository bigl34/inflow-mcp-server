import type { InflowClient } from '../client/inflow.js';
import {
  ZERO_DECIMAL,
  addDecimal,
  compareDecimal,
  decimalToString,
  maxDecimal,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  type ExactDecimal,
} from '../core/decimal.js';
import type { ItemBom, Product, ProductSummary } from '../types/inflow.js';
import { fetchInventorySummaries, stockAtLocation } from './inventory-summaries.js';

interface Edge { childProductId: string; quantity: ExactDecimal; uom: string | null }
interface Graph { products: Map<string, Product>; edges: Map<string, Edge[]>; warnings: string[]; complete: boolean }

function add(map: Map<string, ExactDecimal>, id: string, quantity: ExactDecimal): void {
  map.set(id, addDecimal(map.get(id) ?? ZERO_DECIMAL, quantity));
}

function positive(value: ExactDecimal): ExactDecimal { return maxDecimal(value, ZERO_DECIMAL); }

function edgeFromBom(row: ItemBom): Edge {
  if (!row.childProductId) throw new Error('BOM_COMPONENT_MISSING_PRODUCT_ID');
  if (row.quantity?.standardQuantity === undefined) throw new Error(`BOM_COMPONENT_MISSING_QUANTITY: ${row.childProductId}`);
  const quantity = parseDecimal(row.quantity.standardQuantity);
  if (compareDecimal(quantity, ZERO_DECIMAL) <= 0) throw new Error(`BOM_COMPONENT_INVALID_QUANTITY: ${row.childProductId}`);
  return { childProductId: row.childProductId, quantity, uom: row.quantity.uom?.trim() || null };
}

async function loadGraph(client: InflowClient, rootId: string, maxDepth: number, maxProducts: number, mode: 'direct' | 'leaf' | 'net'): Promise<Graph> {
  const products = new Map<string, Product>();
  const edges = new Map<string, Edge[]>();
  const warnings: string[] = [];
  let complete = true;
  const visiting: string[] = [];
  const visit = async (id: string, depth: number): Promise<void> => {
    if (visiting.includes(id)) throw new Error(`BOM_CYCLE: ${[...visiting.slice(visiting.indexOf(id)), id].join(' -> ')}`);
    if (products.has(id)) return;
    if (depth > maxDepth) throw new Error(`BOM_MAX_DEPTH_EXCEEDED: ${maxDepth}`);
    if (products.size >= maxProducts) throw new Error(`BOM_MAX_PRODUCTS_EXCEEDED: ${maxProducts}`);
    visiting.push(id);
    let product: Product;
    try {
      product = await client.get<Product>(`/products/${id}`, { include: ['itemBoms'] });
    } catch (error) {
      visiting.pop();
      if (depth === 0) throw error;
      complete = false;
      warnings.push(`PRODUCT_ENRICHMENT_FAILED: ${id}`);
      products.set(id, { productId: id, name: '', itemBoms: [] });
      edges.set(id, []);
      return;
    }
    products.set(id, product);
    const children: Edge[] = [];
    for (const row of mode === 'direct' && depth > 0 ? [] : product.itemBoms ?? []) {
      try { children.push(edgeFromBom(row)); }
      catch (error) {
        complete = false;
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    children.sort((a, b) => a.childProductId.localeCompare(b.childProductId));
    edges.set(id, children);
    for (const edge of children) await visit(edge.childProductId, depth + 1);
    visiting.pop();
  };
  await visit(rootId, 0);
  const componentUoms = new Map<string, Set<string>>();
  for (const rows of edges.values()) {
    for (const edge of rows) {
      const units = componentUoms.get(edge.childProductId) ?? new Set<string>();
      units.add(edge.uom ?? '<standard>');
      componentUoms.set(edge.childProductId, units);
    }
  }
  for (const [productId, units] of componentUoms) {
    if (units.size > 1) {
      complete = false;
      warnings.push(`INCOMPATIBLE_UOM_PATHS: ${productId}: ${[...units].sort().join(',')}`);
    }
  }
  return { products, edges, warnings: [...new Set(warnings)].sort(), complete };
}

interface AllocationRow {
  productId: string;
  productName: string | null;
  productSku: string | null;
  grossRequired: string;
  stock: string | null;
  usableStock: string;
  consumedStock: string;
  requestedBuildShortage: string;
  existingDeficit: string;
  totalReplenishmentShortfall: string;
  isLeaf: boolean;
}

function allocate(args: {
  graph: Graph;
  rootId: string;
  buildQuantity: ExactDecimal;
  mode: 'direct' | 'leaf' | 'net';
  summaries: Map<string, ProductSummary>;
  locationId: string;
  stockBasis: 'available' | 'onHand';
}): { direct: Map<string, ExactDecimal>; rows: AllocationRow[]; feasible: boolean; complete: boolean; warnings: string[] } {
  const { graph, rootId } = args;
  const indegree = new Map<string, number>();
  for (const id of graph.products.keys()) indegree.set(id, 0);
  for (const [parent, children] of graph.edges) {
    if (parent === rootId || graph.products.has(parent)) {
      for (const edge of children) indegree.set(edge.childProductId, (indegree.get(edge.childProductId) ?? 0) + 1);
    }
  }
  const demand = new Map<string, ExactDecimal>([[rootId, args.buildQuantity]]);
  const direct = new Map<string, ExactDecimal>();
  const rootChildren = new Set((graph.edges.get(rootId) ?? []).map((edge) => edge.childProductId));
  const rows: AllocationRow[] = [];
  const warnings = [...graph.warnings];
  let complete = graph.complete;
  const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id).sort();
  while (queue.length) {
    const id = queue.shift()!;
    const gross = demand.get(id) ?? ZERO_DECIMAL;
    const children = graph.edges.get(id) ?? [];
    const leaf = children.length === 0;
    const needsStock = id !== rootId && (
      args.mode === 'direct' ? rootChildren.has(id) :
      args.mode === 'leaf' ? leaf : true
    );
    const rawStock = needsStock ? stockAtLocation(args.summaries.get(id), args.locationId, args.stockBasis) : '0';
    if (needsStock && rawStock === undefined) {
      complete = false;
      warnings.push(`MISSING_LOCATION_SUMMARY: ${id}`);
    }
    const stock = parseDecimal(rawStock ?? '0');
    const existingDeficit = stock.coefficient < 0n ? subtractDecimal(ZERO_DECIMAL, stock) : ZERO_DECIMAL;
    const usable = positive(stock);
    const consumeHere = args.mode === 'net' || leaf || args.mode === 'direct';
    const consumed = consumeHere && compareDecimal(gross, usable) <= 0 ? gross : consumeHere ? usable : ZERO_DECIMAL;
    const unmet = consumeHere ? positive(subtractDecimal(gross, usable)) : gross;
    if (id !== rootId && (args.mode === 'direct' || leaf || args.mode === 'net')) {
      rows.push({
        productId: id,
        productName: graph.products.get(id)?.name ?? null,
        productSku: graph.products.get(id)?.sku ?? null,
        grossRequired: decimalToString(gross),
        stock: rawStock ?? null,
        usableStock: decimalToString(usable),
        consumedStock: decimalToString(consumed),
        requestedBuildShortage: decimalToString(unmet),
        existingDeficit: decimalToString(existingDeficit),
        totalReplenishmentShortfall: decimalToString(addDecimal(unmet, existingDeficit)),
        isLeaf: leaf,
      });
    }
    if (id === rootId || (args.mode !== 'direct' && !leaf)) {
      const quantityToExplode = id === rootId ? gross : args.mode === 'net' ? unmet : gross;
      for (const edge of children) {
        const contribution = multiplyDecimal(quantityToExplode, edge.quantity);
        add(demand, edge.childProductId, contribution);
        if (id === rootId) add(direct, edge.childProductId, contribution);
      }
    }
    for (const edge of children) {
      indegree.set(edge.childProductId, (indegree.get(edge.childProductId) ?? 1) - 1);
      if (indegree.get(edge.childProductId) === 0) {
        queue.push(edge.childProductId);
        queue.sort();
      }
    }
  }
  const relevantRows = args.mode === 'leaf' ? rows.filter((row) => row.isLeaf) : args.mode === 'direct' ? rows.filter((row) => direct.has(row.productId)) : rows;
  return {
    direct,
    rows: relevantRows.sort((a, b) => a.productId.localeCompare(b.productId)),
    feasible: relevantRows.every((row) => parseDecimal(row.requestedBuildShortage).coefficient === 0n),
    complete,
    warnings: [...new Set(warnings)].sort(),
  };
}

export async function calculateBomRequirements(client: InflowClient, input: {
  productId: string;
  buildQuantity: string;
  locationId: string;
  mode: 'direct' | 'leaf' | 'net';
  stockBasis: 'available' | 'onHand';
  maxDepth: number;
  maxProducts: number;
}) {
  const buildQuantity = parseDecimal(input.buildQuantity);
  if (compareDecimal(buildQuantity, ZERO_DECIMAL) <= 0) throw new Error('BUILD_QUANTITY_MUST_BE_POSITIVE');
  const graph = await loadGraph(client, input.productId, input.maxDepth, input.maxProducts, input.mode);
  const ids = input.mode === 'direct'
    ? (graph.edges.get(input.productId) ?? []).map((edge) => edge.childProductId).sort()
    : [...graph.products.keys()].filter((id) => id !== input.productId).sort();
  const inventory = await fetchInventorySummaries(client, ids);
  const allocation = allocate({ graph, rootId: input.productId, buildQuantity, mode: input.mode, summaries: inventory.summaries, locationId: input.locationId, stockBasis: input.stockBasis });
  let maximumBuildable: string | null = null;
  const warnings = [...allocation.warnings];
  if (allocation.complete && inventory.missingProductIds.length === 0) {
    let low = 0n;
    let high = 1n;
    const feasible = (quantity: bigint) => allocate({ graph, rootId: input.productId, buildQuantity: parseDecimal(quantity.toString()), mode: input.mode, summaries: inventory.summaries, locationId: input.locationId, stockBasis: input.stockBasis }).feasible;
    const cap = 1_000_000_000n;
    while (high < cap && feasible(high)) { low = high; high *= 2n; }
    if (high >= cap && feasible(cap)) {
      maximumBuildable = cap.toString();
      warnings.push('MAX_BUILDABLE_SEARCH_CAP_REACHED');
    } else {
      if (high > cap) high = cap;
      while (low + 1n < high) {
        const middle = (low + high) / 2n;
        if (feasible(middle)) low = middle; else high = middle;
      }
      maximumBuildable = low.toString();
    }
  }
  return {
    schemaVersion: 'bom-requirements/v1',
    productId: input.productId,
    buildQuantity: decimalToString(buildQuantity),
    locationId: input.locationId,
    mode: input.mode,
    stockBasis: input.stockBasis,
    complete: allocation.complete && inventory.missingProductIds.length === 0,
    directRequirements: [...allocation.direct.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([productId, quantity]) => ({ productId, quantity: decimalToString(quantity) })),
    requirements: allocation.rows,
    shortages: allocation.rows.filter((row) => parseDecimal(row.requestedBuildShortage).coefficient > 0n),
    limitingComponents: allocation.rows.filter((row) => parseDecimal(row.requestedBuildShortage).coefficient > 0n).map((row) => row.productId).sort(),
    maximumBuildable,
    missingProductIds: inventory.missingProductIds,
    warnings: [...new Set(warnings)].sort(),
    snapshotNote: 'Read-time warehouse snapshot; concurrent reservations or movements may change availability.',
  };
}
