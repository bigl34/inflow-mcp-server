import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from './canonical-json.js';

const storeModule = await import('./manufacturing-run-store.js').catch(() => ({}));
const MODE_ENFORCING_TEMP_ROOT =
  process.platform === 'win32' ? tmpdir() : '/tmp';

function Store(): new (options: Record<string, unknown>) => any {
  const value = (storeModule as Record<string, unknown>).ManufacturingRunStore;
  expect(value, 'ManufacturingRunStore must be exported').toBeTypeOf('function');
  return value as new (options: Record<string, unknown>) => any;
}

async function statePath(prefix = 'inflow-manufacturing-store-'): Promise<string> {
  const directory = await mkdtemp(join(MODE_ENFORCING_TEMP_ROOT, prefix));
  await chmod(directory, 0o700);
  expect((await stat(directory)).mode & 0o077).toBe(0);
  return join(directory, 'manufacturing-runs.sqlite');
}

function runInput(
  suffix: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    operationId: `operation-${suffix}`,
    idempotencyKeyHash: `${suffix}`.padEnd(64, 'a').slice(0, 64),
    canonicalIdentity: {
      companyId: 'company-1',
      finishedProductId: `finished-${suffix}`,
      finishedSerial: `SERIAL-${suffix.toUpperCase()}`,
      parentRunHash: null,
      parentRawLineId: null,
    },
    runHash: `run-hash-${suffix}`,
    immutableIntentHash: `immutable-${suffix}`,
    manufacturingOrderId: `mo-${suffix}`,
    rootLineId: `root-${suffix}`,
    coordinatorMarker: `marker-${suffix}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function dependentBeginInput(
  parentSuffix: string,
  childSuffix: string,
  expectedParentStateRevision: number
): Record<string, unknown> {
  const parentRunHash = `run-hash-${parentSuffix}`;
  const parentRawLineId = 'raw-component-1';
  const child = runInput(childSuffix, {
    canonicalIdentity: {
      companyId: 'company-1',
      finishedProductId: 'component-product-1',
      finishedSerial: `SERIAL-${childSuffix.toUpperCase()}`,
      parentRunHash,
      parentRawLineId,
    },
    parentOperationId: `operation-${parentSuffix}`,
    parentRawLineId,
  });
  return {
    parentOperationId: `operation-${parentSuffix}`,
    parentRawLineId,
    expectedParentStateRevision,
    expectedParentProductId: 'component-product-1',
    run: child,
    artifact: {
      artifactType: 'begin_plan',
      artifactHash: `artifact-hash-${childSuffix}`,
      artifact: { child: childSuffix },
      at: '2026-01-01T00:00:01.000Z',
    },
  };
}

async function expectDataInvariantFailure(
  setup: (store: any) => void,
  corrupt: (database: any) => void,
  expected: RegExp
): Promise<void> {
  const databasePath = await statePath('inflow-manufacturing-invariant-');
  const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
  store.initialize();
  setup(store);
  store.close();

  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const database = new BetterSqlite3(databasePath);
  database.pragma('foreign_keys = OFF');
  corrupt(database);
  database.close();
  await chmod(databasePath, 0o600);

  expect(() => {
    const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
    reopened.initialize();
  }).toThrow(expected);
}

describe('manufacturing run store startup and migrations', () => {
  it('exports the authoritative store', () => {
    expect(Store()).toBeTypeOf('function');
  });

  it('uses WAL, FULL synchronous durability, foreign keys, busy timeout, and user_version', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    expect(store.getStartupDiagnostics()).toMatchObject({
      writeGateOpen: true,
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      busyTimeoutMs: 5_000,
      userVersion: 3,
    });
    store.close();
    expect((await stat(databasePath)).mode & 0o077).toBe(0);
  });

  it('migrates a version-zero database transactionally and rejects future schemas', async () => {
    const databasePath = await statePath();
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const raw = new BetterSqlite3(databasePath);
    raw.exec('CREATE TABLE pre_migration_marker (value TEXT NOT NULL)');
    raw.close();
    await chmod(databasePath, 0o600);

    const migrated = new (Store())({ databasePath, minimumFreeBytes: 0 });
    migrated.initialize();
    expect(migrated.getStartupDiagnostics().userVersion).toBe(3);
    migrated.close();

    const future = new BetterSqlite3(databasePath);
    future.pragma('user_version = 99');
    future.close();
    await expect(() => {
      const unsupported = new (Store())({ databasePath, minimumFreeBytes: 0 });
      unsupported.initialize();
    }).toThrow(/UNSUPPORTED_SCHEMA/);
  });

  it('migrates a legacy v1 store after retention removed every transition', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('legacy-retention'));
    store.close();

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const legacy = new BetterSqlite3(databasePath);
    legacy.exec(`
      DELETE FROM run_transitions
      WHERE operation_id = 'operation-legacy-retention';
      UPDATE schema_metadata
      SET value = '1'
      WHERE key = 'schema_version';
      PRAGMA user_version = 1;
    `);
    legacy.close();
    await chmod(databasePath, 0o600);

    const migrated = new (Store())({ databasePath, minimumFreeBytes: 0 });
    migrated.initialize();
    expect(migrated.getStartupDiagnostics().userVersion).toBe(3);
    expect(migrated.listTransitions('operation-legacy-retention')).toEqual([
      expect.objectContaining({
        fromState: null,
        toState: 'creating',
        stateRevision: 0,
        reason: 'schema_v2_retention_checkpoint',
      }),
    ]);
    migrated.close();
  });

  it('rejects a replaced legacy v1 store before migration mutates it', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('replaced-legacy'));
    store.close();

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const replacement = new BetterSqlite3(databasePath);
    replacement.exec(`
      DELETE FROM run_transitions
      WHERE operation_id = 'operation-replaced-legacy';
      UPDATE schema_metadata
      SET value = '1'
      WHERE key = 'schema_version';
      UPDATE schema_metadata
      SET value = 'replacement-store-instance'
      WHERE key = 'store_instance_id';
      PRAGMA user_version = 1;
    `);
    replacement.close();
    await chmod(databasePath, 0o600);

    expect(() => {
      const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
      reopened.initialize();
    }).toThrow(/DATABASE_REPLACED_AFTER_USE/);

    const unchanged = new BetterSqlite3(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(1);
    expect(unchanged.prepare(
      `SELECT COUNT(*) FROM run_transitions
       WHERE operation_id = 'operation-replaced-legacy'`
    ).pluck().get()).toBe(0);
    unchanged.close();
  });

  it('fails closed when user_version metadata claims v1 but required schema objects are absent', async () => {
    const databasePath = await statePath();
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const malformed = new BetterSqlite3(databasePath);
    malformed.exec(`
      CREATE TABLE schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_metadata VALUES ('schema_version', '1', 1);
      INSERT INTO schema_metadata VALUES ('deployment_epoch', '1', 1);
      INSERT INTO schema_metadata VALUES ('store_instance_id', 'malformed-store', 1);
      PRAGMA user_version = 1;
    `);
    malformed.close();
    await chmod(databasePath, 0o600);

    expect(() => {
      const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
      store.initialize();
    }).toThrow(/SCHEMA_CONTRACT_INVALID/);
  });

  it('fails closed when a current-schema database loses a required index', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.close();

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const malformed = new BetterSqlite3(databasePath);
    malformed.exec('DROP INDEX notification_outbox_fifo');
    malformed.close();
    await chmod(databasePath, 0o600);

    expect(() => {
      const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
      reopened.initialize();
    }).toThrow(/SCHEMA_CONTRACT_INVALID/);
  });

  it('fails closed when a permanent identity receipt drifts from its run', async () => {
    await expectDataInvariantFailure(
      (store) => store.createRun(runInput('receipt-drift')),
      (database) => database.prepare(`
        UPDATE identity_receipts
        SET manufacturing_order_id = 'different-mo'
        WHERE operation_id = 'operation-receipt-drift'
      `).run(),
      /DATA_INVARIANT_INVALID.*identity receipt/i
    );
  });

  it('fails closed when dispatch_uncertain is corruptly present in the work queue', async () => {
    await expectDataInvariantFailure(
      (store) => {
        store.createRun(runInput('queued-uncertain'));
        for (const [revision, toState] of [
          [0, 'collecting'],
          [1, 'ready'],
          [2, 'prepared'],
          [3, 'dispatch_uncertain'],
        ] as const) {
          store.transitionRun({
            operationId: 'operation-queued-uncertain',
            expectedRevision: revision,
            toState,
            reason: 'corruption fixture',
          });
        }
      },
      (database) => database.prepare(`
        INSERT INTO work_queue (
          operation_id, enqueued_at_ms, available_at_ms
        ) VALUES ('operation-queued-uncertain', 1, 1)
      `).run(),
      /DATA_INVARIANT_INVALID.*queue state/i
    );
  });

  it.each([
    {
      name: 'incoherent queue claim fields',
      setup: (store: any) => {
        store.createRun(runInput('queue-claim'));
        store.transitionRun({
          operationId: 'operation-queue-claim',
          expectedRevision: 0,
          toState: 'collecting',
          reason: 'fixture',
        });
        store.transitionRun({
          operationId: 'operation-queue-claim',
          expectedRevision: 1,
          toState: 'ready',
          reason: 'fixture',
        });
        store.enqueueRun({ operationId: 'operation-queue-claim' });
      },
      corrupt: (database: any) => database.prepare(`
        UPDATE work_queue
        SET claimed_by = 'worker-without-claim-metadata'
        WHERE operation_id = 'operation-queue-claim'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*queue claim/i,
    },
    {
      name: 'incoherent claimed notification fields',
      setup: (store: any) => {
        store.createRun(runInput('notification-invariant'));
        store.enqueueNotification({
          notificationId: 'notification-invariant',
          operationId: 'operation-notification-invariant',
          kind: 'terminal',
          operationMarker: 'notification-invariant-marker',
          payload: { state: 'ready' },
        });
      },
      corrupt: (database: any) => database.prepare(`
        UPDATE notification_outbox
        SET status = 'claimed'
        WHERE notification_id = 'notification-invariant'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*notification/i,
    },
    {
      name: 'incoherent acknowledged notification fields',
      setup: (store: any) => {
        store.createRun(runInput('notification-ack-invariant'));
        store.enqueueNotification({
          notificationId: 'notification-ack-invariant',
          operationId: 'operation-notification-ack-invariant',
          kind: 'terminal',
          operationMarker: 'notification-ack-invariant-marker',
          payload: { state: 'applied_verified' },
        });
      },
      corrupt: (database: any) => database.prepare(`
        UPDATE notification_outbox
        SET status = 'acknowledged', slack_timestamp = '123.456'
        WHERE notification_id = 'notification-ack-invariant'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*notification/i,
    },
    {
      name: 'incoherent delivery_unknown notification fields',
      setup: (store: any) => {
        store.createRun(runInput('notification-unknown-invariant'));
        store.enqueueNotification({
          notificationId: 'notification-unknown-invariant',
          operationId: 'operation-notification-unknown-invariant',
          kind: 'terminal',
          operationMarker: 'notification-unknown-invariant-marker',
          payload: { state: 'dispatch_uncertain' },
        });
      },
      corrupt: (database: any) => database.prepare(`
        UPDATE notification_outbox
        SET status = 'delivery_unknown', claim_expires_at_ms = 123
        WHERE notification_id = 'notification-unknown-invariant'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*notification/i,
    },
    {
      name: 'stale dependency ancestor closure',
      setup: (store: any) => {
        store.createRun(runInput('ancestor-parent'));
        store.createRun(runInput('ancestor-child'));
        store.addDependency({
          parentOperationId: 'operation-ancestor-parent',
          childOperationId: 'operation-ancestor-child',
          parentRawLineId: 'ancestor-line',
        });
      },
      corrupt: (database: any) => database.exec('DELETE FROM dependency_ancestors'),
      expected: /DATA_INVARIANT_INVALID.*ancestor closure/i,
    },
    {
      name: 'restore history newer than deployment epoch',
      setup: (store: any) => store.createRun(runInput('restore-history-invariant')),
      corrupt: (database: any) => database.prepare(`
        INSERT INTO restore_history (
          restore_epoch, source_backup_path, reason, restored_at_ms, quarantined_count
        ) VALUES (2, '/backup.sqlite', 'corrupt future restore', 1, 0)
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*restore history/i,
    },
    {
      name: 'run restore epoch missing from restore history',
      setup: (store: any) => store.createRun(runInput('missing-restore-history')),
      corrupt: (database: any) => database.exec(`
        UPDATE schema_metadata
        SET value = '2'
        WHERE key = 'deployment_epoch';
        UPDATE runs
        SET restore_epoch = 2
        WHERE operation_id = 'operation-missing-restore-history';
      `),
      expected: /DATA_INVARIANT_INVALID.*restore history/i,
    },
    {
      name: 'run revision ahead of transition history',
      setup: (store: any) => store.createRun(runInput('transition-invariant')),
      corrupt: (database: any) => database.prepare(`
        UPDATE runs
        SET state_revision = 99
        WHERE operation_id = 'operation-transition-invariant'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*transition/i,
    },
    {
      name: 'run with no durable transition checkpoint',
      setup: (store: any) => store.createRun(runInput('missing-transition')),
      corrupt: (database: any) => database.prepare(`
        DELETE FROM run_transitions
        WHERE operation_id = 'operation-missing-transition'
      `).run(),
      expected: /DATA_INVARIANT_INVALID.*transition/i,
    },
    {
      name: 'illegal transition between otherwise supported states',
      setup: (store: any) => {
        store.createRun(runInput('transition-edge-invariant'));
        store.transitionRun({
          operationId: 'operation-transition-edge-invariant',
          expectedRevision: 0,
          toState: 'collecting',
          reason: 'fixture',
        });
      },
      corrupt: (database: any) => database.exec(`
        UPDATE run_transitions
        SET to_state = 'ready'
        WHERE operation_id = 'operation-transition-edge-invariant'
          AND state_revision = 1;
        UPDATE runs
        SET state = 'ready'
        WHERE operation_id = 'operation-transition-edge-invariant';
        INSERT INTO work_queue (
          operation_id, enqueued_at_ms, available_at_ms
        ) VALUES (
          'operation-transition-edge-invariant',
          1767225600000,
          1767225600000
        );
      `),
      expected: /DATA_INVARIANT_INVALID.*transition/i,
    },
  ])('fails closed for $name', async ({ setup, corrupt, expected }) => {
    await expectDataInvariantFailure(setup, corrupt, expected);
  });

  it('fails closed for insufficient space, unsafe mode, wrong owner, corruption, and missing-after-use', async () => {
    const lowSpacePath = await statePath('inflow-manufacturing-low-space-');
    expect(() => {
      const store = new (Store())({
        databasePath: lowSpacePath,
        minimumFreeBytes: 1,
        getFreeBytes: () => 0,
      });
      store.initialize();
    }).toThrow(/INSUFFICIENT_DISK_SPACE/);

    const databasePath = await statePath();
    const healthy = new (Store())({ databasePath, minimumFreeBytes: 0 });
    healthy.initialize();
    healthy.close();

    await chmod(databasePath, 0o644);
    expect(() => {
      const unsafeMode = new (Store())({ databasePath, minimumFreeBytes: 0 });
      unsafeMode.initialize();
    }).toThrow(/UNSAFE_DATABASE_MODE/);
    await chmod(databasePath, 0o600);

    const currentUid = process.getuid?.();
    if (currentUid !== undefined) {
      expect(() => {
        const wrongOwner = new (Store())({
          databasePath,
          minimumFreeBytes: 0,
          expectedOwnerUid: currentUid + 1,
        });
        wrongOwner.initialize();
      }).toThrow(/UNSAFE_DATABASE_OWNER/);
    }

    await rm(databasePath);
    expect(() => {
      const missing = new (Store())({ databasePath, minimumFreeBytes: 0 });
      missing.initialize();
    }).toThrow(/DATABASE_MISSING_AFTER_USE/);

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const emptyReplacement = new BetterSqlite3(databasePath);
    emptyReplacement.close();
    await chmod(databasePath, 0o600);
    expect(() => {
      const replaced = new (Store())({ databasePath, minimumFreeBytes: 0 });
      replaced.initialize();
    }).toThrow(/DATABASE_MISSING_AFTER_USE/);

    const corruptPath = await statePath('inflow-manufacturing-corrupt-');
    await writeFile(corruptPath, Buffer.from('not a sqlite database'), { mode: 0o600 });
    expect(() => {
      const corrupt = new (Store())({ databasePath: corruptPath, minimumFreeBytes: 0 });
      corrupt.initialize();
    }).toThrow(/DATABASE_(CORRUPT|OPEN_FAILED)/);
  });
});

describe('run identities, hashes, intents, and dependencies', () => {
  it('keeps same-key/same-hash registration stable and rejects immutable conflicts', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    const first = store.createRun(runInput('a'));
    const duplicate = store.createRun({
      ...runInput('a'),
      operationId: 'operation-ignored-on-stable-replay',
    });
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      run: {
        operationId: 'operation-a',
        immutableIntentHash: 'immutable-a',
        manufacturingOrderId: 'mo-a',
      },
    });
    expect(() =>
      store.createRun(runInput('a', { immutableIntentHash: 'different' }))
    ).toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
    expect(store.getIdentityReceipt(runInput('a').idempotencyKeyHash)).toMatchObject({
      operationId: 'operation-a',
      manufacturingOrderId: 'mo-a',
    });
    store.close();
  });

  it('persists deterministic IDs and all three immutable plan hashes', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('hashes'));
    const bound = store.bindPlanHashes({
      operationId: 'operation-hashes',
      immutableIntentHash: 'immutable-hashes',
      completePreWriteHash: 'complete-hash',
      expectedPostStateHash: 'expected-hash',
      preparedRequestHash: 'request-hash',
    });
    expect(bound).toMatchObject({
      operationId: 'operation-hashes',
      runHash: 'run-hash-hashes',
      manufacturingOrderId: 'mo-hashes',
      rootLineId: 'root-hashes',
      immutableIntentHash: 'immutable-hashes',
      completePreWriteHash: 'complete-hash',
      expectedPostStateHash: 'expected-hash',
    });
    expect(() =>
      store.bindPlanHashes({
        operationId: 'operation-hashes',
        immutableIntentHash: 'immutable-hashes',
        completePreWriteHash: 'drift',
        expectedPostStateHash: 'expected-hash',
        preparedRequestHash: 'request-hash',
      })
    ).toThrow(/PLAN_HASH_CONFLICT/);
    store.close();
  });

  it('atomically stabilizes duplicate exact intents and rejects raw-line conflicts', async () => {
    const databasePath = await statePath();
    const firstStore = new (Store())({ databasePath, minimumFreeBytes: 0 });
    firstStore.initialize();
    firstStore.createRun(runInput('intent'));
    const secondStore = new (Store())({ databasePath, minimumFreeBytes: 0 });
    secondStore.initialize();
    const intent = {
      operationId: 'operation-intent',
      rawLineId: 'raw-line-1',
      intentHash: 'intent-hash-1',
      productId: 'component-1',
      quantity: '2',
      locationId: 'location-1',
      serialized: true,
      serialNumbers: ['SERIAL-1', 'SERIAL-2'],
      createdAt: '2026-01-01T00:01:00.000Z',
    };
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => firstStore.registerComponentIntent(intent)),
      Promise.resolve().then(() => secondStore.registerComponentIntent(intent)),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(firstStore.listComponentIntents('operation-intent')).toHaveLength(1);
    expect(() =>
      secondStore.registerComponentIntent({
        ...intent,
        productId: 'different-component',
      })
    ).toThrow(/COMPONENT_INTENT_CONFLICT/);
    expect(() =>
      secondStore.registerComponentIntent({ ...intent, intentHash: 'conflicting-hash' })
    ).toThrow(/COMPONENT_INTENT_CONFLICT/);
    secondStore.close();
    firstStore.close();
  });

  it('stores recursive dependencies and ancestor closure while rejecting cycles', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('root'));
    store.createRun(runInput('child'));
    store.createRun(runInput('grandchild'));
    expect(store.addDependency({
      parentOperationId: 'operation-root',
      childOperationId: 'operation-child',
      parentRawLineId: 'line-a',
    }).created).toBe(true);
    store.addDependency({
      parentOperationId: 'operation-child',
      childOperationId: 'operation-grandchild',
      parentRawLineId: 'line-b',
    });
    expect(store.listAncestors('operation-grandchild')).toEqual([
      { operationId: 'operation-child', depth: 1 },
      { operationId: 'operation-root', depth: 2 },
    ]);
    expect(() =>
      store.addDependency({
        parentOperationId: 'operation-grandchild',
        childOperationId: 'operation-root',
        parentRawLineId: 'line-cycle',
      })
    ).toThrow(/MANUFACTURING_DEPENDENCY_CYCLE/);
    store.close();
  });

  it('binds immutable coordinator artifacts and keeps them through detail pruning', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('artifact', { createdAt: '2025-01-01T00:00:00.000Z' }));
    expect(store.bindRunArtifact({
      operationId: 'operation-artifact',
      artifactType: 'begin_snapshot',
      artifactHash: 'snapshot-hash',
      artifact: { timestamp: '0000000000000001', lines: ['root-artifact'] },
      at: '2025-01-01T00:00:00.000Z',
    }).created).toBe(true);
    expect(store.bindRunArtifact({
      operationId: 'operation-artifact',
      artifactType: 'begin_snapshot',
      artifactHash: 'snapshot-hash',
      artifact: { timestamp: '0000000000000001', lines: ['root-artifact'] },
      at: '2025-01-01T00:00:01.000Z',
    }).created).toBe(false);
    expect(() => store.bindRunArtifact({
      operationId: 'operation-artifact',
      artifactType: 'begin_snapshot',
      artifactHash: 'different-hash',
      artifact: { timestamp: '0000000000000002' },
    })).toThrow(/RUN_ARTIFACT_CONFLICT/);
    store.recordEvent({
      operationId: 'operation-artifact',
      eventType: 'old_detail',
      detail: { disposable: true },
      at: '2025-01-01T00:00:00.000Z',
    });
    store.pruneDetailedEvents({ now: '2026-01-01T00:00:00.000Z' });
    expect(store.getRunArtifact('operation-artifact', 'begin_snapshot')).toEqual({
      artifactType: 'begin_snapshot',
      artifactHash: 'snapshot-hash',
      artifact: { timestamp: '0000000000000001', lines: ['root-artifact'] },
      at: '2025-01-01T00:00:00.000Z',
    });
    expect(store.listEvents('operation-artifact')).toHaveLength(1);
    store.close();
  });

  it('tracks exact dependency satisfaction without confusing sibling raw lines', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('dependency-parent'));
    store.createRun(runInput('dependency-child-a'));
    store.createRun(runInput('dependency-child-b'));
    store.addDependency({
      parentOperationId: 'operation-dependency-parent',
      childOperationId: 'operation-dependency-child-a',
      parentRawLineId: 'raw-a',
    });
    store.addDependency({
      parentOperationId: 'operation-dependency-parent',
      childOperationId: 'operation-dependency-child-b',
      parentRawLineId: 'raw-b',
    });
    expect(store.satisfyDependency({
      parentOperationId: 'operation-dependency-parent',
      childOperationId: 'operation-dependency-child-a',
      parentRawLineId: 'raw-a',
      satisfiedAt: '2026-01-01T00:00:01.000Z',
    })).toMatchObject({ changed: true, allSatisfied: false });
    expect(() => store.satisfyDependency({
      parentOperationId: 'operation-dependency-parent',
      childOperationId: 'operation-dependency-child-a',
      parentRawLineId: 'raw-b',
    })).toThrow(/DEPENDENCY_IDENTITY_MISMATCH/);
    expect(store.listDependencies('operation-dependency-parent')).toEqual([
      expect.objectContaining({
        childOperationId: 'operation-dependency-child-a',
        parentRawLineId: 'raw-a',
        satisfiedAt: '2026-01-01T00:00:01.000Z',
      }),
      expect.objectContaining({
        childOperationId: 'operation-dependency-child-b',
        parentRawLineId: 'raw-b',
        satisfiedAt: null,
      }),
    ]);
    store.close();
  });
});

describe('state transitions, FIFO ownership, leases, and dispatch fencing', () => {
  it('accepts only the exact state model and makes terminal states immutable', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('states'));
    expect(() =>
      store.transitionRun({
        operationId: 'operation-states',
        expectedRevision: 0,
        toState: 'invented_state',
        reason: 'test',
      })
    ).toThrow(/UNSUPPORTED_RUN_STATE/);
    const collecting = store.transitionRun({
      operationId: 'operation-states',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
    });
    expect(() => store.transitionRun({
      operationId: 'operation-states',
      expectedRevision: collecting.stateRevision,
      toState: 'failed_no_write',
      reason: 'unattested pre-dispatch no-write',
    })).toThrow(/ATTESTED_NO_WRITE_TRANSITION_REQUIRED/);
    const failed = store.transitionRun({
      operationId: 'operation-states',
      expectedRevision: collecting.stateRevision,
      toState: 'conflict',
      reason: 'deterministic conflict',
    });
    expect(() =>
      store.transitionRun({
        operationId: 'operation-states',
        expectedRevision: failed.stateRevision,
        toState: 'ready',
        reason: 'illegal retry',
      })
    ).toThrow(/TERMINAL_RUN_IMMUTABLE/);
    store.close();
  });

  it('rejects a transition timestamp older than the current durable revision', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('transition-time'));
    expect(() =>
      store.transitionRun({
        operationId: 'operation-transition-time',
        expectedRevision: 0,
        toState: 'collecting',
        reason: 'stale timestamp',
        at: '2025-12-31T23:59:59.000Z',
      })
    ).toThrow(/RUN_TRANSITION_TIME_CONFLICT/);
    expect(() =>
      store.transitionRun({
        operationId: 'operation-transition-time',
        expectedRevision: 0,
        toState: 'collecting',
        reason: 'schema_v2_retention_checkpoint',
      })
    ).toThrow(/RESERVED_TRANSITION_REASON/);
    store.close();
  });

  it('claims eligible work FIFO under the active worker lease and epoch', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    for (const suffix of ['fifo-a', 'fifo-b']) {
      store.createRun(runInput(suffix));
      store.transitionRun({
        operationId: `operation-${suffix}`,
        expectedRevision: 0,
        toState: 'collecting',
        reason: 'expanded',
        at: '2026-01-01T00:00:00.000Z',
      });
      store.transitionRun({
        operationId: `operation-${suffix}`,
        expectedRevision: 1,
        toState: 'ready',
        reason: 'all intents',
        at: suffix === 'fifo-a'
          ? '2026-01-01T00:00:00.000Z'
          : '2026-01-01T00:00:01.000Z',
      });
    }
    store.enqueueRun({ operationId: 'operation-fifo-a', enqueuedAt: '2026-01-01T00:00:00.000Z' });
    store.enqueueRun({ operationId: 'operation-fifo-b', enqueuedAt: '2026-01-01T00:00:01.000Z' });
    const lease = store.acquireWorkerLease({
      workerId: 'worker-a',
      now: '2026-01-01T00:00:02.000Z',
      leaseMs: 60_000,
    });
    expect(() =>
      store.claimNextRun({
        workerId: 'worker-a',
        epoch: lease.epoch + 1,
        now: '2026-01-01T00:00:03.000Z',
        leaseMs: 30_000,
      })
    ).toThrow(/STALE_WORKER_EPOCH/);
    const first = store.claimNextRun({
      workerId: 'worker-a',
      epoch: lease.epoch,
      now: '2026-01-01T00:00:03.000Z',
      leaseMs: 30_000,
    });
    expect(first.operationId).toBe('operation-fifo-a');
    store.completeQueueItem({
      operationId: first.operationId,
      workerId: 'worker-a',
      epoch: lease.epoch,
    });
    expect(store.claimNextRun({
      workerId: 'worker-a',
      epoch: lease.epoch,
      now: '2026-01-01T00:00:04.000Z',
      leaseMs: 30_000,
    }).operationId).toBe('operation-fifo-b');
    store.close();
  });

  it('durably defers a released rate-limited queue claim', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('rate-delay'));
    store.transitionRun({
      operationId: 'operation-rate-delay',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.000Z',
    });
    store.transitionRun({
      operationId: 'operation-rate-delay',
      expectedRevision: 1,
      toState: 'ready',
      reason: 'all intents',
      at: '2026-01-01T00:00:01.000Z',
    });
    const lease = store.acquireWorkerLease({
      workerId: 'rate-worker',
      leaseMs: 60_000,
      now: '2026-01-01T00:00:02.000Z',
    });
    expect(store.claimNextRun({
      workerId: 'rate-worker',
      epoch: lease.epoch,
      leaseMs: 60_000,
      now: '2026-01-01T00:00:03.000Z',
    })).toMatchObject({ operationId: 'operation-rate-delay' });

    store.releaseQueueClaim({
      operationId: 'operation-rate-delay',
      workerId: 'rate-worker',
      epoch: lease.epoch,
      leaseMs: 60_000,
      now: '2026-01-01T00:00:04.000Z',
      availableAt: '2026-01-01T00:01:04.000Z',
    });

    const deferredLease = store.acquireWorkerLease({
      workerId: 'rate-worker',
      leaseMs: 60_000,
      now: '2026-01-01T00:01:03.999Z',
    });
    expect(store.claimNextRun({
      workerId: 'rate-worker',
      epoch: deferredLease.epoch,
      leaseMs: 60_000,
      now: '2026-01-01T00:01:03.999Z',
    })).toBeUndefined();
    const readyLease = store.acquireWorkerLease({
      workerId: 'rate-worker',
      leaseMs: 60_000,
      now: '2026-01-01T00:01:04.000Z',
    });
    expect(store.claimNextRun({
      workerId: 'rate-worker',
      epoch: readyLease.epoch,
      leaseMs: 60_000,
      now: '2026-01-01T00:01:04.000Z',
    })).toMatchObject({ operationId: 'operation-rate-delay' });
    store.close();
  });

  it('queues deterministic creation work without allowing any uncertain dispatch to requeue', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('create-queue'));
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-create-queue' }),
    ]);
    const lease = store.acquireWorkerLease({
      workerId: 'create-worker',
      leaseMs: 60_000,
      now: '2026-01-01T00:00:01.000Z',
    });
    expect(store.claimNextRun({
      workerId: 'create-worker',
      epoch: lease.epoch,
      leaseMs: 30_000,
      now: '2026-01-01T00:00:02.000Z',
    })).toMatchObject({ operationId: 'operation-create-queue' });
    expect(store.transitionRun({
      operationId: 'operation-create-queue',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'exact create verified',
      at: '2026-01-01T00:00:03.000Z',
    }).state).toBe('collecting');
    expect(store.listQueuedRuns()).toEqual([]);
    store.close();
  });

  it('allows only canary-attested coordinator logic to reclassify uncertain as no-write', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('attested-no-write'));
    for (const [revision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
      [3, 'dispatch_uncertain'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-attested-no-write',
        expectedRevision: revision,
        toState,
        reason: 'boundary',
      });
    }
    expect(() => store.transitionRun({
      operationId: 'operation-attested-no-write',
      expectedRevision: 4,
      toState: 'failed_no_write',
      reason: 'unprivileged no-write claim',
    })).toThrow(/ATTESTED_NO_WRITE_TRANSITION_REQUIRED/);
    store.createRun(runInput('attested-too-early'));
    expect(() => store.markFailedNoWriteAttested({
      operationId: 'operation-attested-too-early',
      expectedRevision: 0,
      attestationDomain: 'manufacturing-pick-batch-v1',
      evidenceHash: 'attested-provider-rejection-hash',
      reason: 'attestation cannot precede dispatch',
    })).toThrow(/ATTESTED_NO_WRITE_REQUIRES_DISPATCH_UNCERTAIN/);
    expect(store.markFailedNoWriteAttested({
      operationId: 'operation-attested-no-write',
      expectedRevision: 4,
      attestationDomain: 'manufacturing-pick-batch-v1',
      evidenceHash: 'attested-provider-rejection-hash',
      reason: 'canary-attested definitive no-write',
    }).state).toBe('failed_no_write');
    store.close();
  });

  it('atomically persists a new begin artifact with its creating queue row', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    const result = store.beginQueuedRun({
      run: runInput('atomic-begin'),
      artifact: {
        artifactType: 'begin_plan',
        artifactHash: 'atomic-begin-plan-hash',
        artifact: { deterministic: true },
        at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(result.run.state).toBe('creating');
    expect(store.getRunArtifact('operation-atomic-begin', 'begin_plan'))
      .toMatchObject({ artifactHash: 'atomic-begin-plan-hash' });
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-atomic-begin' }),
    ]);

    const replay = store.beginQueuedRun({
      run: runInput('atomic-begin'),
      artifact: {
        artifactType: 'begin_plan',
        artifactHash: 'different-delivery-metadata',
        artifact: { deterministic: true, deliveryContext: 'new-thread' },
        at: '2026-01-01T00:00:01.000Z',
      },
    });
    expect(replay.created).toBe(false);
    expect(store.getRunArtifact('operation-atomic-begin', 'begin_plan'))
      .toMatchObject({ artifactHash: 'atomic-begin-plan-hash' });

    expect(() => store.beginQueuedRun({
      run: runInput('atomic-begin-conflict'),
      artifact: {
        artifactType: 'begin_plan',
        artifactHash: ' ',
        artifact: { deterministic: false },
      },
    })).toThrow(/artifact_hash/i);
    expect(store.getRun('operation-atomic-begin-conflict')).toBeUndefined();
    expect(store.listQueuedRuns()).toHaveLength(1);
    store.close();
  });

  it('returns the latest versioned artifact by prefix', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('latest-artifact'));
    store.bindRunArtifact({
      operationId: 'operation-latest-artifact',
      artifactType: 'notification_context/v1:first',
      artifactHash: 'first-hash',
      artifact: { thread: 'first' },
      at: '2026-01-01T00:00:01.000Z',
    });
    store.bindRunArtifact({
      operationId: 'operation-latest-artifact',
      artifactType: 'notification_context/v1:second',
      artifactHash: 'second-hash',
      artifact: { thread: 'second' },
      at: '2026-01-01T00:00:02.000Z',
    });

    expect(store.getLatestRunArtifactByPrefix(
      'operation-latest-artifact',
      'notification_context/v1:'
    )).toMatchObject({
      artifactType: 'notification_context/v1:second',
      artifactHash: 'second-hash',
      artifact: { thread: 'second' },
    });
    store.close();
  });

  it('allows a blocked component-shortage run to re-enter collection', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('blocked-retry'));
    store.transitionRun({
      operationId: 'operation-blocked-retry',
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'component inventory shortage',
      at: '2026-01-01T00:00:01.000Z',
    });

    expect(store.transitionRun({
      operationId: 'operation-blocked-retry',
      expectedRevision: 1,
      toState: 'collecting',
      reason: 'fresh begin retry after component inventory shortage',
      at: '2026-01-01T00:00:02.000Z',
    })).toMatchObject({ state: 'collecting', stateRevision: 2 });
    store.close();

    const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
    expect(() => reopened.initialize()).not.toThrow();
    reopened.close();
  });

  it('atomically creates, binds, and queues an exact recursive child dependency', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('dependent-parent'));
    store.transitionRun({
      operationId: 'operation-dependent-parent',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.500Z',
    });
    const input = dependentBeginInput('dependent-parent', 'dependent-child', 1);

    const first = store.beginDependentQueuedRun(input);
    expect(first).toMatchObject({
      created: true,
      run: { operationId: 'operation-dependent-child', state: 'creating' },
      dependency: {
        parentOperationId: 'operation-dependent-parent',
        childOperationId: 'operation-dependent-child',
        parentRawLineId: 'raw-component-1',
      },
    });
    expect(store.getRun('operation-dependent-parent')).toMatchObject({
      state: 'waiting_dependencies',
      stateRevision: 2,
    });
    expect(store.listDependencies('operation-dependent-parent')).toEqual([
      expect.objectContaining({
        childOperationId: 'operation-dependent-child',
        parentRawLineId: 'raw-component-1',
      }),
    ]);
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-dependent-child' }),
    ]);

    const replay = store.beginDependentQueuedRun({
      ...input,
      expectedParentStateRevision: 2,
    });
    expect(replay).toMatchObject({
      created: false,
      run: { operationId: 'operation-dependent-child' },
      dependency: {
        parentOperationId: 'operation-dependent-parent',
        childOperationId: 'operation-dependent-child',
      },
    });
    expect(store.listDependencies('operation-dependent-parent')).toHaveLength(1);
    expect(store.listQueuedRuns()).toHaveLength(1);
    store.close();
  });

  it('rolls back child identity, artifact, dependency, and queue on an in-transaction crash', async () => {
    const databasePath = await statePath();
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      testHooks: {
        afterDependentRunBegun: () => {
          throw new Error('SIMULATED_DEPENDENCY_BIND_CRASH');
        },
      },
    });
    store.initialize();
    store.createRun(runInput('rollback-parent'));
    store.transitionRun({
      operationId: 'operation-rollback-parent',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.500Z',
    });

    expect(() => store.beginDependentQueuedRun(
      dependentBeginInput('rollback-parent', 'rollback-child', 1)
    )).toThrow(/SIMULATED_DEPENDENCY_BIND_CRASH/);
    expect(store.getRun('operation-rollback-child')).toBeUndefined();
    expect(store.getIdentityReceipt(
      runInput('rollback-child').idempotencyKeyHash
    )).toBeUndefined();
    expect(store.getRunArtifact('operation-rollback-child', 'begin_plan'))
      .toBeUndefined();
    expect(store.listDependencies('operation-rollback-parent')).toEqual([]);
    expect(store.listQueuedRuns()).toEqual([]);
    expect(store.getRun('operation-rollback-parent')).toMatchObject({
      state: 'collecting',
      stateRevision: 1,
    });
    store.close();
  });

  it('rejects conflicting child bindings and parent state without child or queue side effects', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('conflict-parent'));
    store.transitionRun({
      operationId: 'operation-conflict-parent',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.500Z',
    });
    store.beginDependentQueuedRun(
      dependentBeginInput('conflict-parent', 'bound-child', 1)
    );

    expect(() => store.beginDependentQueuedRun(
      dependentBeginInput('conflict-parent', 'conflicting-child', 2)
    )).toThrow(/MANUFACTURING_DEPENDENCY_CONFLICT/);
    expect(store.getRun('operation-conflicting-child')).toBeUndefined();
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-bound-child' }),
    ]);

    store.createRun(runInput('blocked-parent'));
    store.transitionRun({
      operationId: 'operation-blocked-parent',
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'unsafe parent',
    });
    expect(() => store.beginDependentQueuedRun(
      dependentBeginInput('blocked-parent', 'blocked-child', 1)
    )).toThrow(/RUN_NOT_COLLECTING_DEPENDENCIES/);
    expect(store.getRun('operation-blocked-child')).toBeUndefined();
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-bound-child' }),
    ]);
    store.close();
  });

  it('revalidates a blocked raw-line disposition inside the child transaction', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('disposition-parent'));
    store.transitionRun({
      operationId: 'operation-disposition-parent',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.500Z',
    });
    store.bindRunArtifact({
      operationId: 'operation-disposition-parent',
      artifactType: 'component_block:raw-component-1',
      artifactHash: 'blocked-component-evidence-hash',
      artifact: { reason: 'no safe source' },
      at: '2026-01-01T00:00:00.750Z',
    });

    expect(() => store.beginDependentQueuedRun(
      dependentBeginInput('disposition-parent', 'disposition-child', 1)
    )).toThrow(/PARENT_COMPONENT_DISPOSITION_CONFLICT/);
    expect(store.getRun('operation-disposition-child')).toBeUndefined();
    expect(store.listDependencies('operation-disposition-parent')).toEqual([]);
    expect(store.listQueuedRuns()).toEqual([]);
    store.close();
  });

  it('atomically adds a queue row whenever a run enters ready or prepared', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('atomic-ready'));
    store.transitionRun({
      operationId: 'operation-atomic-ready',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
    });
    expect(store.listQueuedRuns()).toEqual([]);
    store.transitionRun({
      operationId: 'operation-atomic-ready',
      expectedRevision: 1,
      toState: 'ready',
      reason: 'complete intent set',
    });
    expect(store.listQueuedRuns()).toEqual([
      expect.objectContaining({ operationId: 'operation-atomic-ready' }),
    ]);
    store.transitionRun({
      operationId: 'operation-atomic-ready',
      expectedRevision: 2,
      toState: 'prepared',
      reason: 'durable plan',
    });
    expect(store.listQueuedRuns()).toHaveLength(1);
    store.close();
  });

  it.each(['creating', 'ready', 'prepared'] as const)(
    'fails startup when a %s run has no queue row',
    async (state) => {
      await expectDataInvariantFailure(
        (store) => {
          store.createRun(runInput(`missing-queue-${state}`));
          if (state !== 'creating') {
            store.transitionRun({
              operationId: `operation-missing-queue-${state}`,
              expectedRevision: 0,
              toState: 'collecting',
              reason: 'expanded',
            });
            store.transitionRun({
              operationId: `operation-missing-queue-${state}`,
              expectedRevision: 1,
              toState: 'ready',
              reason: 'complete intent set',
            });
          }
          if (state === 'prepared') {
            store.transitionRun({
              operationId: 'operation-missing-queue-prepared',
              expectedRevision: 2,
              toState: 'prepared',
              reason: 'durable plan',
            });
          }
        },
        (database) => database.prepare(
          `DELETE FROM work_queue WHERE operation_id = ?`
        ).run(`operation-missing-queue-${state}`),
        /DATA_INVARIANT_INVALID.*queueable run has no queue/i
      );
    }
  );

  it('rejects renewal by a stale worker after lease and claim takeover', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('lease-takeover'));
    const first = store.acquireWorkerLease({
      workerId: 'worker-old',
      leaseMs: 1_000,
      now: '2026-01-01T00:00:00.000Z',
    });
    store.claimNextRun({
      workerId: 'worker-old',
      epoch: first.epoch,
      leaseMs: 1_000,
      now: '2026-01-01T00:00:00.000Z',
    });
    const second = store.acquireWorkerLease({
      workerId: 'worker-new',
      leaseMs: 10_000,
      now: '2026-01-01T00:00:02.000Z',
    });
    store.claimNextRun({
      workerId: 'worker-new',
      epoch: second.epoch,
      leaseMs: 10_000,
      now: '2026-01-01T00:00:02.000Z',
    });
    expect(() => store.renewWorkerOwnership({
      operationId: 'operation-lease-takeover',
      workerId: 'worker-old',
      epoch: first.epoch,
      leaseMs: 10_000,
      now: '2026-01-01T00:00:02.001Z',
    })).toThrow(/WORKER_LEASE_NOT_HELD|QUEUE_OWNERSHIP_CONFLICT/);
    expect(store.renewWorkerOwnership({
      operationId: 'operation-lease-takeover',
      workerId: 'worker-new',
      epoch: second.epoch,
      leaseMs: 10_000,
      now: '2026-01-01T00:00:02.001Z',
    })).toMatchObject({ workerId: 'worker-new', epoch: second.epoch });
    store.close();
  });

  it('durably fences dispatch before socket work and never requeues uncertain mutations', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('dispatch'));
    for (const [revision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-dispatch',
        expectedRevision: revision,
        toState,
        reason: 'boundary',
      });
    }
    store.enqueueRun({ operationId: 'operation-dispatch' });
    const fenced = store.markDispatchUncertain({
      operationId: 'operation-dispatch',
      expectedRevision: 3,
      reason: 'socket-boundary',
    });
    expect(fenced.state).toBe('dispatch_uncertain');
    expect(() => store.enqueueRun({ operationId: 'operation-dispatch' }))
      .toThrow(/DISPATCH_UNCERTAIN_NOT_REQUEUEABLE/);
    store.close();

    const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
    reopened.initialize();
    expect(reopened.getRun('operation-dispatch')).toMatchObject({
      state: 'dispatch_uncertain',
      stateRevision: 4,
    });
    expect(reopened.listQueuedRuns()).toEqual([]);
    reopened.close();
  });

  it('atomically re-arms a dispatch only from exact revision-bound no-write proof', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('proven-no-write'));
    store.bindPlanHashes({
      operationId: 'operation-proven-no-write',
      immutableIntentHash: 'immutable-proven-no-write',
      completePreWriteHash: 'complete-pre-write-hash',
      expectedPostStateHash: 'expected-post-hash',
      preparedRequestHash: 'prepared-request-hash',
    });
    for (const [revision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
      [3, 'dispatch_uncertain'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-proven-no-write',
        expectedRevision: revision,
        toState,
        reason: 'boundary',
      });
    }
    store.bindRunArtifact({
      operationId: 'operation-proven-no-write',
      artifactType: 'dispatch_plan',
      artifactHash: 'dispatch-plan-hash',
      artifact: {
        requestHash: 'prepared-request-hash',
        completePreWriteHash: 'complete-pre-write-hash',
        beginTimestamp: '0000000000000010',
      },
    });
    store.bindRunArtifact({
      operationId: 'operation-proven-no-write',
      artifactType: 'component_inventory_expectation/v1',
      artifactHash: 'inventory-expectation-hash',
      artifact: { schemaVersion: 'manufacturing-component-inventory-expectation/v1' },
    });
    store.bindRunArtifact({
      operationId: 'operation-proven-no-write',
      artifactType: 'source_serial_binding/v1',
      artifactHash: 'source-binding-hash',
      artifact: { schemaVersion: 'source_serial_binding/v1' },
    });
    const rejection = {
      schemaVersion: 'manufacturing-dispatch-no-write-rejection/v1',
      domain: 'manufacturing-pick-batch-v1',
      dispatchUncertainRevision: 4,
      requestHash: 'prepared-request-hash',
      rejection: {
        name: 'InflowApiError',
        statusCode: 400,
        providerCode: 'WorkOrderPartNegativeInventory',
      },
    };
    const rejectionHash = canonicalHash(
      rejection,
      'manufacturing-run/dispatch-no-write-rejection/v1'
    );
    store.bindRunArtifact({
      operationId: 'operation-proven-no-write',
      artifactType: 'dispatch_no_write_rejection/v1:revision:4',
      artifactHash: rejectionHash,
      artifact: rejection,
    });
    const proof = {
      schemaVersion: 'manufacturing-dispatch-no-write-proof/v1',
      domain: 'manufacturing-pick-batch-v1',
      dispatchUncertainRevision: 4,
      requestHash: 'prepared-request-hash',
      completePreWriteHash: 'complete-pre-write-hash',
      preWriteTimestamp: '0000000000000010',
      componentInventoryExpectationHash: 'inventory-expectation-hash',
      sourceSerialBindingHash: 'source-binding-hash',
      rejectionArtifactHash: rejectionHash,
      observedAt: '2026-01-01T00:00:01.000Z',
    };
    const proofHash = canonicalHash(
      proof,
      'manufacturing-run/dispatch-no-write-proof/v1'
    );
    store.bindRunArtifact({
      operationId: 'operation-proven-no-write',
      artifactType: 'dispatch_no_write_proof/v1:revision:4',
      artifactHash: proofHash,
      artifact: proof,
    });

    expect(store.rearmDispatchAfterProvenNoWrite({
      operationId: 'operation-proven-no-write',
      expectedRevision: 4,
      proofArtifactType: 'dispatch_no_write_proof/v1:revision:4',
      evidenceHash: proofHash,
      reason: 'exact proof accepted',
    })).toMatchObject({ state: 'prepared', stateRevision: 5 });
    expect(store.listQueuedRuns()).toHaveLength(1);
    store.close();

    const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
    reopened.initialize();
    expect(reopened.getRun('operation-proven-no-write')).toMatchObject({
      state: 'prepared',
      stateRevision: 5,
    });
    expect(reopened.listQueuedRuns()).toHaveLength(1);
    reopened.close();
  });

  it('keeps dispatch uncertain when no-write evidence is missing or malformed', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('ambiguous-no-write'));
    store.bindPlanHashes({
      operationId: 'operation-ambiguous-no-write',
      immutableIntentHash: 'immutable-ambiguous-no-write',
      completePreWriteHash: 'complete-pre-write-hash',
      expectedPostStateHash: 'expected-post-hash',
      preparedRequestHash: 'prepared-request-hash',
    });
    for (const [revision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
      [3, 'dispatch_uncertain'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-ambiguous-no-write',
        expectedRevision: revision,
        toState,
        reason: 'boundary',
      });
    }

    expect(() => store.rearmDispatchAfterProvenNoWrite({
      operationId: 'operation-ambiguous-no-write',
      expectedRevision: 4,
      proofArtifactType: 'dispatch_no_write_proof/v1:revision:4',
      evidenceHash: 'missing-proof-hash',
      reason: 'must stay fenced',
    })).toThrow(/PROVEN_NO_WRITE_ARTIFACT_MISSING_OR_MISMATCHED/);
    store.bindRunArtifact({
      operationId: 'operation-ambiguous-no-write',
      artifactType: 'dispatch_no_write_proof/v1:revision:4',
      artifactHash: 'malformed-proof-hash',
      artifact: {
        schemaVersion: 'manufacturing-dispatch-no-write-proof/v1',
        domain: 'manufacturing-pick-batch-v1',
        dispatchUncertainRevision: 3,
      },
    });
    expect(() => store.rearmDispatchAfterProvenNoWrite({
      operationId: 'operation-ambiguous-no-write',
      expectedRevision: 4,
      proofArtifactType: 'dispatch_no_write_proof/v1:revision:4',
      evidenceHash: 'malformed-proof-hash',
      reason: 'must stay fenced',
    })).toThrow(/PROVEN_NO_WRITE_ARTIFACT_INVALID/);
    expect(store.getRun('operation-ambiguous-no-write')).toMatchObject({
      state: 'dispatch_uncertain',
      stateRevision: 4,
    });
    expect(store.listQueuedRuns()).toEqual([]);
    store.close();
  });

  it('requires immutable completion artifacts and atomically fences the second dispatch', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('operation-completion'));
    for (const [revision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
      [3, 'dispatch_uncertain'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-operation-completion',
        expectedRevision: revision,
        toState,
        reason: 'boundary',
      });
    }
    expect(() => store.transitionRun({
      operationId: 'operation-operation-completion',
      expectedRevision: 4,
      toState: 'prepared',
      reason: 'unsafe second phase',
    })).toThrow(/OPERATION_COMPLETION_PREPARATION_REQUIRED/);
    expect(() => store.markOperationCompletionPrepared({
      operationId: 'operation-operation-completion',
      expectedRevision: 4,
      reason: 'missing artifacts',
    })).toThrow(/RUN_ARTIFACT_MISSING/);
    for (const artifactType of [
      'operation_completion_intent/v1',
      'operation_completion_plan/v1',
    ]) {
      store.bindRunArtifact({
        operationId: 'operation-operation-completion',
        artifactType,
        artifactHash: `hash-${artifactType}`,
        artifact: { artifactType },
      });
    }
    const prepared = store.markOperationCompletionPrepared({
      operationId: 'operation-operation-completion',
      expectedRevision: 4,
      reason: 'exact staged readback prepared completion',
    });
    expect(prepared).toMatchObject({ state: 'prepared', stateRevision: 5 });
    expect(store.listQueuedRuns()).toHaveLength(1);

    const barrier = {
      schemaVersion:
        'manufacturing-operation-completion-dispatch-barrier/v1',
      correlationId: 'correlation-1',
      requestHash: 'request-hash-1',
    };
    const uncertain = store.fenceOperationCompletionDispatch({
      operationId: 'operation-operation-completion',
      expectedRevision: 5,
      reason: 'socket may open next',
      artifact: {
        artifactType: 'operation_completion_dispatch_barrier/v1',
        artifactHash: 'barrier-hash',
        artifact: barrier,
      },
    });
    expect(uncertain).toMatchObject({
      state: 'dispatch_uncertain',
      stateRevision: 6,
    });
    expect(store.getRunArtifact(
      'operation-operation-completion',
      'operation_completion_dispatch_barrier/v1'
    )).toMatchObject({ artifact: barrier });
    expect(store.listQueuedRuns()).toEqual([]);
    store.close();

    const reopened = new (Store())({ databasePath, minimumFreeBytes: 0 });
    reopened.initialize();
    expect(reopened.getRun('operation-operation-completion')).toMatchObject({
      state: 'dispatch_uncertain',
      stateRevision: 6,
    });
    expect(reopened.getRunArtifact(
      'operation-operation-completion',
      'operation_completion_dispatch_barrier/v1'
    )).toMatchObject({ artifact: barrier });
    reopened.close();
  });

  it('survives a process restart at every automatic state boundary', async () => {
    const databasePath = await statePath();
    let store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('crash-boundaries'));
    const boundaries = [
      'collecting',
      'waiting_dependencies',
      'ready',
      'prepared',
      'dispatch_uncertain',
      'applied_verified',
    ];
    for (const [index, state] of boundaries.entries()) {
      store.transitionRun({
        operationId: 'operation-crash-boundaries',
        expectedRevision: index,
        toState: state,
        reason: `crash-after-${state}`,
      });
      store.close();
      store = new (Store())({ databasePath, minimumFreeBytes: 0 });
      store.initialize();
      expect(store.getRun('operation-crash-boundaries')).toMatchObject({
        state,
        stateRevision: index + 1,
      });
    }
    store.close();
  });
});

describe('rate, nonce, event retention, outbox, backup, and restore', () => {
  it('enforces a coordinator-wide 20 request rolling-minute ledger', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    for (let index = 0; index < 20; index += 1) {
      expect(store.consumeRateBudget({
        now: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      }).allowed).toBe(true);
    }
    expect(store.consumeRateBudget({ now: '2026-01-01T00:00:20.000Z' })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
    expect(store.consumeRateBudget({ now: '2026-01-01T00:01:00.001Z' }).allowed).toBe(true);
    store.close();
  });

  it('rejects nonce replay and permits reuse only after expiry', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    expect(store.claimNonce({
      kid: 'key-current',
      nonce: 'nonce-1',
      now: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
    })).toBe(true);
    expect(store.claimNonce({
      kid: 'key-current',
      nonce: 'nonce-1',
      now: '2026-01-01T00:05:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
    })).toBe(false);
    expect(store.claimNonce({
      kid: 'key-current',
      nonce: 'nonce-1',
      now: '2026-01-01T00:10:00.001Z',
      expiresAt: '2026-01-01T00:20:00.000Z',
    })).toBe(true);
    expect(() =>
      store.claimNonce({
        kid: 'key-current',
        nonce: 'already-expired',
        now: '2026-01-01T00:10:00.000Z',
        expiresAt: '2026-01-01T00:09:59.000Z',
      })
    ).toThrow(/NONCE_EXPIRED/);
    store.close();
  });

  it('rejects the same nonce under a different key id while the claim is live', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();

    expect(store.claimNonce({
      kid: 'current-key',
      nonce: 'shared-nonce',
      now: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
    })).toBe(true);
    expect(store.claimNonce({
      kid: 'next-key',
      nonce: 'shared-nonce',
      now: '2026-01-01T00:00:01.000Z',
      expiresAt: '2026-01-01T00:10:01.000Z',
    })).toBe(false);

    store.close();
  });

  it('reports rate readiness without consuming the budget', async () => {
    const databasePath = await statePath();
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      requestsPerMinute: 2,
    });
    store.initialize();

    expect(store.consumeRateBudget({
      now: '2026-01-01T00:00:00.000Z',
    })).toMatchObject({ allowed: true, remaining: 1 });
    expect(store.getRateBudgetStatus({
      now: '2026-01-01T00:00:30.000Z',
    })).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(store.getRateBudgetStatus({
      now: '2026-01-01T00:00:30.000Z',
    })).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(store.consumeRateBudget({
      now: '2026-01-01T00:00:30.000Z',
    })).toMatchObject({ allowed: true, remaining: 0 });

    store.close();
  });

  it('prunes detailed events after 180 days but keeps permanent identity receipts', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('retention', { createdAt: '2025-01-01T00:00:00.000Z' }));
    store.recordEvent({
      operationId: 'operation-retention',
      eventType: 'old_detail',
      detail: { safe: true },
      at: '2025-01-01T00:00:00.000Z',
    });
    const result = store.pruneDetailedEvents({ now: '2026-01-01T00:00:00.000Z' });
    expect(result.deletedEvents).toBeGreaterThan(0);
    expect(result.deletedTransitions).toBe(0);
    expect(store.listEvents('operation-retention')).toEqual([]);
    expect(store.listTransitions('operation-retention')).toHaveLength(1);
    expect(store.getIdentityReceipt(runInput('retention').idempotencyKeyHash)).toMatchObject({
      manufacturingOrderId: 'mo-retention',
    });
    store.close();
  });

  it('never reclaims an attempted notification and reconciles delivery_unknown manually', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('notify'));
    store.enqueueNotification({
      notificationId: 'notification-1',
      operationId: 'operation-notify',
      kind: 'terminal',
      operationMarker: 'operation-marker-1',
      payload: { state: 'applied_verified' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    store.enqueueNotification({
      notificationId: 'notification-2',
      operationId: 'operation-notify',
      kind: 'terminal',
      operationMarker: 'operation-marker-2',
      payload: { state: 'resolved_manual' },
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    const first = store.claimNextNotification({
      notificationId: 'notification-2',
      claimantId: 'zapier',
      now: '2026-01-01T00:01:00.000Z',
      claimTtlMs: 30_000,
    });
    expect(first.notificationId).toBe('notification-2');
    expect(store.expireNotificationClaims({ now: '2026-01-01T00:01:31.000Z' })).toBe(1);
    expect(store.getNotification('notification-2').status).toBe('delivery_unknown');
    const second = store.claimNextNotification({
      notificationId: 'notification-1',
      claimantId: 'zapier',
      now: '2026-01-01T00:01:32.000Z',
      claimTtlMs: 30_000,
    });
    expect(second.notificationId).toBe('notification-1');
    store.ackNotification({
      notificationId: 'notification-1',
      claimToken: second.claimToken,
      slackTimestamp: '987.654',
      permalink: 'https://example.invalid/slack/987',
      now: '2026-01-01T00:01:32.500Z',
    });
    expect(store.getNotification('notification-1').status).toBe('acknowledged');
    expect(store.claimNextNotification({
      notificationId: 'notification-1',
      claimantId: 'zapier',
      now: '2026-01-01T00:01:33.000Z',
      claimTtlMs: 30_000,
    })).toBeUndefined();
    store.reconcileNotification({
      notificationId: 'notification-2',
      action: 'acknowledge_existing',
      operatorId: 'operator-1',
      slackTimestamp: '123.456',
      permalink: 'https://example.invalid/slack/123',
      now: '2026-01-01T00:02:00.000Z',
    });
    expect(store.getNotification('notification-2')).toMatchObject({
      status: 'acknowledged',
      slackTimestamp: '123.456',
    });
    store.close();
  });

  it('atomically couples collecting and terminal transitions to deterministic durable wake events', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('transition-outbox'));

    expect(() => store.transitionRun({
      operationId: 'operation-transition-outbox',
      expectedRevision: 99,
      toState: 'collecting',
      reason: 'stale writer',
      at: '2026-01-01T00:00:01.000Z',
    })).toThrow(/REVISION_CONFLICT/);
    expect(store.listWebhookEvents('operation-transition-outbox')).toEqual([]);

    store.transitionRun({
      operationId: 'operation-transition-outbox',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:01.000Z',
    });
    expect(store.listWebhookEvents('operation-transition-outbox')).toEqual([
      expect.objectContaining({
        eventId: 'manufacturing-run-wake/v1:run_ready:operation-transition-outbox:1',
        kind: 'run_ready',
        operationMarker: 'operation-transition-outbox:1',
        status: 'pending',
        attemptCount: 0,
      }),
    ]);

    store.transitionRun({
      operationId: 'operation-transition-outbox',
      expectedRevision: 1,
      toState: 'blocked',
      reason: 'operator required',
      at: '2026-01-01T00:00:02.000Z',
    });
    expect(store.listWebhookEvents('operation-transition-outbox')).toEqual([
      expect.objectContaining({ kind: 'run_ready' }),
      expect.objectContaining({
        eventId: 'manufacturing-run-wake/v1:terminal:operation-transition-outbox:2',
        kind: 'terminal',
        payload: expect.objectContaining({
          notificationId:
            'manufacturing-run-notification/v1:operation-transition-outbox:2',
        }),
        status: 'pending',
      }),
    ]);
    expect(store.getNotification(
      'manufacturing-run-notification/v1:operation-transition-outbox:2'
    )).toMatchObject({
      operationId: 'operation-transition-outbox',
      kind: 'terminal',
      status: 'pending',
    });
    store.close();
  });

  it('replays the same durable wake after restart until one bounded delivery is acknowledged', async () => {
    const databasePath = await statePath();
    let store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('wake-restart'));
    store.transitionRun({
      operationId: 'operation-wake-restart',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-01T00:00:00.000Z',
    });
    const first = store.claimNextWebhookEvent({
      claimTtlMs: 5_000,
      now: '2026-01-01T00:00:01.000Z',
    })!;
    expect(first).toMatchObject({
      eventId: 'manufacturing-run-wake/v1:run_ready:operation-wake-restart:1',
      attemptCount: 1,
    });
    store.retryWebhookEvent({
      eventId: first.eventId,
      claimToken: first.claimToken,
      maxAttempts: 3,
      retryAt: '2026-01-01T00:00:03.000Z',
      errorCode: 'WEBHOOK_TRANSPORT_FAILED',
      now: '2026-01-01T00:00:01.500Z',
    });
    store.close();

    store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    expect(store.claimNextWebhookEvent({
      claimTtlMs: 5_000,
      now: '2026-01-01T00:00:02.000Z',
    })).toBeUndefined();
    const replay = store.claimNextWebhookEvent({
      claimTtlMs: 5_000,
      now: '2026-01-01T00:00:03.000Z',
    })!;
    expect(replay).toMatchObject({
      eventId: first.eventId,
      attemptCount: 2,
    });
    store.completeWebhookEvent({
      eventId: replay.eventId,
      claimToken: replay.claimToken,
      now: '2026-01-01T00:00:03.500Z',
    });
    store.close();

    store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    expect(store.claimNextWebhookEvent({
      claimTtlMs: 5_000,
      now: '2026-01-01T00:00:10.000Z',
    })).toBeUndefined();
    expect(store.listWebhookEvents('operation-wake-restart')).toEqual([
      expect.objectContaining({
        eventId: first.eventId,
        status: 'delivered',
        attemptCount: 2,
      }),
    ]);
    store.close();
  });

  it('supports deterministic per-unit dependencies and waits for every unit', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('qty-parent'));
    store.createRun(runInput('qty-child-0'));
    store.createRun(runInput('qty-child-1'));

    expect(store.addDependency({
      parentOperationId: 'operation-qty-parent',
      childOperationId: 'operation-qty-child-0',
      parentRawLineId: 'line-qty',
      parentChildIndex: 0,
    })).toEqual({ created: true });
    expect(store.addDependency({
      parentOperationId: 'operation-qty-parent',
      childOperationId: 'operation-qty-child-1',
      parentRawLineId: 'line-qty',
      parentChildIndex: 1,
    })).toEqual({ created: true });
    expect(() => store.addDependency({
      parentOperationId: 'operation-qty-parent',
      childOperationId: 'operation-conflict',
      parentRawLineId: 'line-qty',
      parentChildIndex: 1,
    })).toThrow(/DEPENDENCY_CONFLICT|UNKNOWN_(?:MANUFACTURING_)?RUN/);

    expect(store.satisfyDependency({
      parentOperationId: 'operation-qty-parent',
      childOperationId: 'operation-qty-child-0',
      parentRawLineId: 'line-qty',
      parentChildIndex: 0,
    })).toEqual({ changed: true, allSatisfied: false });
    expect(store.satisfyDependency({
      parentOperationId: 'operation-qty-parent',
      childOperationId: 'operation-qty-child-1',
      parentRawLineId: 'line-qty',
      parentChildIndex: 1,
    })).toEqual({ changed: true, allSatisfied: true });
    expect(store.listDependencies('operation-qty-parent')).toEqual([
      expect.objectContaining({ parentChildIndex: 0, satisfiedAt: expect.any(String) }),
      expect.objectContaining({ parentChildIndex: 1, satisfiedAt: expect.any(String) }),
    ]);
    store.close();
  });

  it('atomically binds verified child evidence with dependency satisfaction', async () => {
    const databasePath = await statePath();
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      testHooks: {
        afterVerifiedChildArtifactBound: () => {
          throw new Error('SIMULATED_VERIFIED_CHILD_CRASH');
        },
      },
    });
    store.initialize();
    store.createRun(runInput('verified-parent'));
    store.createRun(runInput('verified-child'));
    store.addDependency({
      parentOperationId: 'operation-verified-parent',
      childOperationId: 'operation-verified-child',
      parentRawLineId: 'line-verified',
      parentChildIndex: 0,
    });

    expect(() => store.completeDependencyWithArtifact({
      parentOperationId: 'operation-verified-parent',
      childOperationId: 'operation-verified-child',
      parentRawLineId: 'line-verified',
      parentChildIndex: 0,
      artifact: {
        artifactType: 'parent_verified_put',
        artifactHash: 'verified-put-hash',
        artifact: { serialNumbers: ['SERIAL-1'] },
        at: '2026-01-01T00:00:01.000Z',
      },
    })).toThrow(/SIMULATED_VERIFIED_CHILD_CRASH/);
    expect(store.getRunArtifact(
      'operation-verified-child',
      'parent_verified_put'
    )).toBeUndefined();
    expect(store.listDependencies('operation-verified-parent')[0]).toMatchObject({
      satisfiedAt: null,
    });
    store.close();
  });

  it('lists terminal dependency outcomes whose ancestors still need reconciliation', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('reconcile-parent'));
    store.createRun(runInput('reconcile-child'));
    store.transitionRun({
      operationId: 'operation-reconcile-parent',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'parent expanded',
    });
    store.addDependency({
      parentOperationId: 'operation-reconcile-parent',
      childOperationId: 'operation-reconcile-child',
      parentRawLineId: 'line-reconcile',
    });
    store.transitionRun({
      operationId: 'operation-reconcile-child',
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'simulated crash before propagation',
    });

    expect(store.listDependencyRunsForReconciliation()).toEqual([
      expect.objectContaining({
        operationId: 'operation-reconcile-child',
        state: 'blocked',
      }),
    ]);
    store.transitionRun({
      operationId: 'operation-reconcile-parent',
      expectedRevision: 1,
      toState: 'blocked',
      reason: 'reconciled child failure',
    });
    expect(store.listDependencyRunsForReconciliation()).toEqual([]);
    store.close();
  });

  it('atomically transitions a verified child with its parent evidence and satisfaction', async () => {
    const databasePath = await statePath();
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      testHooks: {
        afterAppliedChildTransitioned: () => {
          throw new Error('SIMULATED_CHILD_TRANSITION_CRASH');
        },
      },
    });
    store.initialize();
    store.createRun(runInput('atomic-parent'));
    store.createRun(runInput('atomic-child'));
    for (const [expectedRevision, toState] of [
      [0, 'collecting'],
      [1, 'ready'],
      [2, 'prepared'],
      [3, 'dispatch_uncertain'],
    ] as const) {
      store.transitionRun({
        operationId: 'operation-atomic-child',
        expectedRevision,
        toState,
        reason: `advance to ${toState}`,
      });
    }
    store.addDependency({
      parentOperationId: 'operation-atomic-parent',
      childOperationId: 'operation-atomic-child',
      parentRawLineId: 'line-atomic',
      parentChildIndex: 0,
    });

    expect(() => store.transitionAppliedVerifiedChildWithArtifact({
      operationId: 'operation-atomic-child',
      expectedRevision: 4,
      reason: 'exact verified readback',
      parentOperationId: 'operation-atomic-parent',
      parentRawLineId: 'line-atomic',
      parentChildIndex: 0,
      artifact: {
        artifactType: 'parent_verified_put',
        artifactHash: 'atomic-child-evidence-hash',
        artifact: { serialNumbers: ['SERIAL-1'] },
      },
    })).toThrow(/SIMULATED_CHILD_TRANSITION_CRASH/);
    expect(store.getRun('operation-atomic-child')).toMatchObject({
      state: 'dispatch_uncertain',
      stateRevision: 4,
    });
    expect(store.getRunArtifact(
      'operation-atomic-child',
      'parent_verified_put'
    )).toBeUndefined();
    expect(store.listDependencies('operation-atomic-parent')[0]).toMatchObject({
      satisfiedAt: null,
    });
    expect(store.listWebhookEvents('operation-atomic-child')).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ state: 'applied_verified' }),
        }),
      ])
    );
    store.close();
  });

  it('atomically audits a signed manual approval with its terminal transition', async () => {
    const databasePath = await statePath();
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      testHooks: {
        afterManualApprovalArtifactBound: () => {
          throw new Error('SIMULATED_MANUAL_APPROVAL_CRASH');
        },
      },
    });
    store.initialize();
    store.createRun(runInput('manual-approval'));
    store.transitionRun({
      operationId: 'operation-manual-approval',
      expectedRevision: 0,
      toState: 'blocked',
      reason: 'operator required',
    });

    expect(() => store.resolveRunManualWithArtifact({
      operationId: 'operation-manual-approval',
      expectedRevision: 1,
      artifact: {
        artifactType: 'manual_resolution_approval:1',
        artifactHash: 'manual-approval-hash',
        artifact: { operatorId: 'operator-1' },
      },
      reason: 'signed manual resolution by operator-1',
    })).toThrow(/SIMULATED_MANUAL_APPROVAL_CRASH/);
    expect(store.getRunArtifact(
      'operation-manual-approval',
      'manual_resolution_approval:1'
    )).toBeUndefined();
    expect(store.getRun('operation-manual-approval')).toMatchObject({
      state: 'blocked',
      stateRevision: 1,
    });
    store.close();
  });

  it('atomically expires stale notification claims before ack and requires reconciliation before reclaim', async () => {
    const databasePath = await statePath();
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('stale-notification'));
    store.enqueueNotification({
      notificationId: 'notification-stale',
      operationId: 'operation-stale-notification',
      kind: 'terminal',
      operationMarker: 'stale-notification-marker',
      payload: { state: 'blocked' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const first = store.claimNextNotification({
      notificationId: 'notification-stale',
      claimantId: 'slack-worker-1',
      claimTtlMs: 1_000,
      now: '2026-01-01T00:00:01.000Z',
    });

    expect(() => store.ackNotification({
      notificationId: 'notification-stale',
      claimToken: first.claimToken,
      slackTimestamp: '111.222',
      permalink: 'https://example.invalid/slack/stale',
      now: '2026-01-01T00:00:02.001Z',
    })).toThrow(/NOTIFICATION_CLAIM_CONFLICT/);
    expect(store.getNotification('notification-stale')).toMatchObject({
      status: 'delivery_unknown',
      claimToken: first.claimToken,
      attemptCount: 1,
    });
    expect(store.claimNextNotification({
      notificationId: 'notification-stale',
      claimantId: 'slack-worker-2',
      claimTtlMs: 1_000,
      now: '2026-01-01T00:00:03.000Z',
    })).toBeUndefined();

    store.reconcileNotification({
      notificationId: 'notification-stale',
      action: 'retry_after_duplicate_risk',
      operatorId: 'operator-1',
      now: '2026-01-01T00:00:04.000Z',
    });
    const second = store.claimNextNotification({
      notificationId: 'notification-stale',
      claimantId: 'slack-worker-2',
      claimTtlMs: 1_000,
      now: '2026-01-01T00:00:05.000Z',
    });
    expect(second).toMatchObject({
      notificationId: 'notification-stale',
      status: 'claimed',
      attemptCount: 2,
    });
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(() => store.ackNotification({
      notificationId: 'notification-stale',
      claimToken: first.claimToken,
      slackTimestamp: '333.444',
      permalink: 'https://example.invalid/slack/duplicate',
      now: '2026-01-01T00:00:05.500Z',
    })).toThrow(/NOTIFICATION_CLAIM_CONFLICT/);
    expect(store.ackNotification({
      notificationId: 'notification-stale',
      claimToken: second.claimToken,
      slackTimestamp: '555.666',
      permalink: 'https://example.invalid/slack/current',
      now: '2026-01-01T00:00:05.500Z',
    })).toMatchObject({
      status: 'acknowledged',
      slackTimestamp: '555.666',
    });
    expect(() => store.ackNotification({
      notificationId: 'notification-stale',
      claimToken: second.claimToken,
      slackTimestamp: '777.888',
      permalink: 'https://example.invalid/slack/repeated',
      now: '2026-01-01T00:00:05.600Z',
    })).toThrow(/NOTIFICATION_CLAIM_CONFLICT/);
    store.close();
  });

  it('creates an online backup and quarantines every nonterminal run on restore while advancing epoch', async () => {
    const databasePath = await statePath();
    const backupPath = join(
      MODE_ENFORCING_TEMP_ROOT,
      `inflow-manufacturing-backup-${crypto.randomUUID()}.sqlite`
    );
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('restore-active'));
    store.createRun(runInput('restore-terminal'));
    store.transitionRun({
      operationId: 'operation-restore-terminal',
      expectedRevision: 0,
      toState: 'conflict',
      reason: 'deterministic conflict',
    });
    store.enqueueNotification({
      notificationId: 'notification-before-backup',
      operationId: 'operation-restore-active',
      kind: 'terminal',
      operationMarker: 'restore-operation-marker',
      payload: { state: 'pending-before-backup' },
    });
    const originalEpoch = store.getDeploymentEpoch();
    await store.createBackup(backupPath);
    expect((await stat(backupPath)).size).toBeGreaterThan(0);

    store.createRun(runInput('after-backup'));
    const restored = await store.restoreFromBackup({
      backupPath,
      reason: 'restore drill',
      restoredAt: '2026-01-02T00:00:00.000Z',
    });
    expect(restored.epoch).toBe(originalEpoch + 1);
    expect(restored.quarantinedOperationIds).toContain('operation-restore-active');
    expect(store.getRun('operation-restore-active').state).toBe('restore_quarantine');
    expect(store.getRun('operation-restore-terminal').state).toBe('conflict');
    expect(store.getRun('operation-after-backup')).toBeUndefined();
    expect(store.listQueuedRuns()).toEqual([]);
    expect(store.getNotification('notification-before-backup').status)
      .toBe('delivery_unknown');
    expect(store.listWebhookEvents('operation-restore-active')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          payload: expect.objectContaining({ state: 'restore_quarantine' }),
          status: 'pending',
        }),
      ])
    );
    expect(store.claimNextNotification({
      notificationId:
        'manufacturing-run-notification/v1:operation-restore-active:1',
      claimantId: 'zapier-after-restore',
      claimTtlMs: 30_000,
    })).toMatchObject({
      operationId: 'operation-restore-active',
      status: 'claimed',
      payload: expect.objectContaining({ state: 'restore_quarantine' }),
    });

    const secondRestore = await store.restoreFromBackup({
      backupPath,
      reason: 'second restore drill',
      restoredAt: '2026-01-03T00:00:00.000Z',
    });
    expect(secondRestore.epoch).toBe(originalEpoch + 2);
    store.close();
    await rm(backupPath, { force: true });
  });

  it('migrates a legacy v1 backup before restore quarantine', async () => {
    const databasePath = await statePath();
    const backupPath = join(
      MODE_ENFORCING_TEMP_ROOT,
      `inflow-manufacturing-v1-backup-${crypto.randomUUID()}.sqlite`
    );
    const store = new (Store())({ databasePath, minimumFreeBytes: 0 });
    store.initialize();
    store.createRun(runInput('legacy-backup'));
    await store.createBackup(backupPath);

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const legacyBackup = new BetterSqlite3(backupPath);
    legacyBackup.exec(`
      DELETE FROM run_transitions
      WHERE operation_id = 'operation-legacy-backup';
      UPDATE schema_metadata
      SET value = '1'
      WHERE key = 'schema_version';
      PRAGMA user_version = 1;
    `);
    legacyBackup.close();
    await chmod(backupPath, 0o600);

    await expect(store.restoreFromBackup({
      backupPath,
      reason: 'legacy backup migration',
      restoredAt: '2026-01-02T00:00:00.000Z',
    })).resolves.toMatchObject({
      epoch: 2,
      quarantinedOperationIds: ['operation-legacy-backup'],
    });
    expect(store.getStartupDiagnostics().userVersion).toBe(3);
    expect(store.listTransitions('operation-legacy-backup')).toEqual([
      expect.objectContaining({
        fromState: null,
        toState: 'creating',
        stateRevision: 0,
        reason: 'schema_v2_retention_checkpoint',
      }),
      expect.objectContaining({
        fromState: 'creating',
        toState: 'restore_quarantine',
        stateRevision: 1,
      }),
    ]);
    store.close();
    await rm(backupPath, { force: true });
  });

  it('has a fully quarantined durable database at the post-rename restore crash boundary', async () => {
    const databasePath = await statePath();
    const backupPath = join(
      MODE_ENFORCING_TEMP_ROOT,
      `inflow-manufacturing-crash-backup-${crypto.randomUUID()}.sqlite`
    );
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    let observedAtCrash: Record<string, unknown> | undefined;
    const store = new (Store())({
      databasePath,
      minimumFreeBytes: 0,
      testHooks: {
        afterRestoredDatabaseRenamed: (livePath: string) => {
          const restored = new BetterSqlite3(livePath, {
            readonly: true,
            fileMustExist: true,
          });
          observedAtCrash = {
            runState: restored.prepare(
              `SELECT state FROM runs WHERE operation_id = 'operation-restore-crash'`
            ).pluck().get(),
            queueRows: restored.prepare('SELECT COUNT(*) FROM work_queue').pluck().get(),
            leaseRows: restored.prepare('SELECT COUNT(*) FROM worker_lease').pluck().get(),
            notificationState: restored.prepare(
              `SELECT status FROM notification_outbox
               WHERE notification_id = 'notification-restore-crash'`
            ).pluck().get(),
            epoch: Number(restored.prepare(
              `SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'`
            ).pluck().get()),
            restoreRows: restored.prepare('SELECT COUNT(*) FROM restore_history').pluck().get(),
          };
          restored.close();
          throw new Error('SIMULATED_RESTORE_CRASH_AFTER_RENAME');
        },
      },
    });
    store.initialize();
    store.createRun(runInput('restore-crash'));
    store.transitionRun({
      operationId: 'operation-restore-crash',
      expectedRevision: 0,
      toState: 'collecting',
      reason: 'expanded',
      at: '2026-01-02T00:00:00.000Z',
    });
    store.transitionRun({
      operationId: 'operation-restore-crash',
      expectedRevision: 1,
      toState: 'ready',
      reason: 'ready',
      at: '2026-01-03T00:00:00.000Z',
    });
    store.enqueueRun({ operationId: 'operation-restore-crash' });
    store.acquireWorkerLease({
      workerId: 'restore-crash-worker',
      leaseMs: 60_000,
    });
    store.enqueueNotification({
      notificationId: 'notification-restore-crash',
      operationId: 'operation-restore-crash',
      kind: 'terminal',
      operationMarker: 'restore-crash-marker',
      payload: { state: 'ready' },
    });
    await store.createBackup(backupPath);
    store.createRun(runInput('live-after-backup'));

    await expect(store.restoreFromBackup({
      backupPath,
      reason: 'crash-window drill',
      restoredAt: '2026-01-04T00:00:00.000Z',
    })).rejects.toThrow(/SIMULATED_RESTORE_CRASH_AFTER_RENAME/);
    expect(observedAtCrash).toEqual({
      runState: 'restore_quarantine',
      queueRows: 0,
      leaseRows: 0,
      notificationState: 'delivery_unknown',
      epoch: 2,
      restoreRows: 1,
    });
    expect(store.getRun('operation-live-after-backup')).toBeDefined();

    store.close();
    await rm(backupPath, { force: true });
  });
});
