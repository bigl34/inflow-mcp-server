import { describe, expect, it, vi } from 'vitest';
import type { InflowClient } from '../client/inflow.js';
import { CUSTOM_FIELD_KINDS_TTL_MS, indexCustomFieldKinds, loadCustomFieldKinds } from './custom-field-kinds.js';
import { customFieldDefinitionsList, TENANT_CUSTOM_FIELD_DEFINITIONS } from './custom-field-kinds.fixtures.js';

describe('custom field kinds', () => {
  it('indexes property names to lower-cased kinds for one entity type, case-insensitively', () => {
    expect(indexCustomFieldKinds(TENANT_CUSTOM_FIELD_DEFINITIONS, 'Product')).toEqual({
      custom1: 'text', custom2: 'checkbox', custom3: 'checkbox', custom4: 'date',
      custom5: 'checkbox', custom6: 'checkbox', custom7: 'checkbox', custom8: 'checkbox',
    });
    expect(indexCustomFieldKinds(TENANT_CUSTOM_FIELD_DEFINITIONS, 'salesOrder')).toEqual({
      custom1: 'checkbox', custom4: 'text', custom7: 'date', custom9: 'date', custom10: 'text',
    });
    expect(indexCustomFieldKinds(TENANT_CUSTOM_FIELD_DEFINITIONS, 'vendor')).toEqual({});
  });

  it('ignores malformed definition rows', () => {
    expect(indexCustomFieldKinds([
      { entityType: 'product', propertyName: 'custom1' },
      { entityType: 'product', customFieldType: 'checkbox' },
      { propertyName: 'custom2', customFieldType: 'checkbox' },
      { entityType: 'product', propertyName: 'custom3', customFieldType: 'Checkbox' },
    ], 'product')).toEqual({ custom3: 'checkbox' });
  });

  it('caches per client and entity type until the ttl elapses', async () => {
    const getList = vi.fn(customFieldDefinitionsList());
    const client = { getList } as unknown as InflowClient;
    const other = { getList: vi.fn(customFieldDefinitionsList()) } as unknown as InflowClient;
    const first = await loadCustomFieldKinds(client, 'product', 1_000);
    const second = await loadCustomFieldKinds(client, 'product', 1_000 + CUSTOM_FIELD_KINDS_TTL_MS - 1);
    expect(second).toBe(first);
    await loadCustomFieldKinds(client, 'salesOrder', 1_000);
    expect(getList).toHaveBeenCalledTimes(2);
    await loadCustomFieldKinds(client, 'product', 1_000 + CUSTOM_FIELD_KINDS_TTL_MS);
    expect(getList).toHaveBeenCalledTimes(3);
    await loadCustomFieldKinds(other, 'product', 1_000);
    expect(getList).toHaveBeenCalledTimes(3);
  });

  it('wraps provider failures and non-list responses in a stable error code', async () => {
    const failing = { getList: vi.fn(async () => { throw new Error('HTTP 429: Too Many Requests'); }) } as unknown as InflowClient;
    await expect(loadCustomFieldKinds(failing, 'product')).rejects.toThrow('CUSTOM_FIELD_DEFINITIONS_UNAVAILABLE: HTTP 429: Too Many Requests');
    const malformed = { getList: vi.fn(async () => ({ data: { nope: true } })) } as unknown as InflowClient;
    await expect(loadCustomFieldKinds(malformed, 'product')).rejects.toThrow(/^CUSTOM_FIELD_DEFINITIONS_UNAVAILABLE/);
  });
});
