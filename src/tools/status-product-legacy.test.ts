import { describe, expect, it, vi } from 'vitest';
import type { InflowClient } from '../client/inflow.js';
import { canonicalHash } from '../core/canonical-json.js';
import { MutationJournal, type MutationJournalRecord } from '../core/mutation-journal.js';
import { createTempStateDir } from '../core/temp-state.fixtures.js';
import { customFieldDefinitionsList } from './custom-field-kinds.fixtures.js';
import { reconcileMutation } from './status.js';

describe('product reconciliation across adapter versions', () => {
  const READBACK = {
    productId: 'p-1', name: 'Fixture Component E', sku: 'TEST-COMPONENT-005', isActive: true, weight: '2.5000', timestamp: 't-2',
    customFields: { custom1: '', custom3: 'True', custom4: '', custom5: 'False' },
  };

  // The exact semantic projection every product/safe-v2..v4 build hashed: the
  // wire id plus all twelve writable fields of that era, null when absent.
  function legacyProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      productId: 'p-1', name: 'Fixture Component E', description: null, barcode: null, sku: 'TEST-COMPONENT-005', categoryId: null,
      isActive: true, cost: null, reorderPoint: null, reorderQuantity: null, weight: null, weightUnit: null,
      customFields: { custom1: '', custom3: true, custom4: '', custom5: false },
      ...overrides,
    };
  }

  function currentProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      productId: 'p-1', name: 'Fixture Component E', description: null, sku: 'TEST-COMPONENT-005', categoryId: null, isActive: true, weight: '2.5',
      customFields: { custom1: '', custom3: true, custom4: '', custom5: false },
      ...overrides,
    };
  }

  async function harness(adapterVersion: string, desiredProjection: Record<string, unknown>, readback: Record<string, unknown> = READBACK) {
    const journal = new MutationJournal(await createTempStateDir('inflow-product-status-versions-'));
    const desiredHash = canonicalHash(desiredProjection, `semantic/product/${adapterVersion}`);
    const record: MutationJournalRecord = {
      schemaVersion: 'mutation-journal/v1', operationId: `op-${adapterVersion.replace(/[^A-Za-z0-9_-]/g, '-')}`, tenantFingerprint: 'tenant',
      resourceType: 'product', resourceId: 'p-1', adapterVersion, desiredHash,
      state: 'applied_unverified', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      affectedResources: [{ type: 'product', id: 'p-1' }], invalidationTags: ['product:p-1', 'bom:p-1'],
      steps: [{ stepId: 'write', kind: 'apply', intentHash: desiredHash, plannedIds: [], state: 'failed', errorCode: 'VERIFICATION_MISMATCH', updatedAt: new Date().toISOString(), invalidationTags: ['product:p-1', 'bom:p-1'] }],
    };
    await journal.put(record);
    const client = { getList: customFieldDefinitionsList(), get: vi.fn(async () => ({ ...readback })) } as unknown as InflowClient;
    return reconcileMutation(client, journal, record);
  }

  it.each(['product/safe-v2', 'product/safe-v3', 'product/safe-v4'])(
    'advances a %s record whose twelve-field desired projection matches the canonical readback',
    async (adapterVersion) => {
      const result = await harness(adapterVersion, legacyProjection({ weight: '2.5' }));
      expect(result.reconciliation).toMatchObject({ attempted: true, advanced: true, provenState: 'applied_verified' });
      expect(result.record.state).toBe('applied_verified');
    }
  );

  it('keeps a legacy record stuck when it wrote a field the provider never stored', async () => {
    const result = await harness('product/safe-v3', legacyProjection({ cost: '12.5', weight: '2.5' }));
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: false, reasonCode: 'DESIRED_STATE_NOT_OBSERVED' });
  });

  it('keeps a legacy record stuck when the readback differs on a still-writable field', async () => {
    const result = await harness('product/safe-v3', legacyProjection({ weight: '2.5', sku: 'OTHER' }));
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: false, reasonCode: 'DESIRED_STATE_NOT_OBSERVED' });
  });

  it('advances a product/safe-v5 record against the seven-field projection with the four-decimal weight echo', async () => {
    const result = await harness('product/safe-v5', currentProjection());
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: true, provenState: 'applied_verified' });
  });

  it('does not let a safe-v5 record match the legacy thirteen-key shape', async () => {
    const result = await harness('product/safe-v5', legacyProjection({ weight: '2.5' }));
    expect(result.reconciliation).toMatchObject({ attempted: true, advanced: false, reasonCode: 'DESIRED_STATE_NOT_OBSERVED' });
  });
});
