import type { InflowClient } from '../client/inflow.js';

export type CustomFieldKinds = Readonly<Record<string, string>>;

interface CustomFieldDefinitionRow {
  entityType?: unknown;
  propertyName?: unknown;
  customFieldType?: unknown;
}

interface CachedKinds {
  kinds: CustomFieldKinds;
  expiresAt: number;
}

export const CUSTOM_FIELD_KINDS_TTL_MS = 5 * 60_000;

const kindsByClient = new WeakMap<InflowClient, Map<string, CachedKinds>>();

export function indexCustomFieldKinds(rows: readonly CustomFieldDefinitionRow[], entityType: string): CustomFieldKinds {
  const wanted = entityType.toLowerCase();
  const entries = rows
    .filter((row) =>
      typeof row.entityType === 'string' && row.entityType.toLowerCase() === wanted &&
      typeof row.propertyName === 'string' && typeof row.customFieldType === 'string')
    .map((row) => [row.propertyName as string, (row.customFieldType as string).toLowerCase()] as const);
  return Object.fromEntries(entries);
}

export async function loadCustomFieldKinds(
  client: InflowClient,
  entityType: string,
  now: number = Date.now()
): Promise<CustomFieldKinds> {
  const perClient = kindsByClient.get(client) ?? new Map<string, CachedKinds>();
  kindsByClient.set(client, perClient);
  const cached = perClient.get(entityType);
  if (cached && cached.expiresAt > now) return cached.kinds;
  let rows: CustomFieldDefinitionRow[];
  try {
    const response = await client.getList<CustomFieldDefinitionRow>('/custom-field-definitions', { pagination: { count: 100 } });
    rows = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CUSTOM_FIELD_DEFINITIONS_UNAVAILABLE: ${message}`);
  }
  if (!Array.isArray(rows)) throw new Error('CUSTOM_FIELD_DEFINITIONS_UNAVAILABLE: provider returned a non-list response');
  const kinds = indexCustomFieldKinds(rows, entityType);
  perClient.set(entityType, { kinds, expiresAt: now + CUSTOM_FIELD_KINDS_TTL_MS });
  return kinds;
}
