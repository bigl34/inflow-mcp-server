import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ExplicitMutationConfirmationScope } from './mutation.js';

export type JournalState =
  | 'preview'
  | 'prepared'
  | 'dispatched'
  | 'applied_verified'
  | 'applied_unverified'
  | 'unknown_after_write'
  | 'partial_applied'
  | 'conflict'
  | 'no_op'
  | 'not_applied';

export interface MutationJournalStep {
  stepId: string;
  kind: 'apply' | 'compensate';
  intentHash: string;
  plannedIds: string[];
  state: 'prepared' | 'dispatched' | 'verified' | 'unknown' | 'failed';
  updatedAt: string;
  residualIds?: string[];
  possibleResidualIds?: string[];
  invalidationTags: string[];
  errorCode?: string;
}

export interface MutationJournalRecord {
  schemaVersion: 'mutation-journal/v1';
  operationId: string;
  idempotencyKeyHash?: string;
  tenantFingerprint: string;
  resourceType: string;
  resourceId?: string;
  adapterVersion: string;
  desiredHash: string;
  currentSemanticHash?: string;
  currentWriteShapeHash?: string;
  plannedIds?: Record<string, string[]>;
  state: JournalState;
  createdAt: string;
  updatedAt: string;
  affectedResources: Array<{ type: string; id?: string }>;
  invalidationTags: string[];
  confirmation?: {
    hash: string;
    scope: ExplicitMutationConfirmationScope;
    receivedAt: string;
  };
  residualIds?: string[];
  possibleResidualIds?: string[];
  steps: MutationJournalStep[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class MutationJournal {
  private readonly operationsDir: string;
  private readonly idempotencyDir: string;
  private readonly locksDir: string;

  constructor(private readonly stateDir: string) {
    this.operationsDir = join(stateDir, 'operations');
    this.idempotencyDir = join(stateDir, 'idempotency');
    this.locksDir = join(stateDir, 'locks');
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.stateDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('UNSAFE_STATE_DIR: state directory must be a real directory');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('UNSAFE_STATE_DIR: state directory must not be group/world accessible');
    }
    await Promise.all([
      mkdir(this.operationsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.idempotencyDir, { recursive: true, mode: 0o700 }),
      mkdir(this.locksDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  private operationPath(operationId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(operationId)) throw new Error('Invalid operation ID');
    return join(this.operationsDir, `${operationId}.json`);
  }

  private idempotencyPath(keyHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(keyHash)) throw new Error('Invalid idempotency key hash');
    return join(this.idempotencyDir, `${keyHash}.json`);
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    await chmod(path, 0o600);
  }

  async get(operationId: string): Promise<MutationJournalRecord | undefined> {
    await this.initialize();
    try {
      return JSON.parse(
        await readFile(this.operationPath(operationId), 'utf8')
      ) as MutationJournalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(record: MutationJournalRecord): Promise<void> {
    await this.initialize();
    const existing = await this.get(record.operationId);
    if (
      existing &&
      ['applied_verified', 'no_op', 'conflict', 'not_applied'].includes(existing.state) &&
      existing.state !== record.state
    ) {
      throw new Error(`TERMINAL_MUTATION_IMMUTABLE: ${record.operationId}`);
    }
    await this.atomicWrite(this.operationPath(record.operationId), record);
    await this.appendEvent(record.operationId, {
      at: record.updatedAt,
      state: record.state,
      stepCount: record.steps.length,
      residualIds: record.residualIds,
      possibleResidualIds: record.possibleResidualIds,
    });
  }

  private async appendEvent(operationId: string, event: unknown): Promise<void> {
    const path = join(this.operationsDir, `${operationId}.events.jsonl`);
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  }

  async update(
    operationId: string,
    mutate: (current: MutationJournalRecord) => MutationJournalRecord
  ): Promise<MutationJournalRecord> {
    return this.withLock(`operation-${operationId}`, async () => {
      const current = await this.get(operationId);
      if (!current) throw new Error(`UNKNOWN_OPERATION: ${operationId}`);
      const next = mutate(current);
      await this.put(next);
      return next;
    });
  }

  async appendStep(operationId: string, step: MutationJournalStep): Promise<void> {
    await this.update(operationId, (current) => ({
      ...current,
      steps: [...current.steps.filter((row) => row.stepId !== step.stepId), step],
      updatedAt: new Date().toISOString(),
    }));
  }

  async getIdempotency(keyHash: string): Promise<{
    operationId: string;
    desiredHash: string;
    plannedIds?: Record<string, string[]>;
  } | undefined> {
    await this.initialize();
    try {
      return JSON.parse(await readFile(this.idempotencyPath(keyHash), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async putIdempotency(
    keyHash: string,
    value: { operationId: string; desiredHash: string; plannedIds?: Record<string, string[]> }
  ): Promise<void> {
    await this.getOrCreateIdempotency(keyHash, value);
  }

  async getOrCreateIdempotency(
    keyHash: string,
    value: { operationId: string; desiredHash: string; plannedIds?: Record<string, string[]> }
  ): Promise<{ operationId: string; desiredHash: string; plannedIds?: Record<string, string[]> }> {
    await this.initialize();
    return this.withLock(`idempotency-${keyHash}`, async () => {
      const current = await this.getIdempotency(keyHash);
      if (current) {
        if (current.desiredHash !== value.desiredHash) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT: key already binds a different desired state');
        }
        return current;
      }
      await this.atomicWrite(this.idempotencyPath(keyHash), value);
      return value;
    });
  }

  async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.initialize();
    const safeName = name.replace(/[^A-Za-z0-9_-]/g, '_');
    const lockPath = join(this.locksDir, safeName);
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const owner = await open(join(lockPath, 'owner.json'), 'wx', 0o600);
        try {
          await owner.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }), 'utf8');
          await owner.sync();
        } finally { await owner.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = await lstat(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            let ownerAlive = true;
            try {
              const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { pid?: number; hostname?: string };
              if (owner.hostname === hostname() && Number.isInteger(owner.pid)) {
                try { process.kill(owner.pid!, 0); }
                catch (ownerError) {
                  ownerAlive = (ownerError as NodeJS.ErrnoException).code !== 'ESRCH';
                }
              }
            } catch (ownerError) {
              ownerAlive = (ownerError as NodeJS.ErrnoException).code !== 'ENOENT';
            }
            if (!ownerAlive) {
              await rm(lockPath, { recursive: true, force: true });
              continue;
            }
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        if (Date.now() - started > 5_000) {
          throw new Error(`MUTATION_LOCK_TIMEOUT: ${name}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}
