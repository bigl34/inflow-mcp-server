import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MutationJournal, type MutationJournalRecord } from './mutation-journal.js';
import { createTempStateDir } from './temp-state.fixtures.js';

function record(): MutationJournalRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 'mutation-journal/v1',
    operationId: 'op-1',
    tenantFingerprint: 'tenant',
    resourceType: 'product',
    resourceId: 'p-1',
    adapterVersion: 'product/v1',
    desiredHash: 'desired',
    state: 'preview',
    createdAt: now,
    updatedAt: now,
    affectedResources: [{ type: 'product', id: 'p-1' }],
    invalidationTags: ['product:p-1'],
    steps: [],
  };
}

describe('mutation journal', () => {
  it('persists operations, idempotency, and step state atomically', async () => {
    const stateDir = await createTempStateDir('inflow-journal-');
    const journal = new MutationJournal(stateDir);
    await journal.put(record());
    expect(await journal.get('op-1')).toMatchObject({ desiredHash: 'desired' });
    await journal.putIdempotency('a'.repeat(64), {
      operationId: 'op-1',
      desiredHash: 'desired',
    });
    expect(await journal.getIdempotency('a'.repeat(64))).toEqual({
      operationId: 'op-1',
      desiredHash: 'desired',
    });
    await journal.appendStep('op-1', {
      stepId: 'write',
      kind: 'apply',
      intentHash: 'hash',
      plannedIds: ['p-1'],
      state: 'prepared',
      updatedAt: new Date().toISOString(),
      invalidationTags: ['product:p-1'],
    });
    expect((await journal.get('op-1'))?.steps).toHaveLength(1);
    expect(await readFile(join(stateDir, 'operations', 'op-1.json'), 'utf8')).not.toContain('apiKey');
  });

  it('rejects idempotency reuse for a different desired state', async () => {
    const stateDir = await createTempStateDir('inflow-journal-');
    const journal = new MutationJournal(stateDir);
    await journal.putIdempotency('b'.repeat(64), { operationId: 'a', desiredHash: 'one' });
    await expect(
      journal.putIdempotency('b'.repeat(64), { operationId: 'b', desiredHash: 'two' })
    ).rejects.toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
  });

  describe('restoreInputScope', () => {
    const keyHash = 'c'.repeat(64);
    const inputHash = 'd'.repeat(64);

    async function legacyCreate(overrides: Partial<MutationJournalRecord> = {}) {
      const stateDir = await createTempStateDir('inflow-journal-');
      const journal = new MutationJournal(stateDir);
      await journal.put({ ...record(), idempotencyKeyHash: keyHash, state: 'applied_unverified', ...overrides });
      await journal.putIdempotency(keyHash, { operationId: 'op-1', desiredHash: 'desired', plannedIds: { resourceIds: ['p-1'] } });
      return journal;
    }

    it('binds the input hash to both the legacy record and its idempotency mapping', async () => {
      const journal = await legacyCreate();
      const restored = await journal.restoreInputScope('op-1', inputHash);
      expect(restored).toMatchObject({ operationId: 'op-1', state: 'applied_unverified', inputHash });
      expect(await journal.get('op-1')).toMatchObject({ inputHash, desiredHash: 'desired' });
      expect(await journal.getIdempotency(keyHash)).toEqual({
        operationId: 'op-1', desiredHash: 'desired', plannedIds: { resourceIds: ['p-1'] }, inputHash,
      });
    });

    it('rejects malformed hashes and unknown operations', async () => {
      const journal = await legacyCreate();
      await expect(journal.restoreInputScope('op-1', 'nope')).rejects.toThrow(/INVALID_INPUT_HASH/);
      await expect(journal.restoreInputScope('op-9', inputHash)).rejects.toThrow(/UNKNOWN_OPERATION/);
      expect(await journal.getIdempotency(keyHash)).not.toHaveProperty('inputHash');
    });

    it('never rebinds a record or mapping that already carries an input scope', async () => {
      const journal = await legacyCreate();
      await journal.restoreInputScope('op-1', inputHash);
      await expect(journal.restoreInputScope('op-1', 'e'.repeat(64))).rejects.toThrow(/INPUT_SCOPE_ALREADY_BOUND/);
      expect(await journal.get('op-1')).toMatchObject({ inputHash });
      expect(await journal.getIdempotency(keyHash)).toMatchObject({ inputHash });
    });

    it.each([
      ['a terminal state', { state: 'applied_verified' as const }],
      ['an update with an observed current state', { currentSemanticHash: 'observed' }],
      ['a record without an idempotency mapping', { idempotencyKeyHash: undefined }],
    ])('refuses %s', async (_label, overrides) => {
      const journal = await legacyCreate(overrides);
      await expect(journal.restoreInputScope('op-1', inputHash)).rejects.toThrow(/INPUT_SCOPE_NOT_RESTORABLE/);
      expect(await journal.get('op-1')).not.toHaveProperty('inputHash');
      expect(await journal.getIdempotency(keyHash)).not.toHaveProperty('inputHash');
    });

    it('refuses a mapping that binds a different operation or desired state', async () => {
      const journal = await legacyCreate({ desiredHash: 'other' });
      await expect(journal.restoreInputScope('op-1', inputHash)).rejects.toThrow(/IDEMPOTENCY_MAPPING_MISMATCH/);
      expect(await journal.get('op-1')).not.toHaveProperty('inputHash');
      expect(await journal.getIdempotency(keyHash)).not.toHaveProperty('inputHash');
    });
  });
});
