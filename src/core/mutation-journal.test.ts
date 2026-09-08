import { mkdtemp, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MutationJournal, type MutationJournalRecord } from './mutation-journal.js';

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
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-journal-'));
    await chmod(stateDir, 0o700);
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
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-journal-'));
    await chmod(stateDir, 0o700);
    const journal = new MutationJournal(stateDir);
    await journal.putIdempotency('b'.repeat(64), { operationId: 'a', desiredHash: 'one' });
    await expect(
      journal.putIdempotency('b'.repeat(64), { operationId: 'b', desiredHash: 'two' })
    ).rejects.toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
  });
});
