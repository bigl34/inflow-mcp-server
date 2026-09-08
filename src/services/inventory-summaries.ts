import type { InflowClient } from '../client/inflow.js';
import { normalizeDecimal } from '../core/decimal.js';
import type { InventoryLine, Product, ProductSummary } from '../types/inflow.js';

type JsonApiSummary = { id?: string; attributes?: Partial<ProductSummary> };
type QuantityLike = string | number | null | undefined;
type AvailabilityRow = {
  quantityOnHand?: QuantityLike;
  quantityAvailable?: QuantityLike;
  rawQuantityAvailable?: QuantityLike;
  quantityReserved?: QuantityLike;
  quantityReservedForSales?: QuantityLike;
  quantityReservedForManufacturing?: QuantityLike;
  quantityReservedForTransfers?: QuantityLike;
  quantityReservedForBuilds?: QuantityLike;
  quantityPicked?: QuantityLike;
};

function exact(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('INVALID_INVENTORY_DECIMAL');
  return normalizeDecimal(value);
}

function optionalExact(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : exact(value);
}

function quantityNumber(value: QuantityLike): number {
  if (value === undefined || value === null || value === '') return Number.NaN;
  try {
    const parsed = Number(normalizeDecimal(value));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function canonicalAvailabilityDimensions(row: AvailabilityRow): {
  rawQuantityAvailable?: string | null;
  quantityReserved?: string | null;
  quantityReservedForSales?: string | null;
  quantityReservedForManufacturing?: string | null;
  quantityReservedForTransfers?: string | null;
  quantityReservedForBuilds?: string | null;
  quantityPicked?: string | null;
} {
  return {
    ...(row.rawQuantityAvailable === undefined
      ? {}
      : { rawQuantityAvailable: optionalExact(row.rawQuantityAvailable) ?? null }),
    ...(row.quantityReserved === undefined
      ? {}
      : { quantityReserved: optionalExact(row.quantityReserved) ?? null }),
    ...(row.quantityReservedForSales === undefined
      ? {}
      : {
          quantityReservedForSales:
            optionalExact(row.quantityReservedForSales) ?? null,
        }),
    ...(row.quantityReservedForManufacturing === undefined
      ? {}
      : {
          quantityReservedForManufacturing:
            optionalExact(row.quantityReservedForManufacturing) ?? null,
        }),
    ...(row.quantityReservedForTransfers === undefined
      ? {}
      : {
          quantityReservedForTransfers:
            optionalExact(row.quantityReservedForTransfers) ?? null,
        }),
    ...(row.quantityReservedForBuilds === undefined
      ? {}
      : {
          quantityReservedForBuilds:
            optionalExact(row.quantityReservedForBuilds) ?? null,
        }),
    ...(row.quantityPicked === undefined
      ? {}
      : { quantityPicked: optionalExact(row.quantityPicked) ?? null }),
  };
}

export function effectiveBuildRunAvailableQuantity(
  row: AvailabilityRow | undefined,
  options: {
    allowBuildReserved: boolean;
    ownedBuildReservedQuantity?: number;
    ownedManufacturingReservedQuantity?: number;
    requiredQuantity: number;
  }
): number {
  const available = quantityNumber(row?.quantityAvailable);
  if (
    !options.allowBuildReserved ||
    !Number.isFinite(available) ||
    !Number.isFinite(options.requiredQuantity) ||
    options.requiredQuantity <= 0 ||
    available >= options.requiredQuantity
  ) {
    return available;
  }

  const parsedBuildReserved = quantityNumber(row?.quantityReservedForBuilds);
  const parsedManufacturingReserved = quantityNumber(
    row?.quantityReservedForManufacturing
  );
  const totalReserved = quantityNumber(row?.quantityReserved);
  const salesReserved = quantityNumber(row?.quantityReservedForSales);
  const transferReserved = quantityNumber(row?.quantityReservedForTransfers);
  const picked = quantityNumber(row?.quantityPicked);
  const reservationDimensions = [
    totalReserved,
    parsedBuildReserved,
    parsedManufacturingReserved,
    salesReserved,
    transferReserved,
    picked,
  ];
  if (
    !reservationDimensions.every(Number.isFinite) ||
    reservationDimensions.some((quantity) => quantity < 0) ||
    totalReserved !==
      parsedBuildReserved +
        parsedManufacturingReserved +
        salesReserved +
        transferReserved +
        picked
  ) {
    return available;
  }
  const ownedBuildReserved =
    Number.isFinite(options.ownedBuildReservedQuantity) &&
    options.ownedBuildReservedQuantity === parsedBuildReserved
      ? parsedBuildReserved
      : 0;
  const ownedManufacturingReserved =
    Number.isFinite(options.ownedManufacturingReservedQuantity) &&
    options.ownedManufacturingReservedQuantity === parsedManufacturingReserved
      ? parsedManufacturingReserved
      : 0;
  const hasExactOwnedProjection =
    ownedBuildReserved > 0 || ownedManufacturingReserved > 0;
  if (hasExactOwnedProjection) {
    const ownedProjection = ownedBuildReserved + ownedManufacturingReserved;
    if (
      totalReserved !== ownedProjection ||
      salesReserved !== 0 ||
      transferReserved !== 0 ||
      picked !== 0 ||
      (ownedBuildReserved === 0 && parsedBuildReserved !== 0) ||
      (ownedManufacturingReserved === 0 && parsedManufacturingReserved !== 0)
    ) {
      return available;
    }
  }
  const currentRunReserved = hasExactOwnedProjection
    ? ownedBuildReserved + ownedManufacturingReserved
    : parsedBuildReserved;
  if (
    currentRunReserved <= 0 ||
    available + currentRunReserved < options.requiredQuantity
  ) {
    return available;
  }

  const directReserved =
    salesReserved +
    (ownedManufacturingReserved > 0 ? 0 : parsedManufacturingReserved) +
    transferReserved +
    picked;
  if (directReserved > 0) return available;
  if (totalReserved !== currentRunReserved + directReserved) {
    return available;
  }

  const onHand = quantityNumber(row?.quantityOnHand);
  const rawAvailable = quantityNumber(row?.rawQuantityAvailable);
  const physical = Math.max(
    Number.isFinite(onHand) ? onHand : Number.NEGATIVE_INFINITY,
    Number.isFinite(rawAvailable) ? rawAvailable : Number.NEGATIVE_INFINITY
  );
  if (!Number.isFinite(physical) || physical < options.requiredQuantity) {
    return available;
  }

  return Math.min(physical, available + currentRunReserved);
}

export function normalizeProductSummary(row: ProductSummary | JsonApiSummary): ProductSummary {
  const jsonApi = row as JsonApiSummary;
  const value: Partial<ProductSummary> = jsonApi.attributes !== undefined
    ? { productId: jsonApi.attributes.productId ?? jsonApi.id, ...jsonApi.attributes }
    : row as ProductSummary;
  if (!value.productId) throw new Error('INVALID_PRODUCT_SUMMARY: missing productId');
  return {
    productId: value.productId,
    quantityOnHand: exact(value.quantityOnHand ?? '0'),
    quantityAvailable: exact(value.quantityAvailable ?? '0'),
    quantityOnOrder: exact(value.quantityOnOrder ?? '0'),
    quantityAllocated: exact(value.quantityAllocated ?? '0'),
    rawQuantityAvailable: optionalExact(value.rawQuantityAvailable),
    quantityReserved: optionalExact(value.quantityReserved),
    quantityReservedForSales: optionalExact(value.quantityReservedForSales),
    quantityReservedForManufacturing: optionalExact(value.quantityReservedForManufacturing),
    quantityReservedForTransfers: optionalExact(value.quantityReservedForTransfers),
    quantityReservedForBuilds: optionalExact(value.quantityReservedForBuilds),
    quantityPicked: optionalExact(value.quantityPicked),
    locationSummaries: (value.locationSummaries ?? []).map((location) => ({
      ...location,
      quantityOnHand: exact(location.quantityOnHand ?? '0'),
      quantityAvailable: exact(location.quantityAvailable ?? '0'),
      rawQuantityAvailable: optionalExact(location.rawQuantityAvailable),
      quantityReserved: optionalExact(location.quantityReserved),
      quantityReservedForSales: optionalExact(location.quantityReservedForSales),
      quantityReservedForManufacturing: optionalExact(location.quantityReservedForManufacturing),
      quantityReservedForTransfers: optionalExact(location.quantityReservedForTransfers),
      quantityReservedForBuilds: optionalExact(location.quantityReservedForBuilds),
      quantityPicked: optionalExact(location.quantityPicked),
      sublocationSummaries: (location.sublocationSummaries ?? []).map((sub) => ({
        ...sub,
        quantityOnHand: exact(sub.quantityOnHand ?? '0'),
        quantityAvailable: optionalExact(sub.quantityAvailable),
        rawQuantityAvailable: optionalExact(sub.rawQuantityAvailable),
        quantityReserved: optionalExact(sub.quantityReserved),
        quantityReservedForSales: optionalExact(sub.quantityReservedForSales),
        quantityReservedForManufacturing: optionalExact(sub.quantityReservedForManufacturing),
        quantityReservedForTransfers: optionalExact(sub.quantityReservedForTransfers),
        quantityReservedForBuilds: optionalExact(sub.quantityReservedForBuilds),
        quantityPicked: optionalExact(sub.quantityPicked),
      })),
    })),
  };
}

export async function fetchInventorySummaries(client: InflowClient, productIds: string[]): Promise<{
  summaries: Map<string, ProductSummary>;
  missingProductIds: string[];
}> {
  const summaries = new Map<string, ProductSummary>();
  for (let index = 0; index < productIds.length; index += 100) {
    const ids = productIds.slice(index, index + 100);
    const response = await client.postRead<Array<ProductSummary | JsonApiSummary> | { data: Array<ProductSummary | JsonApiSummary> }>(
      '/products/summary',
      ids.map((productId) => ({ productId }))
    );
    const rows = Array.isArray(response) ? response : response.data;
    for (const row of rows) {
      const normalized = normalizeProductSummary(row);
      if (ids.includes(normalized.productId)) summaries.set(normalized.productId, normalized);
    }
  }
  return { summaries, missingProductIds: productIds.filter((id) => !summaries.has(id)) };
}

export function stockAtLocation(summary: ProductSummary | undefined, locationId: string, basis: 'available' | 'onHand'): string | undefined {
  const location = summary?.locationSummaries?.find((row) => row.locationId === locationId);
  return location ? (basis === 'available' ? location.quantityAvailable : location.quantityOnHand) : undefined;
}

export interface CanonicalInventorySummaryRow {
  productId: string;
  quantityOnHand: string;
  quantityAvailable: string;
  quantityOnOrder: string;
  quantityAllocated: string;
  rawQuantityAvailable?: string | null;
  quantityReserved?: string | null;
  quantityReservedForSales?: string | null;
  quantityReservedForManufacturing?: string | null;
  quantityReservedForTransfers?: string | null;
  quantityReservedForBuilds?: string | null;
  quantityPicked?: string | null;
  locations: Array<{
    locationId: string;
    quantityOnHand: string;
    quantityAvailable: string;
    rawQuantityAvailable?: string | null;
    quantityReserved?: string | null;
    quantityReservedForSales?: string | null;
    quantityReservedForManufacturing?: string | null;
    quantityReservedForTransfers?: string | null;
    quantityReservedForBuilds?: string | null;
    quantityPicked?: string | null;
    sublocations: Array<{
      sublocation: string;
      quantityOnHand: string;
      quantityAvailable: string;
      rawQuantityAvailable?: string | null;
      quantityReserved?: string | null;
      quantityReservedForSales?: string | null;
      quantityReservedForManufacturing?: string | null;
      quantityReservedForTransfers?: string | null;
      quantityReservedForBuilds?: string | null;
      quantityPicked?: string | null;
    }>;
  }>;
}

/**
 * Semantic inventory projection used by the manufacturing live canary. It
 * intentionally excludes display names and provider metadata while retaining
 * every quantity dimension that can prove exact stock restoration.
 */
export function canonicalInventorySummaryProjection(
  rows: Array<ProductSummary | JsonApiSummary>
): CanonicalInventorySummaryRow[] {
  return rows.map(normalizeProductSummary).map((row) => ({
    productId: row.productId,
    quantityOnHand: exact(row.quantityOnHand),
    quantityAvailable: exact(row.quantityAvailable),
    quantityOnOrder: exact(row.quantityOnOrder),
    quantityAllocated: exact(row.quantityAllocated),
    ...canonicalAvailabilityDimensions(row),
    locations: (row.locationSummaries ?? []).map((location) => ({
      locationId: location.locationId,
      quantityOnHand: exact(location.quantityOnHand),
      quantityAvailable: exact(location.quantityAvailable),
      ...canonicalAvailabilityDimensions(location),
      sublocations: (location.sublocationSummaries ?? []).map((sublocation) => ({
        sublocation: sublocation.sublocation ?? '',
        quantityOnHand: exact(sublocation.quantityOnHand),
        quantityAvailable: exact(sublocation.quantityAvailable ?? '0'),
        ...canonicalAvailabilityDimensions(sublocation),
      })).sort((left, right) => left.sublocation.localeCompare(right.sublocation)),
    })).sort((left, right) => left.locationId.localeCompare(right.locationId)),
  })).sort((left, right) => left.productId.localeCompare(right.productId));
}

export interface WatchedSerialIdentity {
  productId: string;
  serial: string;
}

export interface CanonicalSerialInventoryRow extends WatchedSerialIdentity {
  holdings: Array<{
    locationId: string;
    sublocation: string;
    quantityOnHand: string;
  }>;
}

type ProductWithInventory = Pick<Product, 'productId' | 'inventoryLines'> & {
  id?: string;
  attributes?: { productId?: string; inventoryLines?: InventoryLine[] };
};

/**
 * Exact watched-serial projection. Missing watched serials remain represented
 * with an empty holdings array, so removal and movement are hash-significant.
 * Multiple positive holdings for one product/serial are rejected as an
 * ambiguous provider state instead of being normalized into false certainty.
 */
export function canonicalSerialInventoryProjection(
  products: ProductWithInventory[],
  watchedSerials: WatchedSerialIdentity[]
): CanonicalSerialInventoryRow[] {
  const inventoryByProduct = new Map<string, InventoryLine[]>();
  for (const product of products) {
    const productId = product.attributes?.productId ?? product.productId ?? product.id;
    if (!productId) throw new Error('INVALID_SERIAL_INVENTORY_PRODUCT: missing productId');
    inventoryByProduct.set(productId, product.attributes?.inventoryLines ?? product.inventoryLines ?? []);
  }
  const identities = watchedSerials.map((identity) => ({
    productId: identity.productId.normalize('NFKC').trim(),
    serial: identity.serial.normalize('NFKC').trim().toUpperCase(),
  })).sort((left, right) =>
    left.productId.localeCompare(right.productId) || left.serial.localeCompare(right.serial)
  );
  const seen = new Set<string>();
  return identities.map((identity) => {
    const key = `${identity.productId}\0${identity.serial}`;
    if (!identity.productId || !identity.serial || seen.has(key)) {
      throw new Error('INVALID_WATCHED_SERIAL_IDENTITY');
    }
    seen.add(key);
    const holdings = (inventoryByProduct.get(identity.productId) ?? [])
      .filter((line) => line.serial?.normalize('NFKC').trim().toUpperCase() === identity.serial)
      .map((line) => ({
        locationId: line.locationId ?? '',
        sublocation: line.sublocation ?? '',
        quantityOnHand: exact(line.quantityOnHand ?? '0'),
      }))
      .filter((line) => line.quantityOnHand !== '0')
      .sort((left, right) =>
        left.locationId.localeCompare(right.locationId) ||
        left.sublocation.localeCompare(right.sublocation)
      );
    if (holdings.length > 1) {
      throw new Error(`CANARY_SERIAL_DUPLICATE_POSITIVE_STOCK: ${identity.productId}:${identity.serial}`);
    }
    return { ...identity, holdings };
  });
}
