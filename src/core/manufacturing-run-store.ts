import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalHash, stableStringify } from './canonical-json.js';

export const MANUFACTURING_RUN_STATES = [
  'creating',
  'collecting',
  'waiting_dependencies',
  'ready',
  'prepared',
  'dispatch_uncertain',
  'applied_verified',
  'staged_awaiting_operations',
  'resolved_manual',
  'failed_no_write',
  'conflict',
  'blocked',
  'restore_quarantine',
  'abandoned',
] as const;

export type ManufacturingRunState = (typeof MANUFACTURING_RUN_STATES)[number];

export const MANUFACTURING_RUN_SCHEMA_VERSION = 3;
export const MANUFACTURING_EVENT_RETENTION_DAYS = 180;
export const COORDINATOR_REQUESTS_PER_MINUTE = 20;
export const COORDINATOR_RATE_WINDOW_MS = 60_000;

const RUN_STATE_SET = new Set<string>(MANUFACTURING_RUN_STATES);
const RUN_STATE_SQL_LIST = MANUFACTURING_RUN_STATES
  .map((state) => `'${state}'`)
  .join(', ');
const TERMINAL_STATES = new Set<ManufacturingRunState>([
  'applied_verified',
  'resolved_manual',
  'failed_no_write',
  'conflict',
  'abandoned',
]);
const QUEUEABLE_STATES = new Set<ManufacturingRunState>(['creating', 'ready', 'prepared']);
const RESTORE_TERMINAL_STATES = TERMINAL_STATES;
const NOTIFICATION_STATES = new Set<ManufacturingRunState>([
  ...TERMINAL_STATES,
  'staged_awaiting_operations',
  'blocked',
  'restore_quarantine',
]);

const ALLOWED_TRANSITIONS: Record<ManufacturingRunState, ReadonlySet<ManufacturingRunState>> = {
  creating: new Set([
    'collecting',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  collecting: new Set([
    'waiting_dependencies',
    'ready',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  waiting_dependencies: new Set([
    'collecting',
    'ready',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  ready: new Set([
    'waiting_dependencies',
    'prepared',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  prepared: new Set([
    'dispatch_uncertain',
    'staged_awaiting_operations',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  dispatch_uncertain: new Set([
    'prepared',
    'applied_verified',
    'staged_awaiting_operations',
    'resolved_manual',
    'failed_no_write',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  applied_verified: new Set(),
  staged_awaiting_operations: new Set([
    'applied_verified',
    'resolved_manual',
    'conflict',
    'blocked',
    'restore_quarantine',
    'abandoned',
  ]),
  resolved_manual: new Set(),
  failed_no_write: new Set(),
  conflict: new Set(),
  blocked: new Set([
    'collecting',
    'resolved_manual',
    'restore_quarantine',
    'abandoned',
  ]),
  restore_quarantine: new Set(['resolved_manual', 'abandoned']),
  abandoned: new Set(),
};

interface DatabaseRow {
  [column: string]: unknown;
}

export interface ManufacturingRunStoreOptions {
  databasePath: string;
  minimumFreeBytes?: number;
  busyTimeoutMs?: number;
  expectedOwnerUid?: number;
  getFreeBytes?: (path: string) => number;
  requestsPerMinute?: number;
  testHooks?: {
    afterRestoredDatabaseRenamed?: (databasePath: string) => void;
    afterDependentRunBegun?: () => void;
    afterVerifiedChildArtifactBound?: () => void;
    afterManualApprovalArtifactBound?: () => void;
    afterAppliedChildTransitioned?: () => void;
  };
}

export interface ManufacturingRunRecord {
  operationId: string;
  idempotencyKeyHash: string;
  runHash: string;
  canonicalIdentity: unknown;
  immutableIntentHash: string;
  completePreWriteHash: string | null;
  expectedPostStateHash: string | null;
  preparedRequestHash: string | null;
  manufacturingOrderId: string;
  rootLineId: string;
  coordinatorMarker: string;
  parentOperationId: string | null;
  parentRawLineId: string | null;
  state: ManufacturingRunState;
  stateRevision: number;
  createdAt: string;
  updatedAt: string;
  deploymentEpoch: number;
  restoreEpoch: number | null;
}

export interface StartupDiagnostics {
  writeGateOpen: boolean;
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
  userVersion: number;
  deploymentEpoch: number;
}

export interface ComponentIntentRecord {
  operationId: string;
  rawLineId: string;
  intentHash: string;
  productId: string;
  quantity: string;
  locationId: string;
  sublocation: string | null;
  serialized: boolean;
  serialNumbers: string[];
  createdAt: string;
}

export interface ManufacturingRunArtifactRecord {
  artifactType: string;
  artifactHash: string;
  artifact: unknown;
  at: string;
}

export interface ManufacturingRunCreateInput {
  operationId: string;
  idempotencyKeyHash: string;
  canonicalIdentity: unknown;
  runHash: string;
  immutableIntentHash: string;
  manufacturingOrderId: string;
  rootLineId: string;
  coordinatorMarker: string;
  parentOperationId?: string | null;
  parentRawLineId?: string | null;
  createdAt?: string | Date | number;
}

export interface ManufacturingRunArtifactInput {
  operationId: string;
  artifactType: string;
  artifactHash: string;
  artifact: unknown;
  at?: string | Date | number;
}

export interface ManufacturingRunDependencyRecord {
  parentOperationId: string;
  childOperationId: string;
  parentRawLineId: string;
  parentChildIndex: number;
  createdAt: string;
  satisfiedAt: string | null;
}

export interface WebhookEventRecord {
  eventId: string;
  operationId: string;
  kind: 'run_ready' | 'terminal';
  operationMarker: string;
  payload: unknown;
  status: 'pending' | 'claimed' | 'delivered' | 'exhausted';
  claimToken: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  attemptCount: number;
  availableAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRecord {
  notificationId: string;
  operationId: string;
  kind: string;
  operationMarker: string;
  payload: unknown;
  status: 'pending' | 'claimed' | 'delivery_unknown' | 'acknowledged';
  claimToken: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  attemptCount: number;
  slackTimestamp: string | null;
  permalink: string | null;
  createdAt: string;
  updatedAt: string;
}

const RUN_DEPENDENCIES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS run_dependencies (
    parent_operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    child_operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    parent_raw_line_id TEXT NOT NULL,
    parent_child_index INTEGER NOT NULL CHECK (parent_child_index >= 0),
    created_at_ms INTEGER NOT NULL,
    satisfied_at_ms INTEGER,
    PRIMARY KEY (parent_operation_id, parent_raw_line_id, parent_child_index),
    UNIQUE (parent_operation_id, child_operation_id, parent_raw_line_id),
    CHECK (parent_operation_id <> child_operation_id)
  ) STRICT
`;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS runs (
    operation_id TEXT PRIMARY KEY,
    idempotency_key_hash TEXT NOT NULL,
    run_hash TEXT NOT NULL UNIQUE,
    canonical_identity_json TEXT NOT NULL,
    immutable_intent_hash TEXT NOT NULL,
    complete_pre_write_hash TEXT,
    expected_post_state_hash TEXT,
    prepared_request_hash TEXT,
    manufacturing_order_id TEXT NOT NULL UNIQUE,
    root_line_id TEXT NOT NULL,
    coordinator_marker TEXT NOT NULL,
    parent_operation_id TEXT REFERENCES runs(operation_id),
    parent_raw_line_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'creating', 'collecting', 'waiting_dependencies', 'ready', 'prepared',
      'dispatch_uncertain', 'applied_verified', 'staged_awaiting_operations',
      'resolved_manual', 'failed_no_write', 'conflict', 'blocked',
      'restore_quarantine', 'abandoned'
    )),
    state_revision INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deployment_epoch INTEGER NOT NULL,
    restore_epoch INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS identity_receipts (
    run_key_hash TEXT PRIMARY KEY,
    run_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    immutable_intent_hash TEXT NOT NULL,
    manufacturing_order_id TEXT NOT NULL,
    root_line_id TEXT NOT NULL,
    canonical_identity_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS component_intents (
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    raw_line_id TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity TEXT NOT NULL,
    location_id TEXT NOT NULL,
    sublocation TEXT,
    serialized INTEGER NOT NULL CHECK (serialized IN (0, 1)),
    serial_numbers_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (operation_id, raw_line_id)
  ) STRICT;

  ${RUN_DEPENDENCIES_SCHEMA_SQL};

  CREATE TABLE IF NOT EXISTS dependency_ancestors (
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    ancestor_operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    depth INTEGER NOT NULL CHECK (depth > 0),
    PRIMARY KEY (operation_id, ancestor_operation_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS run_transitions (
    transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    from_state TEXT,
    to_state TEXT NOT NULL,
    state_revision INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS run_transitions_retention
    ON run_transitions(at_ms);

  CREATE TABLE IF NOT EXISTS run_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS run_events_retention
    ON run_events(at_ms);

  CREATE TABLE IF NOT EXISTS work_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE REFERENCES runs(operation_id),
    enqueued_at_ms INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL,
    claimed_by TEXT,
    claim_epoch INTEGER,
    claimed_at_ms INTEGER,
    claim_expires_at_ms INTEGER
  ) STRICT;

  CREATE INDEX IF NOT EXISTS work_queue_fifo
    ON work_queue(available_at_ms, queue_id);

  CREATE TABLE IF NOT EXISTS worker_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    worker_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS rate_ledger (
    request_id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS rate_ledger_window
    ON rate_ledger(requested_at_ms);

  CREATE TABLE IF NOT EXISTS notification_outbox (
    notification_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    kind TEXT NOT NULL,
    operation_marker TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'claimed', 'delivery_unknown', 'acknowledged'
    )),
    claim_token TEXT,
    claimed_by TEXT,
    claimed_at_ms INTEGER,
    claim_expires_at_ms INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    slack_timestamp TEXT,
    permalink TEXT,
    reconciliation_json TEXT,
    duplicate_risk_accepted_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS notification_outbox_fifo
    ON notification_outbox(status, created_at_ms, notification_id);

  CREATE TABLE IF NOT EXISTS webhook_outbox (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES runs(operation_id),
    kind TEXT NOT NULL CHECK (kind IN ('run_ready', 'terminal')),
    operation_marker TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'claimed', 'delivered', 'exhausted'
    )),
    claim_token TEXT,
    claimed_at_ms INTEGER,
    claim_expires_at_ms INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at_ms INTEGER NOT NULL,
    last_error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS webhook_outbox_fifo
    ON webhook_outbox(status, available_at_ms, created_at_ms, event_id);

  CREATE TABLE IF NOT EXISTS hmac_nonces (
    kid TEXT NOT NULL,
    nonce TEXT NOT NULL,
    claimed_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (kid, nonce)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS hmac_nonces_expiry
    ON hmac_nonces(expires_at_ms);

  CREATE TABLE IF NOT EXISTS restore_history (
    restore_epoch INTEGER PRIMARY KEY,
    source_backup_path TEXT NOT NULL,
    reason TEXT NOT NULL,
    restored_at_ms INTEGER NOT NULL,
    quarantined_count INTEGER NOT NULL
  ) STRICT;
`;

function normalizeSchemaDefinition(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\bif\s+not\s+exists\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const REQUIRED_SCHEMA_DEFINITIONS = new Map<string, string>(
  SCHEMA_SQL
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => {
      const match = /^create\s+(?:table|index)\s+if\s+not\s+exists\s+([a-z0-9_]+)/i.exec(
        statement
      );
      if (!match) throw new Error(`Invalid authoritative schema statement: ${statement}`);
      return [match[1]!, normalizeSchemaDefinition(statement)];
    })
);

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`INVALID_${name.toUpperCase()}: non-empty string required`);
  }
  return value;
}

function toMilliseconds(value: string | Date | number | undefined, fallback = Date.now()): number {
  if (value === undefined) return fallback;
  const milliseconds =
    typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`INVALID_TIMESTAMP: ${String(value)}`);
  return milliseconds;
}

function toIso(milliseconds: number | null | undefined): string | null {
  return milliseconds === null || milliseconds === undefined
    ? null
    : new Date(milliseconds).toISOString();
}

function sqliteErrorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

function isSqliteCorruption(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    /not a database|database disk image is malformed/i.test(message)
  );
}

function ensureSecureDirectory(path: string, expectedOwnerUid: number | undefined): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('UNSAFE_DATABASE_DIRECTORY: state path must be a real directory');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('UNSAFE_DATABASE_DIRECTORY_MODE: group/world access is forbidden');
  }
  if (expectedOwnerUid !== undefined && info.uid !== expectedOwnerUid) {
    throw new Error('UNSAFE_DATABASE_OWNER: state directory owner mismatch');
  }
}

function secureDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function asRun(row: DatabaseRow): ManufacturingRunRecord {
  return {
    operationId: String(row.operation_id),
    idempotencyKeyHash: String(row.idempotency_key_hash),
    runHash: String(row.run_hash),
    canonicalIdentity: JSON.parse(String(row.canonical_identity_json)),
    immutableIntentHash: String(row.immutable_intent_hash),
    completePreWriteHash:
      row.complete_pre_write_hash === null ? null : String(row.complete_pre_write_hash),
    expectedPostStateHash:
      row.expected_post_state_hash === null ? null : String(row.expected_post_state_hash),
    preparedRequestHash:
      row.prepared_request_hash === null ? null : String(row.prepared_request_hash),
    manufacturingOrderId: String(row.manufacturing_order_id),
    rootLineId: String(row.root_line_id),
    coordinatorMarker: String(row.coordinator_marker),
    parentOperationId:
      row.parent_operation_id === null ? null : String(row.parent_operation_id),
    parentRawLineId:
      row.parent_raw_line_id === null ? null : String(row.parent_raw_line_id),
    state: String(row.state) as ManufacturingRunState,
    stateRevision: Number(row.state_revision),
    createdAt: toIso(Number(row.created_at_ms))!,
    updatedAt: toIso(Number(row.updated_at_ms))!,
    deploymentEpoch: Number(row.deployment_epoch),
    restoreEpoch: row.restore_epoch === null ? null : Number(row.restore_epoch),
  };
}

function asIntent(row: DatabaseRow): ComponentIntentRecord {
  return {
    operationId: String(row.operation_id),
    rawLineId: String(row.raw_line_id),
    intentHash: String(row.intent_hash),
    productId: String(row.product_id),
    quantity: String(row.quantity),
    locationId: String(row.location_id),
    sublocation: row.sublocation === null ? null : String(row.sublocation),
    serialized: Number(row.serialized) === 1,
    serialNumbers: JSON.parse(String(row.serial_numbers_json)) as string[],
    createdAt: toIso(Number(row.created_at_ms))!,
  };
}

function asNotification(row: DatabaseRow): NotificationRecord {
  return {
    notificationId: String(row.notification_id),
    operationId: String(row.operation_id),
    kind: String(row.kind),
    operationMarker: String(row.operation_marker),
    payload: JSON.parse(String(row.payload_json)),
    status: String(row.status) as NotificationRecord['status'],
    claimToken: row.claim_token === null ? null : String(row.claim_token),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    claimedAt: toIso(row.claimed_at_ms === null ? null : Number(row.claimed_at_ms)),
    claimExpiresAt: toIso(
      row.claim_expires_at_ms === null ? null : Number(row.claim_expires_at_ms)
    ),
    attemptCount: Number(row.attempt_count),
    slackTimestamp: row.slack_timestamp === null ? null : String(row.slack_timestamp),
    permalink: row.permalink === null ? null : String(row.permalink),
    createdAt: toIso(Number(row.created_at_ms))!,
    updatedAt: toIso(Number(row.updated_at_ms))!,
  };
}

function asWebhookEvent(row: DatabaseRow): WebhookEventRecord {
  return {
    eventId: String(row.event_id),
    operationId: String(row.operation_id),
    kind: String(row.kind) as WebhookEventRecord['kind'],
    operationMarker: String(row.operation_marker),
    payload: JSON.parse(String(row.payload_json)),
    status: String(row.status) as WebhookEventRecord['status'],
    claimToken: row.claim_token === null ? null : String(row.claim_token),
    claimedAt: toIso(row.claimed_at_ms === null ? null : Number(row.claimed_at_ms)),
    claimExpiresAt: toIso(
      row.claim_expires_at_ms === null ? null : Number(row.claim_expires_at_ms)
    ),
    attemptCount: Number(row.attempt_count),
    availableAt: toIso(Number(row.available_at_ms))!,
    lastErrorCode:
      row.last_error_code === null ? null : String(row.last_error_code),
    createdAt: toIso(Number(row.created_at_ms))!,
    updatedAt: toIso(Number(row.updated_at_ms))!,
  };
}

export class ManufacturingRunStore {
  private readonly databasePath: string;
  private readonly usedMarkerPath: string;
  private readonly minimumFreeBytes: number;
  private readonly busyTimeoutMs: number;
  private readonly expectedOwnerUid: number | undefined;
  private readonly getFreeBytes: (path: string) => number;
  private readonly requestsPerMinute: number;
  private readonly testHooks: ManufacturingRunStoreOptions['testHooks'];
  private database: Database.Database | undefined;
  private diagnostics: StartupDiagnostics | undefined;

  constructor(options: ManufacturingRunStoreOptions) {
    this.databasePath = resolve(requireText(options.databasePath, 'database_path'));
    this.usedMarkerPath = `${this.databasePath}.used`;
    this.minimumFreeBytes = options.minimumFreeBytes ?? 64 * 1024 * 1024;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.expectedOwnerUid =
      options.expectedOwnerUid ??
      (typeof process.getuid === 'function' ? process.getuid() : undefined);
    this.getFreeBytes =
      options.getFreeBytes ??
      ((path) => {
        const info = statfsSync(path);
        return Number(info.bavail) * Number(info.bsize);
      });
    this.requestsPerMinute = options.requestsPerMinute ?? COORDINATOR_REQUESTS_PER_MINUTE;
    this.testHooks = options.testHooks;
  }

  initialize(): StartupDiagnostics {
    if (this.database && this.diagnostics) return this.diagnostics;
    const directory = dirname(this.databasePath);
    ensureSecureDirectory(directory, this.expectedOwnerUid);

    const freeBytes = this.getFreeBytes(directory);
    if (!Number.isFinite(freeBytes) || freeBytes < this.minimumFreeBytes) {
      throw new Error(
        `WRITE_GATE_CLOSED: INSUFFICIENT_DISK_SPACE (${freeBytes} < ${this.minimumFreeBytes})`
      );
    }

    const existed = existsSync(this.databasePath);
    if (!existed && existsSync(this.usedMarkerPath)) {
      throw new Error('WRITE_GATE_CLOSED: DATABASE_MISSING_AFTER_USE');
    }
    if (existed) this.verifyDatabaseFileSecurity();

    try {
      this.database = new Database(this.databasePath);
      if (!existed) chmodSync(this.databasePath, 0o600);
      this.configureConnection();
      if (existed) this.verifyIntegrity();
      this.migrate();
      this.verifyIntegrity();
      this.verifySchemaMetadata();
      this.verifySchemaContract();
      this.verifyDataInvariants();
      secureDatabaseFiles(this.databasePath);
      this.writeUsedMarker();
      this.diagnostics = this.readDiagnostics();
      return this.diagnostics;
    } catch (error) {
      this.database?.close();
      this.database = undefined;
      this.diagnostics = undefined;
      if (isSqliteCorruption(error)) {
        throw new Error(
          `WRITE_GATE_CLOSED: DATABASE_CORRUPT: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (
        error instanceof Error &&
        (error.message.includes('WRITE_GATE_CLOSED') ||
          error.message.includes('UNSUPPORTED_SCHEMA') ||
          error.message.includes('SCHEMA_METADATA'))
      ) {
        throw error;
      }
      throw new Error(
        `WRITE_GATE_CLOSED: DATABASE_OPEN_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  close(): void {
    if (!this.database) return;
    try {
      this.database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.database.close();
      this.database = undefined;
      this.diagnostics = undefined;
    }
    secureDatabaseFiles(this.databasePath);
  }

  getStartupDiagnostics(): StartupDiagnostics {
    this.requireDatabase();
    return this.readDiagnostics();
  }

  private configureConnection(): void {
    this.configureDatabaseConnection(this.requireDatabase());
  }

  private configureDatabaseConnection(database: Database.Database): void {
    database.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
  }

  private verifyDatabaseFileSecurity(): void {
    const info = lstatSync(this.databasePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('WRITE_GATE_CLOSED: UNSAFE_DATABASE_FILE');
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error('WRITE_GATE_CLOSED: UNSAFE_DATABASE_MODE');
    }
    if (this.expectedOwnerUid !== undefined && info.uid !== this.expectedOwnerUid) {
      throw new Error('WRITE_GATE_CLOSED: UNSAFE_DATABASE_OWNER');
    }
  }

  private verifyIntegrity(database = this.requireDatabase()): void {
    const rows = database.pragma('integrity_check') as DatabaseRow[];
    if (
      rows.length !== 1 ||
      String(rows[0]?.integrity_check ?? '').toLowerCase() !== 'ok'
    ) {
      throw new Error('WRITE_GATE_CLOSED: DATABASE_CORRUPT: integrity_check failed');
    }
  }

  private migrate(
    database = this.requireDatabase(),
    verifyUsedMarker = true
  ): void {
    const currentVersion = Number(database.pragma('user_version', { simple: true }));
    if (currentVersion > MANUFACTURING_RUN_SCHEMA_VERSION) {
      throw new Error(
        `WRITE_GATE_CLOSED: UNSUPPORTED_SCHEMA: ${currentVersion} > ${MANUFACTURING_RUN_SCHEMA_VERSION}`
      );
    }
    if (currentVersion === 0 && verifyUsedMarker && this.readUsedMarker()) {
      throw new Error('WRITE_GATE_CLOSED: DATABASE_MISSING_AFTER_USE');
    }
    if (currentVersion === MANUFACTURING_RUN_SCHEMA_VERSION) return;
    if (currentVersion === 1) {
      this.verifySchemaMetadata(database, verifyUsedMarker, 1);
    } else if (currentVersion === 2) {
      this.verifySchemaMetadata(database, verifyUsedMarker, 2);
    }
    if (currentVersion === 1 || currentVersion === 2) {
      for (const name of [
        'runs',
        'run_transitions',
        'run_dependencies',
        'schema_metadata',
      ]) {
        const found = database.prepare(`
          SELECT 1
          FROM sqlite_schema
          WHERE type = 'table' AND name = ?
        `).get(name);
        if (!found) {
          throw new Error(
            `WRITE_GATE_CLOSED: SCHEMA_CONTRACT_INVALID: missing ${name}`
          );
        }
      }
    }

    const migrate = database.transaction(() => {
      if (currentVersion === 0) {
        database.exec(SCHEMA_SQL);
        const now = Date.now();
        database.prepare(`
          INSERT INTO schema_metadata (key, value, updated_at_ms)
          VALUES ('schema_version', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
        `).run(String(MANUFACTURING_RUN_SCHEMA_VERSION), now);
        database.prepare(`
          INSERT INTO schema_metadata (key, value, updated_at_ms)
          VALUES ('deployment_epoch', '1', ?)
          ON CONFLICT(key) DO NOTHING
        `).run(now);
        database.prepare(`
          INSERT INTO schema_metadata (key, value, updated_at_ms)
          VALUES ('store_instance_id', ?, ?)
          ON CONFLICT(key) DO NOTHING
        `).run(randomUUID(), now);
        database.pragma(`user_version = ${MANUFACTURING_RUN_SCHEMA_VERSION}`);
        return;
      }
      if (currentVersion === 1) {
        database.prepare(`
          INSERT INTO run_transitions (
            operation_id, from_state, to_state, state_revision, reason, at_ms
          )
          SELECT
            run.operation_id,
            NULL,
            run.state,
            run.state_revision,
            'schema_v2_retention_checkpoint',
            run.updated_at_ms
          FROM runs AS run
          WHERE NOT EXISTS (
            SELECT 1
            FROM run_transitions AS transition
            WHERE transition.operation_id = run.operation_id
          )
        `).run();
      }
      if (currentVersion === 1 || currentVersion === 2) {
        database.exec(`
          ALTER TABLE run_dependencies RENAME TO run_dependencies_v2;
          ${RUN_DEPENDENCIES_SCHEMA_SQL};
          INSERT INTO run_dependencies (
            parent_operation_id, child_operation_id, parent_raw_line_id,
            parent_child_index, created_at_ms, satisfied_at_ms
          )
          SELECT
            parent_operation_id, child_operation_id, parent_raw_line_id,
            0, created_at_ms, satisfied_at_ms
          FROM run_dependencies_v2;
          DROP TABLE run_dependencies_v2;
        `);
        database.exec(SCHEMA_SQL);
        const metadata = database.prepare(`
          UPDATE schema_metadata
          SET value = ?, updated_at_ms = ?
          WHERE key = 'schema_version'
        `).run(String(MANUFACTURING_RUN_SCHEMA_VERSION), Date.now());
        if (metadata.changes !== 1) {
          throw new Error('WRITE_GATE_CLOSED: SCHEMA_METADATA_INVALID');
        }
        database.pragma(`user_version = ${MANUFACTURING_RUN_SCHEMA_VERSION}`);
        return;
      }
      throw new Error(`WRITE_GATE_CLOSED: UNSUPPORTED_SCHEMA: ${currentVersion}`);
    });
    migrate.immediate();
  }

  private verifySchemaMetadata(
    database = this.requireDatabase(),
    verifyUsedMarker = true,
    expectedSchemaVersion = MANUFACTURING_RUN_SCHEMA_VERSION
  ): void {
    const metadata = Object.fromEntries(
      (database.prepare(
        `SELECT key, value FROM schema_metadata
         WHERE key IN ('schema_version', 'deployment_epoch', 'store_instance_id')`
      ).all() as DatabaseRow[]).map((row) => [String(row.key), String(row.value)])
    );
    if (
      Number(metadata.schema_version) !== expectedSchemaVersion ||
      !Number.isSafeInteger(Number(metadata.deployment_epoch)) ||
      Number(metadata.deployment_epoch) < 1 ||
      !metadata.store_instance_id
    ) {
      throw new Error('WRITE_GATE_CLOSED: SCHEMA_METADATA_INVALID');
    }
    const marker = verifyUsedMarker ? this.readUsedMarker() : undefined;
    if (marker && marker.storeInstanceId !== metadata.store_instance_id) {
      throw new Error('WRITE_GATE_CLOSED: DATABASE_REPLACED_AFTER_USE');
    }
  }

  private verifySchemaContract(database = this.requireDatabase()): void {
    for (const [name, expectedDefinition] of REQUIRED_SCHEMA_DEFINITIONS) {
      const row = database.prepare(`
        SELECT type, sql
        FROM sqlite_schema
        WHERE name = ? AND type IN ('table', 'index')
      `).get(name) as DatabaseRow | undefined;
      if (
        !row ||
        typeof row.sql !== 'string' ||
        normalizeSchemaDefinition(row.sql) !== expectedDefinition
      ) {
        throw new Error(
          `WRITE_GATE_CLOSED: SCHEMA_CONTRACT_INVALID: missing or malformed ${name}`
        );
      }
    }
    const foreignKeyViolations = database.pragma('foreign_key_check') as DatabaseRow[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        'WRITE_GATE_CLOSED: SCHEMA_CONTRACT_INVALID: foreign key check failed'
      );
    }
  }

  private verifyDataInvariants(database = this.requireDatabase()): void {
    const verifySnapshot = (): void => {
      const failIfRow = (sql: string, invariant: string): void => {
        if (database.prepare(sql).get() !== undefined) {
          throw new Error(`WRITE_GATE_CLOSED: DATA_INVARIANT_INVALID: ${invariant}`);
        }
      };

      failIfRow(`
        SELECT receipt.run_key_hash
        FROM identity_receipts AS receipt
        JOIN runs AS run ON run.operation_id = receipt.operation_id
        WHERE receipt.run_hash <> run.run_hash
           OR receipt.immutable_intent_hash <> run.immutable_intent_hash
           OR receipt.manufacturing_order_id <> run.manufacturing_order_id
           OR receipt.root_line_id <> run.root_line_id
           OR receipt.canonical_identity_json <> run.canonical_identity_json
        UNION ALL
        SELECT run.operation_id
        FROM runs AS run
        WHERE NOT EXISTS (
          SELECT 1
          FROM identity_receipts AS receipt
          WHERE receipt.run_key_hash = run.idempotency_key_hash
            AND receipt.operation_id = run.operation_id
            AND receipt.run_hash = run.run_hash
            AND receipt.immutable_intent_hash = run.immutable_intent_hash
            AND receipt.manufacturing_order_id = run.manufacturing_order_id
            AND receipt.root_line_id = run.root_line_id
            AND receipt.canonical_identity_json = run.canonical_identity_json
        )
        LIMIT 1
      `, 'identity receipt or immutable run identity drift');

      failIfRow(`
        SELECT queue.operation_id
        FROM work_queue AS queue
        LEFT JOIN runs AS run ON run.operation_id = queue.operation_id
        WHERE run.operation_id IS NULL
           OR run.state NOT IN ('creating', 'ready', 'prepared')
        LIMIT 1
      `, 'queue state is not automatically queueable');

      failIfRow(`
        SELECT run.operation_id
        FROM runs AS run
        LEFT JOIN work_queue AS queue ON queue.operation_id = run.operation_id
        WHERE run.state IN ('creating', 'ready', 'prepared')
          AND queue.operation_id IS NULL
        LIMIT 1
      `, 'queueable run has no queue row');

      failIfRow(`
        SELECT queue.operation_id
        FROM work_queue AS queue
        WHERE (
          (queue.claimed_by IS NULL)
          + (queue.claim_epoch IS NULL)
          + (queue.claimed_at_ms IS NULL)
          + (queue.claim_expires_at_ms IS NULL)
        ) NOT IN (0, 4)
           OR (
             queue.claimed_by IS NOT NULL
             AND (
               queue.claim_epoch <> CAST((
                 SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'
               ) AS INTEGER)
               OR queue.claimed_at_ms < queue.available_at_ms
               OR queue.claim_expires_at_ms <= queue.claimed_at_ms
             )
           )
        LIMIT 1
      `, 'queue claim fields are incoherent');

      failIfRow(`
        SELECT notification_id
        FROM notification_outbox
        WHERE attempt_count < 0
           OR (
             (claim_token IS NULL) + (claimed_by IS NULL) + (claimed_at_ms IS NULL)
           ) NOT IN (0, 3)
           OR (slack_timestamp IS NULL) <> (permalink IS NULL)
           OR (
             status = 'pending'
             AND (
               claim_token IS NOT NULL
               OR claimed_by IS NOT NULL
               OR claimed_at_ms IS NOT NULL
               OR claim_expires_at_ms IS NOT NULL
               OR slack_timestamp IS NOT NULL
               OR permalink IS NOT NULL
             )
           )
           OR (
             status = 'claimed'
             AND (
               claim_token IS NULL
               OR claimed_by IS NULL
               OR claimed_at_ms IS NULL
               OR claim_expires_at_ms IS NULL
               OR claim_expires_at_ms <= claimed_at_ms
               OR attempt_count < 1
               OR slack_timestamp IS NOT NULL
               OR permalink IS NOT NULL
             )
           )
           OR (
             status = 'delivery_unknown'
             AND (
               claim_expires_at_ms IS NOT NULL
               OR slack_timestamp IS NOT NULL
               OR permalink IS NOT NULL
             )
           )
           OR (
             status = 'acknowledged'
             AND (
               claim_expires_at_ms IS NOT NULL
               OR slack_timestamp IS NULL
               OR permalink IS NULL
             )
           )
        LIMIT 1
      `, 'notification claim or delivery fields are incoherent');

      failIfRow(`
        SELECT event_id
        FROM webhook_outbox
        WHERE attempt_count < 0
           OR available_at_ms < created_at_ms
           OR (
             status = 'pending'
             AND (
               claim_token IS NOT NULL
               OR claimed_at_ms IS NOT NULL
               OR claim_expires_at_ms IS NOT NULL
             )
           )
           OR (
             status = 'claimed'
             AND (
               claim_token IS NULL
               OR claimed_at_ms IS NULL
               OR claim_expires_at_ms IS NULL
               OR claim_expires_at_ms <= claimed_at_ms
               OR attempt_count < 1
             )
           )
           OR (
             status IN ('delivered', 'exhausted')
             AND claim_expires_at_ms IS NOT NULL
           )
        LIMIT 1
      `, 'webhook outbox claim or delivery fields are incoherent');

      failIfRow(`
        WITH RECURSIVE closure(operation_id, ancestor_operation_id) AS (
          SELECT child_operation_id, parent_operation_id
          FROM run_dependencies
          UNION
          SELECT closure.operation_id, dependency.parent_operation_id
          FROM closure
          JOIN run_dependencies AS dependency
            ON dependency.child_operation_id = closure.ancestor_operation_id
        )
        SELECT operation_id
        FROM closure
        WHERE operation_id = ancestor_operation_id
        LIMIT 1
      `, 'dependency ancestor closure contains a cycle');

      failIfRow(`
        WITH RECURSIVE closure(operation_id, ancestor_operation_id, depth) AS (
          SELECT child_operation_id, parent_operation_id, 1
          FROM run_dependencies
          UNION ALL
          SELECT
            closure.operation_id,
            dependency.parent_operation_id,
            closure.depth + 1
          FROM closure
          JOIN run_dependencies AS dependency
            ON dependency.child_operation_id = closure.ancestor_operation_id
        ),
        expected AS (
          SELECT operation_id, ancestor_operation_id, MIN(depth) AS depth
          FROM closure
          GROUP BY operation_id, ancestor_operation_id
        ),
        missing AS (
          SELECT operation_id, ancestor_operation_id, depth FROM expected
          EXCEPT
          SELECT operation_id, ancestor_operation_id, depth FROM dependency_ancestors
        ),
        extra AS (
          SELECT operation_id, ancestor_operation_id, depth FROM dependency_ancestors
          EXCEPT
          SELECT operation_id, ancestor_operation_id, depth FROM expected
        )
        SELECT operation_id FROM missing
        UNION ALL
        SELECT operation_id FROM extra
        LIMIT 1
      `, 'dependency ancestor closure is stale or mismatched');

      failIfRow(`
        SELECT parent_operation_id
        FROM run_dependencies
        WHERE satisfied_at_ms IS NOT NULL
          AND satisfied_at_ms < created_at_ms
        LIMIT 1
      `, 'dependency satisfaction predates registration');

      failIfRow(`
        SELECT restore_epoch
        FROM restore_history
        WHERE restore_epoch < 2
           OR restore_epoch > CAST((
             SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'
           ) AS INTEGER)
           OR source_backup_path = ''
           OR reason = ''
           OR quarantined_count < 0
        LIMIT 1
      `, 'restore history and deployment epoch are incoherent');

      failIfRow(`
        SELECT run.operation_id
        FROM runs AS run
        LEFT JOIN restore_history AS history
          ON history.restore_epoch = run.restore_epoch
        WHERE run.restore_epoch IS NOT NULL
          AND history.restore_epoch IS NULL
        UNION ALL
        SELECT CAST(history.restore_epoch AS TEXT)
        FROM restore_history AS history
        LEFT JOIN runs AS run
          ON run.restore_epoch = history.restore_epoch
        GROUP BY history.restore_epoch, history.quarantined_count
        HAVING COUNT(run.operation_id) <> history.quarantined_count
        LIMIT 1
      `, 'run restore epoch is missing or restore history count is inconsistent');

      failIfRow(`
        SELECT operation_id
        FROM runs
        WHERE deployment_epoch < 1
           OR deployment_epoch > CAST((
             SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'
           ) AS INTEGER)
           OR (
             restore_epoch IS NOT NULL
             AND (
               restore_epoch < 2
               OR restore_epoch > CAST((
                 SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'
               ) AS INTEGER)
             )
           )
        UNION ALL
        SELECT worker_id
        FROM worker_lease
        WHERE epoch <> CAST((
          SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'
        ) AS INTEGER)
           OR expires_at_ms <= acquired_at_ms
        LIMIT 1
      `, 'run or worker epoch is incoherent');

      failIfRow(`
        SELECT operation_id
        FROM runs
        WHERE state_revision < 0
           OR updated_at_ms < created_at_ms
        UNION ALL
        SELECT operation_id
        FROM run_transitions
        WHERE state_revision < 0
           OR reason = ''
           OR to_state NOT IN (${RUN_STATE_SQL_LIST})
           OR (
             from_state IS NOT NULL
             AND from_state NOT IN (${RUN_STATE_SQL_LIST})
           )
           OR (
             reason = 'schema_v2_retention_checkpoint'
             AND (
               from_state IS NOT NULL
               OR (state_revision = 0 AND to_state <> 'creating')
             )
           )
           OR (
             reason <> 'schema_v2_retention_checkpoint'
             AND (
               (
                 state_revision = 0
                 AND (from_state IS NOT NULL OR to_state <> 'creating')
               )
               OR (state_revision > 0 AND from_state IS NULL)
             )
           )
        LIMIT 1
      `, 'transition state or revision is invalid');

      const transitionEdges = database.prepare(`
        SELECT operation_id, from_state, to_state
        FROM run_transitions
        WHERE from_state IS NOT NULL
      `).all() as DatabaseRow[];
      for (const edge of transitionEdges) {
        const fromState = String(edge.from_state) as ManufacturingRunState;
        const toState = String(edge.to_state) as ManufacturingRunState;
        if (!ALLOWED_TRANSITIONS[fromState]?.has(toState)) {
          throw new Error(
            'WRITE_GATE_CLOSED: DATA_INVARIANT_INVALID: transition edge is illegal'
          );
        }
      }

      failIfRow(`
        SELECT operation_id
        FROM run_transitions
        GROUP BY operation_id, state_revision
        HAVING COUNT(*) <> 1
        LIMIT 1
      `, 'transition revision is duplicated');

      failIfRow(`
        WITH ordered AS (
          SELECT
            operation_id,
            state_revision,
            from_state,
            at_ms,
            LAG(state_revision) OVER (
              PARTITION BY operation_id ORDER BY state_revision
            ) AS previous_revision,
            LAG(to_state) OVER (
              PARTITION BY operation_id ORDER BY state_revision
            ) AS previous_state,
            LAG(at_ms) OVER (
              PARTITION BY operation_id ORDER BY state_revision
            ) AS previous_at_ms
          FROM run_transitions
        )
        SELECT operation_id
        FROM ordered
        WHERE previous_revision IS NOT NULL
          AND (
            state_revision <> previous_revision + 1
            OR from_state <> previous_state
            OR at_ms < previous_at_ms
          )
        LIMIT 1
      `, 'transition sequence is discontinuous');

      failIfRow(`
        WITH latest AS (
          SELECT
            operation_id,
            to_state,
            state_revision,
            at_ms,
            ROW_NUMBER() OVER (
              PARTITION BY operation_id
              ORDER BY state_revision DESC, transition_id DESC
            ) AS position
          FROM run_transitions
        )
        SELECT run.operation_id
        FROM runs AS run
        LEFT JOIN latest
          ON latest.operation_id = run.operation_id
         AND latest.position = 1
        WHERE latest.operation_id IS NULL
           OR latest.state_revision <> run.state_revision
           OR latest.to_state <> run.state
           OR latest.at_ms <> run.updated_at_ms
        LIMIT 1
      `, 'transition history does not match current run revision');
    };

    if (database.inTransaction) {
      verifySnapshot();
      return;
    }
    database.transaction(verifySnapshot).deferred();
  }

  private writeUsedMarker(): void {
    if (existsSync(this.usedMarkerPath)) {
      this.readUsedMarker();
      chmodSync(this.usedMarkerPath, 0o600);
      return;
    }
    const metadata = this.requireDatabase().prepare(
      `SELECT value FROM schema_metadata WHERE key = 'store_instance_id'`
    ).get() as DatabaseRow | undefined;
    const storeInstanceId = String(metadata?.value ?? '');
    if (!storeInstanceId) throw new Error('WRITE_GATE_CLOSED: SCHEMA_METADATA_INVALID');
    const descriptor = openSync(this.usedMarkerPath, 'wx', 0o600);
    try {
      const marker = Buffer.from(
        `${JSON.stringify({
          schema: 'manufacturing-run-store-used/v1',
          databasePath: this.databasePath,
          storeInstanceId,
        })}\n`,
        'utf8'
      );
      let offset = 0;
      while (offset < marker.length) {
        const written = writeSync(
          descriptor,
          marker,
          offset,
          marker.length - offset
        );
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(this.usedMarkerPath, 0o600);
    fsyncPath(dirname(this.usedMarkerPath));
  }

  private readUsedMarker(): { storeInstanceId: string } | undefined {
    if (!existsSync(this.usedMarkerPath)) return undefined;
    const info = lstatSync(this.usedMarkerPath);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error('WRITE_GATE_CLOSED: UNSAFE_USED_MARKER');
    }
    if (this.expectedOwnerUid !== undefined && info.uid !== this.expectedOwnerUid) {
      throw new Error('WRITE_GATE_CLOSED: UNSAFE_USED_MARKER_OWNER');
    }
    let parsed: {
      schema?: unknown;
      databasePath?: unknown;
      storeInstanceId?: unknown;
    };
    try {
      parsed = JSON.parse(readFileSync(this.usedMarkerPath, 'utf8')) as typeof parsed;
    } catch {
      throw new Error('WRITE_GATE_CLOSED: INVALID_USED_MARKER');
    }
    if (
      parsed.schema !== 'manufacturing-run-store-used/v1' ||
      parsed.databasePath !== this.databasePath ||
      typeof parsed.storeInstanceId !== 'string' ||
      !parsed.storeInstanceId
    ) {
      throw new Error('WRITE_GATE_CLOSED: INVALID_USED_MARKER');
    }
    return { storeInstanceId: parsed.storeInstanceId };
  }

  private readDiagnostics(): StartupDiagnostics {
    const database = this.requireDatabase();
    return {
      writeGateOpen: true,
      journalMode: String(database.pragma('journal_mode', { simple: true })).toLowerCase(),
      synchronous: Number(database.pragma('synchronous', { simple: true })),
      foreignKeys: Number(database.pragma('foreign_keys', { simple: true })),
      busyTimeoutMs: Number(database.pragma('busy_timeout', { simple: true })),
      userVersion: Number(database.pragma('user_version', { simple: true })),
      deploymentEpoch: this.getDeploymentEpoch(),
    };
  }

  private requireDatabase(): Database.Database {
    if (!this.database) throw new Error('WRITE_GATE_CLOSED: STORE_NOT_INITIALIZED');
    return this.database;
  }

  getDeploymentEpoch(): number {
    return this.getDeploymentEpochFrom(this.requireDatabase());
  }

  private getDeploymentEpochFrom(database: Database.Database): number {
    const row = database.prepare(
      `SELECT value FROM schema_metadata WHERE key = 'deployment_epoch'`
    ).get() as DatabaseRow | undefined;
    if (!row) throw new Error('WRITE_GATE_CLOSED: SCHEMA_METADATA_INVALID');
    return Number(row.value);
  }

  private getStoreInstanceIdFrom(database: Database.Database): string {
    const row = database.prepare(
      `SELECT value FROM schema_metadata WHERE key = 'store_instance_id'`
    ).get() as DatabaseRow | undefined;
    const storeInstanceId = String(row?.value ?? '');
    if (!storeInstanceId) {
      throw new Error('WRITE_GATE_CLOSED: SCHEMA_METADATA_INVALID');
    }
    return storeInstanceId;
  }

  createRun(
    input: ManufacturingRunCreateInput
  ): { created: boolean; run: ManufacturingRunRecord } {
    const database = this.requireDatabase();
    const operationId = requireText(input.operationId, 'operation_id');
    const idempotencyKeyHash = requireText(input.idempotencyKeyHash, 'idempotency_key_hash');
    const runHash = requireText(input.runHash, 'run_hash');
    const immutableIntentHash = requireText(
      input.immutableIntentHash,
      'immutable_intent_hash'
    );
    const manufacturingOrderId = requireText(
      input.manufacturingOrderId,
      'manufacturing_order_id'
    );
    const rootLineId = requireText(input.rootLineId, 'root_line_id');
    const coordinatorMarker = requireText(input.coordinatorMarker, 'coordinator_marker');
    const canonicalIdentityJson = stableStringify(input.canonicalIdentity);
    const createdAt = toMilliseconds(input.createdAt);

    const transaction = database.transaction(() => {
      const receipt = database.prepare(
        `SELECT * FROM identity_receipts WHERE run_key_hash = ?`
      ).get(idempotencyKeyHash) as DatabaseRow | undefined;
      if (receipt) {
        if (String(receipt.immutable_intent_hash) !== immutableIntentHash) {
          throw new Error(
            'IDEMPOTENCY_KEY_CONFLICT: key already binds a different immutable intent'
          );
        }
        const run = this.getRun(String(receipt.operation_id));
        if (!run) throw new Error('WRITE_GATE_CLOSED: IDENTITY_RECEIPT_ORPHANED');
        if (QUEUEABLE_STATES.has(run.state)) {
          this.ensureQueueRow(database, run.operationId, createdAt);
        }
        return { created: false, run };
      }

      const existingRun = database.prepare(
        `SELECT * FROM runs WHERE run_hash = ?`
      ).get(runHash) as DatabaseRow | undefined;
      if (existingRun) {
        if (
          String(existingRun.immutable_intent_hash) !== immutableIntentHash ||
          String(existingRun.manufacturing_order_id) !== manufacturingOrderId ||
          String(existingRun.root_line_id) !== rootLineId ||
          String(existingRun.canonical_identity_json) !== canonicalIdentityJson
        ) {
          throw new Error('RUN_IDENTITY_CONFLICT: canonical identity drift');
        }
        database.prepare(`
          INSERT INTO identity_receipts (
            run_key_hash, run_hash, operation_id, immutable_intent_hash,
            manufacturing_order_id, root_line_id, canonical_identity_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          idempotencyKeyHash,
          runHash,
          existingRun.operation_id,
          immutableIntentHash,
          manufacturingOrderId,
          rootLineId,
          canonicalIdentityJson,
          createdAt
        );
        const run = asRun(existingRun);
        if (QUEUEABLE_STATES.has(run.state)) {
          this.ensureQueueRow(database, run.operationId, createdAt);
        }
        return { created: false, run };
      }

      const epoch = this.getDeploymentEpoch();
      database.prepare(`
        INSERT INTO runs (
          operation_id, idempotency_key_hash, run_hash, canonical_identity_json,
          immutable_intent_hash, manufacturing_order_id, root_line_id,
          coordinator_marker, parent_operation_id, parent_raw_line_id, state,
          state_revision, created_at_ms, updated_at_ms, deployment_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', 0, ?, ?, ?)
      `).run(
        operationId,
        idempotencyKeyHash,
        runHash,
        canonicalIdentityJson,
        immutableIntentHash,
        manufacturingOrderId,
        rootLineId,
        coordinatorMarker,
        input.parentOperationId ?? null,
        input.parentRawLineId ?? null,
        createdAt,
        createdAt,
        epoch
      );
      database.prepare(`
        INSERT INTO identity_receipts (
          run_key_hash, run_hash, operation_id, immutable_intent_hash,
          manufacturing_order_id, root_line_id, canonical_identity_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idempotencyKeyHash,
        runHash,
        operationId,
        immutableIntentHash,
        manufacturingOrderId,
        rootLineId,
        canonicalIdentityJson,
        createdAt
      );
      database.prepare(`
        INSERT INTO run_transitions (
          operation_id, from_state, to_state, state_revision, reason, at_ms
        ) VALUES (?, NULL, 'creating', 0, 'created', ?)
      `).run(operationId, createdAt);
      database.prepare(`
        INSERT INTO run_events (operation_id, event_type, detail_json, at_ms)
        VALUES (?, 'run_created', '{}', ?)
      `).run(operationId, createdAt);
      this.ensureQueueRow(database, operationId, createdAt);
      return { created: true, run: this.getRun(operationId)! };
    });

    try {
      return transaction.immediate();
    } catch (error) {
      if (sqliteErrorCode(error) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`RUN_IDENTITY_CONFLICT: ${String(error)}`);
      }
      throw error;
    }
  }

  beginQueuedRun(input: {
    run: ManufacturingRunCreateInput;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
  }): { created: boolean; run: ManufacturingRunRecord } {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const result = this.createRun(input.run);
      if (result.created) {
        this.bindRunArtifact({
          operationId: result.run.operationId,
          ...input.artifact,
        });
      }
      if (result.run.state === 'creating') {
        this.ensureQueueRow(
          database,
          result.run.operationId,
          toMilliseconds(input.artifact.at, toMilliseconds(input.run.createdAt))
        );
      }
      return {
        created: result.created,
        run: this.requireRun(result.run.operationId),
      };
    });
    return transaction.immediate();
  }

  beginDependentQueuedRun(input: {
    parentOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    expectedParentStateRevision: number;
    expectedParentProductId: string;
    run: ManufacturingRunCreateInput;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
  }): {
    created: boolean;
    run: ManufacturingRunRecord;
    dependency: ManufacturingRunDependencyRecord;
  } {
    const database = this.requireDatabase();
    const parentOperationId = requireText(
      input.parentOperationId,
      'parent_operation_id'
    );
    const parentRawLineId = requireText(
      input.parentRawLineId,
      'parent_raw_line_id'
    );
    const expectedParentProductId = requireText(
      input.expectedParentProductId,
      'expected_parent_product_id'
    );
    const parentChildIndex = input.parentChildIndex ?? 0;
    if (!Number.isSafeInteger(parentChildIndex) || parentChildIndex < 0) {
      throw new Error('INVALID_PARENT_CHILD_INDEX');
    }
    if (
      !Number.isSafeInteger(input.expectedParentStateRevision) ||
      input.expectedParentStateRevision < 0
    ) {
      throw new Error('INVALID_PARENT_STATE_REVISION');
    }
    const transaction = database.transaction(() => {
      const parent = this.requireRun(parentOperationId);
      if (!['collecting', 'waiting_dependencies'].includes(parent.state)) {
        throw new Error(`RUN_NOT_COLLECTING_DEPENDENCIES: ${parent.state}`);
      }
      if (parent.stateRevision !== input.expectedParentStateRevision) {
        throw new Error(
          `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedParentStateRevision}, got ${parent.stateRevision}`
        );
      }
      const identity = input.run.canonicalIdentity as {
        finishedProductId?: unknown;
        parentRunHash?: unknown;
        parentRawLineId?: unknown;
      };
      if (
        input.run.parentOperationId !== parentOperationId ||
        input.run.parentRawLineId !== parentRawLineId ||
        String(identity.finishedProductId ?? '') !== expectedParentProductId ||
        String(identity.parentRunHash ?? '') !== parent.runHash ||
        String(identity.parentRawLineId ?? '') !== parentRawLineId
      ) {
        throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
      }
      const existingDependency = database.prepare(`
        SELECT child_operation_id
        FROM run_dependencies
        WHERE parent_operation_id = ?
          AND parent_raw_line_id = ?
          AND parent_child_index = ?
      `).get(
        parentOperationId,
        parentRawLineId,
        parentChildIndex
      ) as DatabaseRow | undefined;
      if (
        existingDependency &&
        String(existingDependency.child_operation_id) !== input.run.operationId
      ) {
        throw new Error(
          'MANUFACTURING_DEPENDENCY_CONFLICT: raw line already binds a different child'
        );
      }
      const componentIntent = database.prepare(`
        SELECT 1 AS found
        FROM component_intents
        WHERE operation_id = ? AND raw_line_id = ?
        LIMIT 1
      `).get(parentOperationId, parentRawLineId) as DatabaseRow | undefined;
      if (componentIntent) {
        throw new Error(
          'PARENT_COMPONENT_DISPOSITION_CONFLICT: raw line is already registered'
        );
      }
      const componentBlock = database.prepare(`
        SELECT 1 AS found
        FROM run_events AS component_block
        WHERE component_block.operation_id = ?
          AND component_block.event_type IN (?, ?)
          AND component_block.event_id > COALESCE((
            SELECT MAX(transition.event_id)
            FROM run_events AS transition
            WHERE transition.operation_id = component_block.operation_id
              AND transition.event_type = 'state_transition'
          ), 0)
        LIMIT 1
      `).get(
        parentOperationId,
        `artifact:component_block:${parentRawLineId}`,
        `artifact:component_block:${parentRawLineId}:revision:${parent.stateRevision}`
      ) as DatabaseRow | undefined;
      if (componentBlock) {
        throw new Error(
          'PARENT_COMPONENT_DISPOSITION_CONFLICT: raw line is already blocked'
        );
      }

      const child = this.beginQueuedRun({
        run: input.run,
        artifact: input.artifact,
      });
      if (child.run.operationId !== input.run.operationId) {
        throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
      }
      this.testHooks?.afterDependentRunBegun?.();
      this.addDependency({
        parentOperationId,
        childOperationId: child.run.operationId,
        parentRawLineId,
        parentChildIndex,
        createdAt: input.artifact.at ?? input.run.createdAt,
      });
      const currentParent = this.requireRun(parentOperationId);
      if (currentParent.state === 'collecting') {
        this.transitionRun({
          operationId: parentOperationId,
          expectedRevision: currentParent.stateRevision,
          toState: 'waiting_dependencies',
          reason: 'recursive child dependency registered',
          at: input.artifact.at ?? input.run.createdAt,
        });
      }
      const dependency = this.listDependencies(parentOperationId).find(
        (candidate) =>
          candidate.parentRawLineId === parentRawLineId &&
          candidate.parentChildIndex === parentChildIndex
      );
      if (!dependency || dependency.childOperationId !== child.run.operationId) {
        throw new Error('DEPENDENCY_BIND_FAILED');
      }
      return {
        created: child.created,
        run: this.requireRun(child.run.operationId),
        dependency,
      };
    });
    return transaction.immediate();
  }

  getRun(operationId: string): ManufacturingRunRecord | undefined {
    const row = this.requireDatabase().prepare(
      `SELECT * FROM runs WHERE operation_id = ?`
    ).get(operationId) as DatabaseRow | undefined;
    return row ? asRun(row) : undefined;
  }

  getRunByHash(runHash: string): ManufacturingRunRecord | undefined {
    const row = this.requireDatabase().prepare(
      `SELECT * FROM runs WHERE run_hash = ?`
    ).get(runHash) as DatabaseRow | undefined;
    return row ? asRun(row) : undefined;
  }

  listDependencyRunsForReconciliation(limit = 100): ManufacturingRunRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('INVALID_DEPENDENCY_RECONCILIATION_LIMIT');
    }
    const rows = this.requireDatabase().prepare(`
      SELECT DISTINCT child.*
      FROM runs AS child
      JOIN run_dependencies AS dependency
        ON dependency.child_operation_id = child.operation_id
      JOIN runs AS parent
        ON parent.operation_id = dependency.parent_operation_id
      LEFT JOIN component_intents AS intent
        ON intent.operation_id = dependency.parent_operation_id
       AND intent.raw_line_id = dependency.parent_raw_line_id
      WHERE (
        child.state IN (
          'resolved_manual', 'failed_no_write', 'conflict', 'blocked',
          'restore_quarantine', 'abandoned'
        )
        AND EXISTS (
          SELECT 1
          FROM dependency_ancestors AS ancestor_link
          JOIN runs AS ancestor
            ON ancestor.operation_id = ancestor_link.ancestor_operation_id
          WHERE ancestor_link.operation_id = child.operation_id
            AND ancestor.state NOT IN (
              'applied_verified', 'staged_awaiting_operations',
              'resolved_manual', 'failed_no_write', 'conflict', 'blocked',
              'restore_quarantine', 'abandoned'
            )
        )
      ) OR (
        child.state = 'applied_verified'
        AND parent.state IN ('collecting', 'waiting_dependencies')
        AND (
          dependency.satisfied_at_ms IS NULL
          OR intent.operation_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM run_events AS evidence
            WHERE evidence.operation_id = child.operation_id
              AND evidence.event_type = 'artifact:parent_verified_put'
          )
        )
      )
      ORDER BY child.updated_at_ms, child.operation_id
      LIMIT ?
    `).all(limit) as DatabaseRow[];
    return rows.map(asRun);
  }

  listComponentCollectionRunsForReconciliation(): ManufacturingRunRecord[] {
    return (this.requireDatabase().prepare(`
      SELECT *
      FROM runs
      WHERE state IN ('collecting', 'waiting_dependencies')
        AND (
          EXISTS (
            SELECT 1
            FROM component_intents
            WHERE component_intents.operation_id = runs.operation_id
          )
          OR EXISTS (
            SELECT 1
            FROM run_dependencies
            WHERE run_dependencies.parent_operation_id = runs.operation_id
          )
        )
      ORDER BY updated_at_ms, operation_id
    `).all() as DatabaseRow[]).map(asRun);
  }

  getIdentityReceipt(runKeyHash: unknown): Record<string, unknown> | undefined {
    const row = this.requireDatabase().prepare(
      `SELECT * FROM identity_receipts WHERE run_key_hash = ?`
    ).get(String(runKeyHash)) as DatabaseRow | undefined;
    if (!row) return undefined;
    return {
      runKeyHash: String(row.run_key_hash),
      runHash: String(row.run_hash),
      operationId: String(row.operation_id),
      immutableIntentHash: String(row.immutable_intent_hash),
      manufacturingOrderId: String(row.manufacturing_order_id),
      rootLineId: String(row.root_line_id),
      canonicalIdentity: JSON.parse(String(row.canonical_identity_json)),
      createdAt: toIso(Number(row.created_at_ms)),
    };
  }

  bindPlanHashes(input: {
    operationId: string;
    immutableIntentHash: string;
    completePreWriteHash: string;
    expectedPostStateHash: string;
    preparedRequestHash: string;
  }): ManufacturingRunRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const current = this.requireRun(input.operationId);
      const requested = {
        immutableIntentHash: requireText(
          input.immutableIntentHash,
          'immutable_intent_hash'
        ),
        completePreWriteHash: requireText(
          input.completePreWriteHash,
          'complete_pre_write_hash'
        ),
        expectedPostStateHash: requireText(
          input.expectedPostStateHash,
          'expected_post_state_hash'
        ),
        preparedRequestHash: requireText(
          input.preparedRequestHash,
          'prepared_request_hash'
        ),
      };
      if (
        current.immutableIntentHash !== requested.immutableIntentHash ||
        (current.completePreWriteHash !== null &&
          current.completePreWriteHash !== requested.completePreWriteHash) ||
        (current.expectedPostStateHash !== null &&
          current.expectedPostStateHash !== requested.expectedPostStateHash) ||
        (current.preparedRequestHash !== null &&
          current.preparedRequestHash !== requested.preparedRequestHash)
      ) {
        throw new Error('PLAN_HASH_CONFLICT: immutable prepared plan drift');
      }
      database.prepare(`
        UPDATE runs
        SET complete_pre_write_hash = ?,
            expected_post_state_hash = ?,
            prepared_request_hash = ?
        WHERE operation_id = ?
      `).run(
        requested.completePreWriteHash,
        requested.expectedPostStateHash,
        requested.preparedRequestHash,
        input.operationId
      );
      return this.requireRun(input.operationId);
    });
    return transaction.immediate();
  }

  registerComponentIntent(input: {
    operationId: string;
    rawLineId: string;
    intentHash: string;
    productId: string;
    quantity: string;
    locationId: string;
    sublocation?: string | null;
    serialized: boolean;
    serialNumbers: string[];
    createdAt?: string | Date | number;
  }): { created: boolean; intent: ComponentIntentRecord } {
    const database = this.requireDatabase();
    const operationId = requireText(input.operationId, 'operation_id');
    const rawLineId = requireText(input.rawLineId, 'raw_line_id');
    const intentHash = requireText(input.intentHash, 'intent_hash');
    const productId = requireText(input.productId, 'product_id');
    const quantity = requireText(input.quantity, 'quantity');
    const locationId = requireText(input.locationId, 'location_id');
    const sublocation = input.sublocation ?? null;
    const serialized = input.serialized ? 1 : 0;
    const createdAt = toMilliseconds(input.createdAt);
    const serialNumbersJson = stableStringify(input.serialNumbers);

    const transaction = database.transaction(() => {
      this.requireRun(operationId);
      const existing = database.prepare(`
        SELECT * FROM component_intents
        WHERE operation_id = ? AND raw_line_id = ?
      `).get(operationId, rawLineId) as DatabaseRow | undefined;
      if (existing) {
        if (
          String(existing.intent_hash) !== intentHash ||
          String(existing.product_id) !== productId ||
          String(existing.quantity) !== quantity ||
          String(existing.location_id) !== locationId ||
          (existing.sublocation === null ? null : String(existing.sublocation)) !==
            sublocation ||
          Number(existing.serialized) !== serialized ||
          String(existing.serial_numbers_json) !== serialNumbersJson
        ) {
          throw new Error(
            'COMPONENT_INTENT_CONFLICT: raw-line ID already binds a different intent'
          );
        }
        return { created: false, intent: asIntent(existing) };
      }
      database.prepare(`
        INSERT INTO component_intents (
          operation_id, raw_line_id, intent_hash, product_id, quantity,
          location_id, sublocation, serialized, serial_numbers_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId,
        rawLineId,
        intentHash,
        productId,
        quantity,
        locationId,
        sublocation,
        serialized,
        serialNumbersJson,
        createdAt
      );
      const row = database.prepare(`
        SELECT * FROM component_intents
        WHERE operation_id = ? AND raw_line_id = ?
      `).get(operationId, rawLineId) as DatabaseRow;
      return { created: true, intent: asIntent(row) };
    });
    return transaction.immediate();
  }

  listComponentIntents(operationId: string): ComponentIntentRecord[] {
    return (this.requireDatabase().prepare(`
      SELECT * FROM component_intents
      WHERE operation_id = ?
      ORDER BY raw_line_id
    `).all(operationId) as DatabaseRow[]).map(asIntent);
  }

  bindRunArtifact(
    input: ManufacturingRunArtifactInput
  ): { created: boolean; artifact: ManufacturingRunArtifactRecord } {
    const database = this.requireDatabase();
    const operationId = requireText(input.operationId, 'operation_id');
    const artifactType = requireText(input.artifactType, 'artifact_type');
    const artifactHash = requireText(input.artifactHash, 'artifact_hash');
    const eventType = `artifact:${artifactType}`;
    const detail = stableStringify({
      artifactHash,
      artifact: input.artifact,
    });
    const at = toMilliseconds(input.at);
    const transaction = database.transaction(() => {
      this.requireRun(operationId);
      const existing = database.prepare(`
        SELECT detail_json, at_ms
        FROM run_events
        WHERE operation_id = ? AND event_type = ?
        ORDER BY event_id
        LIMIT 1
      `).get(operationId, eventType) as DatabaseRow | undefined;
      if (existing) {
        if (String(existing.detail_json) !== detail) {
          throw new Error(
            `RUN_ARTIFACT_CONFLICT: ${artifactType} already binds different content`
          );
        }
        return {
          created: false,
          artifact: this.getRunArtifact(operationId, artifactType)!,
        };
      }
      database.prepare(`
        INSERT INTO run_events (operation_id, event_type, detail_json, at_ms)
        VALUES (?, ?, ?, ?)
      `).run(operationId, eventType, detail, at);
      return {
        created: true,
        artifact: this.getRunArtifact(operationId, artifactType)!,
      };
    });
    return transaction.immediate();
  }

  getRunArtifact(
    operationId: string,
    artifactType: string
  ): ManufacturingRunArtifactRecord | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT detail_json, at_ms
      FROM run_events
      WHERE operation_id = ? AND event_type = ?
      ORDER BY event_id
      LIMIT 1
    `).get(
      requireText(operationId, 'operation_id'),
      `artifact:${requireText(artifactType, 'artifact_type')}`
    ) as DatabaseRow | undefined;
    if (!row) return undefined;
    const detail = JSON.parse(String(row.detail_json)) as {
      artifactHash: string;
      artifact: unknown;
    };
    return {
      artifactType,
      artifactHash: detail.artifactHash,
      artifact: detail.artifact,
      at: toIso(Number(row.at_ms))!,
    };
  }

  getLatestRunArtifactByPrefix(
    operationId: string,
    artifactTypePrefix: string
  ): ManufacturingRunArtifactRecord | undefined {
    const prefix = requireText(artifactTypePrefix, 'artifact_type_prefix');
    const row = this.requireDatabase().prepare(`
      SELECT event_type, detail_json, at_ms
      FROM run_events
      WHERE operation_id = ? AND event_type GLOB ?
      ORDER BY event_id DESC
      LIMIT 1
    `).get(
      requireText(operationId, 'operation_id'),
      `artifact:${prefix}*`
    ) as DatabaseRow | undefined;
    if (!row) return undefined;
    const detail = JSON.parse(String(row.detail_json)) as {
      artifactHash: string;
      artifact: unknown;
    };
    return {
      artifactType: String(row.event_type).slice('artifact:'.length),
      artifactHash: detail.artifactHash,
      artifact: detail.artifact,
      at: toIso(Number(row.at_ms))!,
    };
  }

  addDependency(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    createdAt?: string | Date | number;
  }): { created: boolean } {
    const database = this.requireDatabase();
    const parentOperationId = requireText(
      input.parentOperationId,
      'parent_operation_id'
    );
    const childOperationId = requireText(input.childOperationId, 'child_operation_id');
    const parentRawLineId = requireText(input.parentRawLineId, 'parent_raw_line_id');
    const parentChildIndex = input.parentChildIndex ?? 0;
    if (!Number.isSafeInteger(parentChildIndex) || parentChildIndex < 0) {
      throw new Error('INVALID_PARENT_CHILD_INDEX');
    }
    const createdAt = toMilliseconds(input.createdAt);
    const transaction = database.transaction(() => {
      this.requireRun(parentOperationId);
      this.requireRun(childOperationId);
      if (parentOperationId === childOperationId) {
        throw new Error('MANUFACTURING_DEPENDENCY_CYCLE: self dependency');
      }
      const existing = database.prepare(`
        SELECT child_operation_id FROM run_dependencies
        WHERE parent_operation_id = ?
          AND parent_raw_line_id = ?
          AND parent_child_index = ?
      `).get(
        parentOperationId,
        parentRawLineId,
        parentChildIndex
      ) as DatabaseRow | undefined;
      if (existing) {
        if (String(existing.child_operation_id) !== childOperationId) {
          throw new Error(
            'MANUFACTURING_DEPENDENCY_CONFLICT: raw line already binds a different child'
          );
        }
        return { created: false };
      }
      const wouldCycle = database.prepare(`
        WITH RECURSIVE descendants(operation_id) AS (
          SELECT child_operation_id
          FROM run_dependencies
          WHERE parent_operation_id = ?
          UNION
          SELECT dependency.child_operation_id
          FROM run_dependencies AS dependency
          JOIN descendants
            ON dependency.parent_operation_id = descendants.operation_id
        )
        SELECT 1 AS found
        FROM descendants
        WHERE operation_id = ?
        LIMIT 1
      `).get(childOperationId, parentOperationId) as DatabaseRow | undefined;
      if (wouldCycle) {
        throw new Error('MANUFACTURING_DEPENDENCY_CYCLE: ancestor loop');
      }
      database.prepare(`
        INSERT INTO run_dependencies (
          parent_operation_id, child_operation_id, parent_raw_line_id,
          parent_child_index, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        parentOperationId,
        childOperationId,
        parentRawLineId,
        parentChildIndex,
        createdAt
      );
      this.rebuildAncestorClosure();
      return { created: true };
    });
    return transaction.immediate();
  }

  listAncestors(operationId: string): Array<{ operationId: string; depth: number }> {
    return (this.requireDatabase().prepare(`
      SELECT ancestor_operation_id, depth
      FROM dependency_ancestors
      WHERE operation_id = ?
      ORDER BY depth, ancestor_operation_id
    `).all(operationId) as DatabaseRow[]).map((row) => ({
      operationId: String(row.ancestor_operation_id),
      depth: Number(row.depth),
    }));
  }

  listDependencies(parentOperationId: string): ManufacturingRunDependencyRecord[] {
    return (this.requireDatabase().prepare(`
      SELECT *
      FROM run_dependencies
      WHERE parent_operation_id = ?
      ORDER BY parent_raw_line_id, parent_child_index
    `).all(parentOperationId) as DatabaseRow[]).map((row) => ({
      parentOperationId: String(row.parent_operation_id),
      childOperationId: String(row.child_operation_id),
      parentRawLineId: String(row.parent_raw_line_id),
      parentChildIndex: Number(row.parent_child_index),
      createdAt: toIso(Number(row.created_at_ms))!,
      satisfiedAt: toIso(
        row.satisfied_at_ms === null ? null : Number(row.satisfied_at_ms)
      ),
    }));
  }

  satisfyDependency(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    satisfiedAt?: string | Date | number;
  }): { changed: boolean; allSatisfied: boolean } {
    const database = this.requireDatabase();
    const parentOperationId = requireText(
      input.parentOperationId,
      'parent_operation_id'
    );
    const childOperationId = requireText(input.childOperationId, 'child_operation_id');
    const parentRawLineId = requireText(input.parentRawLineId, 'parent_raw_line_id');
    const parentChildIndex = input.parentChildIndex ?? 0;
    if (!Number.isSafeInteger(parentChildIndex) || parentChildIndex < 0) {
      throw new Error('INVALID_PARENT_CHILD_INDEX');
    }
    const satisfiedAt = toMilliseconds(input.satisfiedAt);
    const transaction = database.transaction(() => {
      const existing = database.prepare(`
        SELECT child_operation_id, satisfied_at_ms
        FROM run_dependencies
        WHERE parent_operation_id = ?
          AND parent_raw_line_id = ?
          AND parent_child_index = ?
      `).get(
        parentOperationId,
        parentRawLineId,
        parentChildIndex
      ) as DatabaseRow | undefined;
      if (!existing || String(existing.child_operation_id) !== childOperationId) {
        throw new Error('DEPENDENCY_IDENTITY_MISMATCH');
      }
      const changed = existing.satisfied_at_ms === null;
      if (changed) {
        database.prepare(`
          UPDATE run_dependencies
          SET satisfied_at_ms = ?
          WHERE parent_operation_id = ?
            AND child_operation_id = ?
            AND parent_raw_line_id = ?
            AND parent_child_index = ?
            AND satisfied_at_ms IS NULL
        `).run(
          satisfiedAt,
          parentOperationId,
          childOperationId,
          parentRawLineId,
          parentChildIndex
        );
      }
      const remaining = Number((database.prepare(`
        SELECT COUNT(*) AS count
        FROM run_dependencies
        WHERE parent_operation_id = ? AND satisfied_at_ms IS NULL
      `).get(parentOperationId) as DatabaseRow).count);
      return { changed, allSatisfied: remaining === 0 };
    });
    return transaction.immediate();
  }

  completeDependencyWithArtifact(input: {
    parentOperationId: string;
    childOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
    satisfiedAt?: string | Date | number;
  }): { changed: boolean; allSatisfied: boolean } {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      this.bindRunArtifact({
        operationId: input.childOperationId,
        ...input.artifact,
      });
      this.testHooks?.afterVerifiedChildArtifactBound?.();
      return this.satisfyDependency({
        parentOperationId: input.parentOperationId,
        childOperationId: input.childOperationId,
        parentRawLineId: input.parentRawLineId,
        parentChildIndex: input.parentChildIndex,
        satisfiedAt: input.satisfiedAt ?? input.artifact.at,
      });
    });
    return transaction.immediate();
  }

  transitionAppliedVerifiedChildWithArtifact(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    parentOperationId: string;
    parentRawLineId: string;
    parentChildIndex?: number;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
    at?: string | Date | number;
  }): {
    run: ManufacturingRunRecord;
    changed: boolean;
    allSatisfied: boolean;
  } {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const run = this.transitionRun({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        toState: 'applied_verified',
        reason: input.reason,
        at: input.at,
      });
      this.testHooks?.afterAppliedChildTransitioned?.();
      const dependency = this.completeDependencyWithArtifact({
        parentOperationId: input.parentOperationId,
        childOperationId: input.operationId,
        parentRawLineId: input.parentRawLineId,
        parentChildIndex: input.parentChildIndex,
        artifact: input.artifact,
        satisfiedAt: input.at ?? input.artifact.at,
      });
      return { run, ...dependency };
    });
    return transaction.immediate();
  }

  resolveRunManualWithArtifact(input: {
    operationId: string;
    expectedRevision: number;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const current = this.requireRun(input.operationId);
      const existing = this.getRunArtifact(
        input.operationId,
        input.artifact.artifactType
      );
      if (existing) {
        this.bindRunArtifact({
          operationId: input.operationId,
          ...input.artifact,
        });
        if (current.state === 'resolved_manual') return current;
      }
      if (
        !['staged_awaiting_operations', 'blocked', 'restore_quarantine']
          .includes(current.state)
      ) {
        throw new Error(`RUN_NOT_MANUALLY_RESOLVABLE: ${current.state}`);
      }
      if (current.stateRevision !== input.expectedRevision) {
        throw new Error(
          `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedRevision}, got ${current.stateRevision}`
        );
      }
      this.bindRunArtifact({
        operationId: input.operationId,
        ...input.artifact,
      });
      this.testHooks?.afterManualApprovalArtifactBound?.();
      return this.transitionRun({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        toState: 'resolved_manual',
        reason: input.reason,
        at: input.at ?? input.artifact.at,
      });
    });
    return transaction.immediate();
  }

  private rebuildAncestorClosure(): void {
    const database = this.requireDatabase();
    database.exec(`DELETE FROM dependency_ancestors`);
    database.exec(`
      WITH RECURSIVE closure(operation_id, ancestor_operation_id, depth) AS (
        SELECT child_operation_id, parent_operation_id, 1
        FROM run_dependencies
        UNION ALL
        SELECT
          closure.operation_id,
          dependency.parent_operation_id,
          closure.depth + 1
        FROM closure
        JOIN run_dependencies AS dependency
          ON dependency.child_operation_id = closure.ancestor_operation_id
      )
      INSERT INTO dependency_ancestors (
        operation_id, ancestor_operation_id, depth
      )
      SELECT operation_id, ancestor_operation_id, MIN(depth)
      FROM closure
      GROUP BY operation_id, ancestor_operation_id
    `);
  }

  transitionRun(input: {
    operationId: string;
    expectedRevision: number;
    toState: ManufacturingRunState | string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    return this.transitionRunInternal(input, false, false, false);
  }

  private transitionRunInternal(input: {
    operationId: string;
    expectedRevision: number;
    toState: ManufacturingRunState | string;
    reason: string;
    at?: string | Date | number;
  }, allowAttestedNoWrite: boolean, allowOperationCompletionPreparation: boolean, allowProvenNoWriteRearm: boolean): ManufacturingRunRecord {
    const database = this.requireDatabase();
    if (!RUN_STATE_SET.has(input.toState)) {
      throw new Error(`UNSUPPORTED_RUN_STATE: ${input.toState}`);
    }
    const reason = requireText(input.reason, 'transition_reason');
    if (reason === 'schema_v2_retention_checkpoint') {
      throw new Error('RESERVED_TRANSITION_REASON');
    }
    const toState = input.toState as ManufacturingRunState;
    const at = toMilliseconds(input.at);
    const transaction = database.transaction(() => {
      const current = this.requireRun(input.operationId);
      if (current.stateRevision !== input.expectedRevision) {
        throw new Error(
          `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedRevision}, got ${current.stateRevision}`
        );
      }
      if (at < toMilliseconds(current.updatedAt)) {
        throw new Error(
          `RUN_TRANSITION_TIME_CONFLICT: transition precedes revision ${current.stateRevision}`
        );
      }
      if (TERMINAL_STATES.has(current.state)) {
        throw new Error(`TERMINAL_RUN_IMMUTABLE: ${current.operationId}`);
      }
      if (toState === 'failed_no_write' && !allowAttestedNoWrite) {
        throw new Error('ATTESTED_NO_WRITE_TRANSITION_REQUIRED');
      }
      if (
        toState === 'failed_no_write' &&
        allowAttestedNoWrite &&
        current.state !== 'dispatch_uncertain'
      ) {
        throw new Error('ATTESTED_NO_WRITE_REQUIRES_DISPATCH_UNCERTAIN');
      }
      if (
        current.state === 'dispatch_uncertain' &&
        toState === 'prepared' &&
        !allowOperationCompletionPreparation &&
        !allowProvenNoWriteRearm
      ) {
        throw new Error('OPERATION_COMPLETION_PREPARATION_REQUIRED');
      }
      if (!ALLOWED_TRANSITIONS[current.state].has(toState)) {
        throw new Error(`ILLEGAL_RUN_TRANSITION: ${current.state} -> ${toState}`);
      }
      const nextRevision = current.stateRevision + 1;
      const result = database.prepare(`
        UPDATE runs
        SET state = ?, state_revision = ?, updated_at_ms = ?
        WHERE operation_id = ? AND state_revision = ?
      `).run(toState, nextRevision, at, input.operationId, input.expectedRevision);
      if (result.changes !== 1) {
        throw new Error('RUN_STATE_REVISION_CONFLICT: concurrent transition');
      }
      database.prepare(`
        INSERT INTO run_transitions (
          operation_id, from_state, to_state, state_revision, reason, at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.operationId,
        current.state,
        toState,
        nextRevision,
        reason,
        at
      );
      database.prepare(`
        INSERT INTO run_events (operation_id, event_type, detail_json, at_ms)
        VALUES (?, 'state_transition', ?, ?)
      `).run(
        input.operationId,
        stableStringify({ from: current.state, to: toState, revision: nextRevision }),
        at
      );
      this.enqueueTransitionSignalsInTransaction(database, {
        operationId: input.operationId,
        toState,
        stateRevision: nextRevision,
        at,
      });
      if (QUEUEABLE_STATES.has(toState)) {
        this.ensureQueueRow(database, input.operationId, at);
      } else {
        database.prepare(`DELETE FROM work_queue WHERE operation_id = ?`).run(
          input.operationId
        );
      }
      return this.requireRun(input.operationId);
    });
    return transaction.immediate();
  }

  private enqueueTransitionSignalsInTransaction(
    database: Database.Database,
    input: {
      operationId: string;
      toState: ManufacturingRunState;
      stateRevision: number;
      at: number;
    }
  ): void {
    const kind = input.toState === 'collecting'
      ? 'run_ready'
      : NOTIFICATION_STATES.has(input.toState)
        ? 'terminal'
        : undefined;
    if (!kind) return;
    const eventId =
      `manufacturing-run-wake/v1:${kind}:${input.operationId}:${input.stateRevision}`;
    const operationMarker = kind === 'run_ready'
      ? `${input.operationId}:${input.stateRevision}`
      : `manufacturing-run-notification-ready/v1:${input.operationId}:${input.stateRevision}`;
    const notificationId = kind === 'terminal'
      ? `manufacturing-run-notification/v1:${input.operationId}:${input.stateRevision}`
      : undefined;
    const payload = {
      schemaVersion: kind === 'run_ready'
        ? 'manufacturing-run/v1'
        : 'manufacturing-run-notification/v1',
      marker: kind === 'run_ready'
        ? operationMarker
        : 'manufacturing-run-notification-ready/v1',
      operationId: input.operationId,
      state: input.toState,
      stateRevision: input.stateRevision,
      ...(notificationId ? { notificationId } : {}),
    };
    database.prepare(`
      INSERT INTO webhook_outbox (
        event_id, operation_id, kind, operation_marker, payload_json, status,
        available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      eventId,
      input.operationId,
      kind,
      operationMarker,
      stableStringify(payload),
      input.at,
      input.at,
      input.at
    );
    if (!notificationId) return;
    database.prepare(`
      INSERT INTO notification_outbox (
        notification_id, operation_id, kind, operation_marker, payload_json,
        status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'terminal', ?, ?, 'pending', ?, ?)
    `).run(
      notificationId,
      input.operationId,
      `manufacturing-run:${input.operationId}:${input.stateRevision}`,
      stableStringify(payload),
      input.at,
      input.at
    );
  }

  markDispatchUncertain(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    return this.transitionRun({ ...input, toState: 'dispatch_uncertain' });
  }

  markOperationCompletionPrepared(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    for (const artifactType of [
      'operation_completion_intent/v1',
      'operation_completion_plan/v1',
    ]) {
      if (!this.getRunArtifact(input.operationId, artifactType)) {
        throw new Error(`RUN_ARTIFACT_MISSING: ${artifactType}`);
      }
    }
    return this.transitionRunInternal(
      { ...input, toState: 'prepared' },
      false,
      true,
      false
    );
  }

  rearmDispatchAfterProvenNoWrite(input: {
    operationId: string;
    expectedRevision: number;
    proofArtifactType: string;
    evidenceHash: string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const current = this.requireRun(input.operationId);
      if (current.stateRevision !== input.expectedRevision) {
        throw new Error(
          `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedRevision}, got ${current.stateRevision}`
        );
      }
      if (current.state !== 'dispatch_uncertain') {
        throw new Error(
          `PROVEN_NO_WRITE_REARM_REQUIRES_DISPATCH_UNCERTAIN: ${current.state}`
        );
      }
      const expectedArtifactType =
        `dispatch_no_write_proof/v1:revision:${input.expectedRevision}`;
      if (input.proofArtifactType !== expectedArtifactType) {
        throw new Error('PROVEN_NO_WRITE_ARTIFACT_REVISION_MISMATCH');
      }
      const proofRecord = this.getRunArtifact(
        input.operationId,
        input.proofArtifactType
      );
      const evidenceHash = requireText(
        input.evidenceHash,
        'no_write_evidence_hash'
      );
      if (!proofRecord || proofRecord.artifactHash !== evidenceHash) {
        throw new Error('PROVEN_NO_WRITE_ARTIFACT_MISSING_OR_MISMATCHED');
      }
      if (
        !proofRecord.artifact ||
        typeof proofRecord.artifact !== 'object' ||
        Array.isArray(proofRecord.artifact)
      ) {
        throw new Error('PROVEN_NO_WRITE_ARTIFACT_INVALID');
      }
      const proof = proofRecord.artifact as Record<string, unknown>;
      const rejectionArtifactType =
        `dispatch_no_write_rejection/v1:revision:${input.expectedRevision}`;
      const rejectionRecord = this.getRunArtifact(
        input.operationId,
        rejectionArtifactType
      );
      const inventoryRecord = this.getRunArtifact(
        input.operationId,
        'component_inventory_expectation/v1'
      );
      const sourceBindingRecord = this.getRunArtifact(
        input.operationId,
        'source_serial_binding/v1'
      );
      const dispatchPlanRecord = this.getRunArtifact(
        input.operationId,
        'dispatch_plan'
      );
      if (
        !rejectionRecord ||
        !inventoryRecord ||
        !sourceBindingRecord ||
        !dispatchPlanRecord ||
        !rejectionRecord.artifact ||
        typeof rejectionRecord.artifact !== 'object' ||
        Array.isArray(rejectionRecord.artifact) ||
        !dispatchPlanRecord.artifact ||
        typeof dispatchPlanRecord.artifact !== 'object' ||
        Array.isArray(dispatchPlanRecord.artifact) ||
        proof.schemaVersion !== 'manufacturing-dispatch-no-write-proof/v1' ||
        proof.domain !== 'manufacturing-pick-batch-v1' ||
        proof.dispatchUncertainRevision !== input.expectedRevision ||
        proof.requestHash !== current.preparedRequestHash ||
        proof.completePreWriteHash !== current.completePreWriteHash ||
        typeof proof.preWriteTimestamp !== 'string' ||
        proof.preWriteTimestamp.length === 0 ||
        proof.componentInventoryExpectationHash !== inventoryRecord.artifactHash ||
        proof.sourceSerialBindingHash !== sourceBindingRecord.artifactHash ||
        proof.rejectionArtifactHash !== rejectionRecord.artifactHash ||
        typeof proof.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(proof.observedAt))
      ) {
        throw new Error('PROVEN_NO_WRITE_ARTIFACT_INVALID');
      }
      const rejection = rejectionRecord.artifact as Record<string, unknown>;
      const expectedRejection = {
        schemaVersion: 'manufacturing-dispatch-no-write-rejection/v1',
        domain: 'manufacturing-pick-batch-v1',
        dispatchUncertainRevision: input.expectedRevision,
        requestHash: current.preparedRequestHash,
        rejection: {
          name: 'InflowApiError',
          statusCode: 400,
          providerCode: 'WorkOrderPartNegativeInventory',
        },
      };
      if (
        stableStringify(rejection) !== stableStringify(expectedRejection) ||
        canonicalHash(
          rejection,
          'manufacturing-run/dispatch-no-write-rejection/v1'
        ) !== rejectionRecord.artifactHash
      ) {
        throw new Error('PROVEN_NO_WRITE_REJECTION_INVALID');
      }
      const dispatchPlan = dispatchPlanRecord.artifact as Record<string, unknown>;
      if (
        dispatchPlan.requestHash !== current.preparedRequestHash ||
        dispatchPlan.completePreWriteHash !== current.completePreWriteHash ||
        dispatchPlan.beginTimestamp !== proof.preWriteTimestamp
      ) {
        throw new Error('PROVEN_NO_WRITE_PLAN_BINDING_INVALID');
      }
      const expectedProof = {
        schemaVersion: 'manufacturing-dispatch-no-write-proof/v1',
        domain: 'manufacturing-pick-batch-v1',
        dispatchUncertainRevision: input.expectedRevision,
        requestHash: current.preparedRequestHash,
        completePreWriteHash: current.completePreWriteHash,
        preWriteTimestamp: proof.preWriteTimestamp,
        componentInventoryExpectationHash: inventoryRecord.artifactHash,
        sourceSerialBindingHash: sourceBindingRecord.artifactHash,
        rejectionArtifactHash: rejectionRecord.artifactHash,
        observedAt: proof.observedAt,
      };
      if (
        stableStringify(proof) !== stableStringify(expectedProof) ||
        canonicalHash(
          proof,
          'manufacturing-run/dispatch-no-write-proof/v1'
        ) !== proofRecord.artifactHash
      ) {
        throw new Error('PROVEN_NO_WRITE_ARTIFACT_INVALID');
      }
      return this.transitionRunInternal({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        toState: 'prepared',
        reason:
          `${requireText(input.reason, 'transition_reason')} [evidence:${evidenceHash}]`,
        at: input.at,
      }, false, false, true);
    });
    return transaction.immediate();
  }

  fenceOperationCompletionDispatch(input: {
    operationId: string;
    expectedRevision: number;
    reason: string;
    artifact: Omit<ManufacturingRunArtifactInput, 'operationId'>;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const current = this.requireRun(input.operationId);
      if (current.stateRevision !== input.expectedRevision) {
        throw new Error(
          `RUN_STATE_REVISION_CONFLICT: expected ${input.expectedRevision}, got ${current.stateRevision}`
        );
      }
      if (current.state !== 'prepared') {
        throw new Error(
          `OPERATION_COMPLETION_DISPATCH_REQUIRES_PREPARED: ${current.state}`
        );
      }
      this.bindRunArtifact({
        operationId: input.operationId,
        ...input.artifact,
      });
      return this.transitionRun({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
        toState: 'dispatch_uncertain',
        reason: input.reason,
        at: input.at,
      });
    });
    return transaction.immediate();
  }

  markFailedNoWriteAttested(input: {
    operationId: string;
    expectedRevision: number;
    attestationDomain:
      | 'manufacturing-pick-batch-v1'
      | 'manufacturing-operation-completion-v1';
    evidenceHash: string;
    reason: string;
    at?: string | Date | number;
  }): ManufacturingRunRecord {
    if (
      input.attestationDomain !== 'manufacturing-pick-batch-v1' &&
      input.attestationDomain !== 'manufacturing-operation-completion-v1'
    ) {
      throw new Error('INVALID_NO_WRITE_ATTESTATION_DOMAIN');
    }
    const evidenceHash = requireText(input.evidenceHash, 'no_write_evidence_hash');
    return this.transitionRunInternal({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      toState: 'failed_no_write',
      reason: `${requireText(input.reason, 'transition_reason')} [evidence:${evidenceHash}]`,
      at: input.at,
    }, true, false, false);
  }

  listTransitions(operationId: string): Array<Record<string, unknown>> {
    return (this.requireDatabase().prepare(`
      SELECT * FROM run_transitions
      WHERE operation_id = ?
      ORDER BY transition_id
    `).all(operationId) as DatabaseRow[]).map((row) => ({
      fromState: row.from_state === null ? null : String(row.from_state),
      toState: String(row.to_state),
      stateRevision: Number(row.state_revision),
      reason: String(row.reason),
      at: toIso(Number(row.at_ms)),
    }));
  }

  enqueueRun(input: {
    operationId: string;
    enqueuedAt?: string | Date | number;
    availableAt?: string | Date | number;
  }): { operationId: string; queueId: number } {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const run = this.requireRun(input.operationId);
      if (run.state === 'dispatch_uncertain') {
        throw new Error('DISPATCH_UNCERTAIN_NOT_REQUEUEABLE');
      }
      if (!QUEUEABLE_STATES.has(run.state)) {
        throw new Error(`RUN_NOT_QUEUEABLE: ${run.state}`);
      }
      const existing = database.prepare(
        `SELECT queue_id FROM work_queue WHERE operation_id = ?`
      ).get(input.operationId) as DatabaseRow | undefined;
      if (existing) {
        return { operationId: input.operationId, queueId: Number(existing.queue_id) };
      }
      const enqueuedAt = toMilliseconds(input.enqueuedAt);
      const availableAt = toMilliseconds(input.availableAt, enqueuedAt);
      return {
        operationId: input.operationId,
        queueId: this.ensureQueueRow(
          database,
          input.operationId,
          enqueuedAt,
          availableAt
        ),
      };
    });
    return transaction.immediate();
  }

  private ensureQueueRow(
    database: Database.Database,
    operationId: string,
    enqueuedAt: number,
    availableAt = enqueuedAt
  ): number {
    database.prepare(`
      INSERT INTO work_queue (
        operation_id, enqueued_at_ms, available_at_ms
      ) VALUES (?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING
    `).run(operationId, enqueuedAt, availableAt);
    const row = database.prepare(
      `SELECT queue_id FROM work_queue WHERE operation_id = ?`
    ).get(operationId) as DatabaseRow | undefined;
    if (!row) throw new Error('QUEUE_INSERT_FAILED');
    return Number(row.queue_id);
  }

  listQueuedRuns(): Array<Record<string, unknown>> {
    return (this.requireDatabase().prepare(`
      SELECT * FROM work_queue ORDER BY queue_id
    `).all() as DatabaseRow[]).map((row) => ({
      queueId: Number(row.queue_id),
      operationId: String(row.operation_id),
      enqueuedAt: toIso(Number(row.enqueued_at_ms)),
      availableAt: toIso(Number(row.available_at_ms)),
      claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
      claimEpoch: row.claim_epoch === null ? null : Number(row.claim_epoch),
      claimExpiresAt: toIso(
        row.claim_expires_at_ms === null ? null : Number(row.claim_expires_at_ms)
      ),
    }));
  }

  acquireWorkerLease(input: {
    workerId: string;
    leaseMs: number;
    now?: string | Date | number;
  }): { workerId: string; epoch: number; leaseExpiresAt: string } {
    const database = this.requireDatabase();
    const workerId = requireText(input.workerId, 'worker_id');
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('INVALID_WORKER_LEASE');
    }
    const now = toMilliseconds(input.now);
    const transaction = database.transaction(() => {
      const epoch = this.getDeploymentEpoch();
      const current = database.prepare(
        `SELECT * FROM worker_lease WHERE singleton = 1`
      ).get() as DatabaseRow | undefined;
      if (
        current &&
        Number(current.epoch) === epoch &&
        Number(current.expires_at_ms) > now &&
        String(current.worker_id) !== workerId
      ) {
        throw new Error('WORKER_LEASE_HELD');
      }
      const expiresAt = now + input.leaseMs;
      database.prepare(`
        INSERT INTO worker_lease (
          singleton, worker_id, epoch, acquired_at_ms, expires_at_ms
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          worker_id = excluded.worker_id,
          epoch = excluded.epoch,
          acquired_at_ms = excluded.acquired_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(workerId, epoch, now, expiresAt);
      return {
        workerId,
        epoch,
        leaseExpiresAt: toIso(expiresAt)!,
      };
    });
    return transaction.immediate();
  }

  claimNextRun(input: {
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
  }): Record<string, unknown> | undefined {
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const transaction = database.transaction(() => {
      const activeEpoch = this.getDeploymentEpoch();
      if (input.epoch !== activeEpoch) throw new Error('STALE_WORKER_EPOCH');
      const lease = database.prepare(
        `SELECT * FROM worker_lease WHERE singleton = 1`
      ).get() as DatabaseRow | undefined;
      if (
        !lease ||
        String(lease.worker_id) !== input.workerId ||
        Number(lease.epoch) !== activeEpoch ||
        Number(lease.expires_at_ms) <= now
      ) {
        throw new Error('WORKER_LEASE_NOT_HELD');
      }
      const next = database.prepare(`
        SELECT queue.*
        FROM work_queue AS queue
        JOIN runs ON runs.operation_id = queue.operation_id
        WHERE queue.available_at_ms <= ?
          AND (queue.claimed_by IS NULL OR queue.claim_expires_at_ms <= ?)
          AND runs.state IN ('creating', 'ready', 'prepared')
        ORDER BY queue.queue_id
        LIMIT 1
      `).get(now, now) as DatabaseRow | undefined;
      if (!next) return undefined;
      const expiresAt = now + input.leaseMs;
      database.prepare(`
        UPDATE work_queue
        SET claimed_by = ?, claim_epoch = ?, claimed_at_ms = ?, claim_expires_at_ms = ?
        WHERE queue_id = ?
      `).run(input.workerId, activeEpoch, now, expiresAt, next.queue_id);
      return {
        queueId: Number(next.queue_id),
        operationId: String(next.operation_id),
        workerId: input.workerId,
        epoch: activeEpoch,
        claimedAt: toIso(now),
        claimExpiresAt: toIso(expiresAt),
      };
    });
    return transaction.immediate();
  }

  renewWorkerOwnership(input: {
    operationId?: string;
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
  }): { workerId: string; epoch: number; leaseExpiresAt: string } {
    const database = this.requireDatabase();
    const workerId = requireText(input.workerId, 'worker_id');
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error('INVALID_WORKER_LEASE');
    }
    const now = toMilliseconds(input.now);
    const transaction = database.transaction(() => {
      const activeEpoch = this.getDeploymentEpoch();
      if (input.epoch !== activeEpoch) throw new Error('STALE_WORKER_EPOCH');
      const lease = database.prepare(
        `SELECT * FROM worker_lease WHERE singleton = 1`
      ).get() as DatabaseRow | undefined;
      if (
        !lease ||
        String(lease.worker_id) !== workerId ||
        Number(lease.epoch) !== activeEpoch ||
        Number(lease.expires_at_ms) <= now
      ) {
        throw new Error('WORKER_LEASE_NOT_HELD');
      }
      const expiresAt = now + input.leaseMs;
      if (input.operationId !== undefined) {
        const queue = database.prepare(
          `SELECT * FROM work_queue WHERE operation_id = ?`
        ).get(input.operationId) as DatabaseRow | undefined;
        if (
          !queue ||
          String(queue.claimed_by ?? '') !== workerId ||
          Number(queue.claim_epoch) !== activeEpoch ||
          Number(queue.claim_expires_at_ms) <= now
        ) {
          throw new Error('QUEUE_OWNERSHIP_CONFLICT');
        }
        database.prepare(`
          UPDATE work_queue
          SET claim_expires_at_ms = ?
          WHERE operation_id = ? AND claimed_by = ? AND claim_epoch = ?
        `).run(expiresAt, input.operationId, workerId, activeEpoch);
      }
      database.prepare(`
        UPDATE worker_lease
        SET expires_at_ms = ?
        WHERE singleton = 1 AND worker_id = ? AND epoch = ?
      `).run(expiresAt, workerId, activeEpoch);
      return {
        workerId,
        epoch: activeEpoch,
        leaseExpiresAt: toIso(expiresAt)!,
      };
    });
    return transaction.immediate();
  }

  releaseQueueClaim(input: {
    operationId: string;
    workerId: string;
    epoch: number;
    leaseMs: number;
    now?: string | Date | number;
    availableAt?: string | Date | number;
  }): void {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      this.renewWorkerOwnership(input);
      const now = toMilliseconds(input.now);
      const availableAt = input.availableAt === undefined
        ? null
        : toMilliseconds(input.availableAt);
      if (availableAt !== null && availableAt < now) {
        throw new Error('INVALID_QUEUE_AVAILABLE_AT');
      }
      const result = database.prepare(`
        UPDATE work_queue
        SET available_at_ms = COALESCE(?, available_at_ms),
            claimed_by = NULL,
            claim_epoch = NULL,
            claimed_at_ms = NULL,
            claim_expires_at_ms = NULL
        WHERE operation_id = ? AND claimed_by = ? AND claim_epoch = ?
      `).run(availableAt, input.operationId, input.workerId, input.epoch);
      if (result.changes !== 1) throw new Error('QUEUE_OWNERSHIP_CONFLICT');
    });
    transaction.immediate();
  }

  completeQueueItem(input: {
    operationId: string;
    workerId: string;
    epoch: number;
  }): void {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      if (input.epoch !== this.getDeploymentEpoch()) throw new Error('STALE_WORKER_EPOCH');
      const result = database.prepare(`
        DELETE FROM work_queue
        WHERE operation_id = ? AND claimed_by = ? AND claim_epoch = ?
      `).run(input.operationId, input.workerId, input.epoch);
      if (result.changes !== 1) throw new Error('QUEUE_OWNERSHIP_CONFLICT');
    });
    transaction.immediate();
  }

  consumeRateBudget(input: {
    now?: string | Date | number;
    count?: number;
  }): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('INVALID_RATE_COUNT');
    const transaction = database.transaction(() => {
      const cutoff = now - COORDINATOR_RATE_WINDOW_MS;
      database.prepare(`DELETE FROM rate_ledger WHERE requested_at_ms <= ?`).run(cutoff);
      const used = Number(
        (database.prepare(`SELECT COUNT(*) AS count FROM rate_ledger`).get() as DatabaseRow)
          .count
      );
      if (used + count > this.requestsPerMinute) {
        const oldest = database.prepare(`
          SELECT requested_at_ms FROM rate_ledger ORDER BY requested_at_ms LIMIT 1
        `).get() as DatabaseRow | undefined;
        return {
          allowed: false,
          remaining: Math.max(0, this.requestsPerMinute - used),
          retryAfterMs: oldest
            ? Math.max(
                1,
                Number(oldest.requested_at_ms) + COORDINATOR_RATE_WINDOW_MS - now
              )
            : COORDINATOR_RATE_WINDOW_MS,
        };
      }
      const insert = database.prepare(
        `INSERT INTO rate_ledger (requested_at_ms) VALUES (?)`
      );
      for (let index = 0; index < count; index += 1) insert.run(now);
      return {
        allowed: true,
        remaining: this.requestsPerMinute - used - count,
        retryAfterMs: 0,
      };
    });
    return transaction.immediate();
  }

  getRateBudgetStatus(input: {
    now?: string | Date | number;
    count?: number;
  } = {}): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('INVALID_RATE_COUNT');
    const cutoff = now - COORDINATOR_RATE_WINDOW_MS;
    const used = Number(
      (database.prepare(`
        SELECT COUNT(*) AS count
        FROM rate_ledger
        WHERE requested_at_ms > ?
      `).get(cutoff) as DatabaseRow).count
    );
    if (used + count <= this.requestsPerMinute) {
      return {
        allowed: true,
        remaining: this.requestsPerMinute - used,
        retryAfterMs: 0,
      };
    }
    const oldest = database.prepare(`
      SELECT requested_at_ms
      FROM rate_ledger
      WHERE requested_at_ms > ?
      ORDER BY requested_at_ms
      LIMIT 1
    `).get(cutoff) as DatabaseRow | undefined;
    return {
      allowed: false,
      remaining: Math.max(0, this.requestsPerMinute - used),
      retryAfterMs: oldest
        ? Math.max(
            1,
            Number(oldest.requested_at_ms) + COORDINATOR_RATE_WINDOW_MS - now
          )
        : COORDINATOR_RATE_WINDOW_MS,
    };
  }

  claimNonce(input: {
    kid: string;
    nonce: string;
    expiresAt: string | Date | number;
    now?: string | Date | number;
  }): boolean {
    const database = this.requireDatabase();
    const kid = requireText(input.kid, 'kid');
    const nonce = requireText(input.nonce, 'nonce');
    const now = toMilliseconds(input.now);
    const expiresAt = toMilliseconds(input.expiresAt);
    if (expiresAt <= now) throw new Error('NONCE_EXPIRED');
    const transaction = database.transaction(() => {
      database.prepare(`DELETE FROM hmac_nonces WHERE expires_at_ms <= ?`).run(now);
      const existing = database.prepare(
        `SELECT nonce FROM hmac_nonces WHERE nonce = ?`
      ).get(nonce);
      if (existing) return false;
      try {
        database.prepare(`
          INSERT INTO hmac_nonces (kid, nonce, claimed_at_ms, expires_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(kid, nonce, now, expiresAt);
        return true;
      } catch (error) {
        if (sqliteErrorCode(error)?.startsWith('SQLITE_CONSTRAINT')) return false;
        throw error;
      }
    });
    return transaction.immediate();
  }

  recordEvent(input: {
    operationId: string;
    eventType: string;
    detail: unknown;
    at?: string | Date | number;
  }): void {
    this.requireRun(input.operationId);
    this.requireDatabase().prepare(`
      INSERT INTO run_events (operation_id, event_type, detail_json, at_ms)
      VALUES (?, ?, ?, ?)
    `).run(
      input.operationId,
      requireText(input.eventType, 'event_type'),
      stableStringify(input.detail),
      toMilliseconds(input.at)
    );
  }

  listEvents(operationId: string): Array<Record<string, unknown>> {
    return (this.requireDatabase().prepare(`
      SELECT * FROM run_events WHERE operation_id = ? ORDER BY event_id
    `).all(operationId) as DatabaseRow[]).map((row) => ({
      eventType: String(row.event_type),
      detail: JSON.parse(String(row.detail_json)),
      at: toIso(Number(row.at_ms)),
    }));
  }

  pruneDetailedEvents(input: {
    now?: string | Date | number;
    retentionDays?: number;
  } = {}): { deletedEvents: number; deletedTransitions: number } {
    const database = this.requireDatabase();
    const retentionDays = input.retentionDays ?? MANUFACTURING_EVENT_RETENTION_DAYS;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new Error('INVALID_RETENTION_DAYS');
    }
    const cutoff = toMilliseconds(input.now) - retentionDays * 24 * 60 * 60 * 1_000;
    const transaction = database.transaction(() => ({
      deletedEvents: database.prepare(
        `DELETE FROM run_events
         WHERE at_ms < ?
           AND event_type NOT LIKE 'artifact:%'`
      ).run(cutoff).changes,
      deletedTransitions: database.prepare(
        `DELETE FROM run_transitions AS candidate
         WHERE candidate.at_ms < ?
           AND EXISTS (
             SELECT 1
             FROM run_transitions AS newer
             WHERE newer.operation_id = candidate.operation_id
               AND newer.state_revision > candidate.state_revision
           )`
      ).run(cutoff).changes,
    }));
    return transaction.immediate();
  }

  enqueueNotification(input: {
    notificationId: string;
    operationId: string;
    kind: string;
    operationMarker: string;
    payload: unknown;
    createdAt?: string | Date | number;
  }): { created: boolean; notification: NotificationRecord } {
    const database = this.requireDatabase();
    const notificationId = requireText(input.notificationId, 'notification_id');
    const payloadJson = stableStringify(input.payload);
    const transaction = database.transaction(() => {
      this.requireRun(input.operationId);
      const existing = database.prepare(
        `SELECT * FROM notification_outbox WHERE notification_id = ?`
      ).get(notificationId) as DatabaseRow | undefined;
      if (existing) {
        if (
          String(existing.operation_id) !== input.operationId ||
          String(existing.kind) !== input.kind ||
          String(existing.operation_marker) !== input.operationMarker ||
          String(existing.payload_json) !== payloadJson
        ) {
          throw new Error('NOTIFICATION_IDEMPOTENCY_CONFLICT');
        }
        return { created: false, notification: asNotification(existing) };
      }
      const createdAt = toMilliseconds(input.createdAt);
      database.prepare(`
        INSERT INTO notification_outbox (
          notification_id, operation_id, kind, operation_marker, payload_json,
          status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        notificationId,
        input.operationId,
        requireText(input.kind, 'notification_kind'),
        requireText(input.operationMarker, 'operation_marker'),
        payloadJson,
        createdAt,
        createdAt
      );
      return {
        created: true,
        notification: this.requireNotification(notificationId),
      };
    });
    return transaction.immediate();
  }

  listWebhookEvents(operationId: string): WebhookEventRecord[] {
    return (this.requireDatabase().prepare(`
      SELECT *
      FROM webhook_outbox
      WHERE operation_id = ?
      ORDER BY created_at_ms, event_id
    `).all(requireText(operationId, 'operation_id')) as DatabaseRow[])
      .map(asWebhookEvent);
  }

  claimNextWebhookEvent(input: {
    claimTtlMs: number;
    now?: string | Date | number;
  }): WebhookEventRecord | undefined {
    if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs <= 0) {
      throw new Error('INVALID_WEBHOOK_CLAIM_TTL');
    }
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const transaction = database.transaction(() => {
      database.prepare(`
        UPDATE webhook_outbox
        SET status = 'pending',
            claim_token = NULL,
            claimed_at_ms = NULL,
            claim_expires_at_ms = NULL,
            updated_at_ms = ?
        WHERE status = 'claimed' AND claim_expires_at_ms <= ?
      `).run(now, now);
      const next = database.prepare(`
        SELECT event_id
        FROM webhook_outbox
        WHERE status = 'pending' AND available_at_ms <= ?
        ORDER BY available_at_ms, created_at_ms, event_id
        LIMIT 1
      `).get(now) as DatabaseRow | undefined;
      if (!next) return undefined;
      const claimToken = randomUUID();
      database.prepare(`
        UPDATE webhook_outbox
        SET status = 'claimed',
            claim_token = ?,
            claimed_at_ms = ?,
            claim_expires_at_ms = ?,
            attempt_count = attempt_count + 1,
            updated_at_ms = ?
        WHERE event_id = ? AND status = 'pending'
      `).run(claimToken, now, now + input.claimTtlMs, now, next.event_id);
      return this.requireWebhookEvent(String(next.event_id));
    });
    return transaction.immediate();
  }

  completeWebhookEvent(input: {
    eventId: string;
    claimToken: string;
    now?: string | Date | number;
  }): WebhookEventRecord {
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const result = database.prepare(`
      UPDATE webhook_outbox
      SET status = 'delivered',
          claim_expires_at_ms = NULL,
          updated_at_ms = ?
      WHERE event_id = ? AND status = 'claimed' AND claim_token = ?
    `).run(now, input.eventId, input.claimToken);
    if (result.changes !== 1) throw new Error('WEBHOOK_CLAIM_CONFLICT');
    return this.requireWebhookEvent(input.eventId);
  }

  retryWebhookEvent(input: {
    eventId: string;
    claimToken: string;
    maxAttempts: number;
    retryAt: string | Date | number;
    errorCode: string;
    now?: string | Date | number;
  }): WebhookEventRecord {
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
      throw new Error('INVALID_WEBHOOK_MAX_ATTEMPTS');
    }
    const database = this.requireDatabase();
    const now = toMilliseconds(input.now);
    const retryAt = toMilliseconds(input.retryAt);
    const event = this.requireWebhookEvent(input.eventId);
    if (event.status !== 'claimed' || event.claimToken !== input.claimToken) {
      throw new Error('WEBHOOK_CLAIM_CONFLICT');
    }
    const exhausted = event.attemptCount >= input.maxAttempts;
    database.prepare(`
      UPDATE webhook_outbox
      SET status = ?,
          claim_token = NULL,
          claimed_at_ms = NULL,
          claim_expires_at_ms = NULL,
          available_at_ms = ?,
          last_error_code = ?,
          updated_at_ms = ?
      WHERE event_id = ? AND status = 'claimed' AND claim_token = ?
    `).run(
      exhausted ? 'exhausted' : 'pending',
      exhausted ? now : retryAt,
      requireText(input.errorCode, 'webhook_error_code'),
      now,
      input.eventId,
      input.claimToken
    );
    return this.requireWebhookEvent(input.eventId);
  }

  claimNextNotification(input: {
    notificationId: string;
    claimantId: string;
    claimTtlMs: number;
    now?: string | Date | number;
  }): NotificationRecord | undefined {
    const database = this.requireDatabase();
    const notificationId = requireText(
      input.notificationId,
      'notification_id'
    );
    const claimantId = requireText(input.claimantId, 'claimant_id');
    if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs <= 0) {
      throw new Error('INVALID_NOTIFICATION_CLAIM_TTL');
    }
    const now = toMilliseconds(input.now);
    const transaction = database.transaction(() => {
      this.expireNotificationClaimsInTransaction(now);
      const next = database.prepare(`
        SELECT notification_id
        FROM notification_outbox
        WHERE notification_id = ? AND status = 'pending'
      `).get(notificationId) as DatabaseRow | undefined;
      if (!next) return undefined;
      const claimToken = randomUUID();
      database.prepare(`
        UPDATE notification_outbox
        SET status = 'claimed',
            claim_token = ?,
            claimed_by = ?,
            claimed_at_ms = ?,
            claim_expires_at_ms = ?,
            attempt_count = attempt_count + 1,
            updated_at_ms = ?
        WHERE notification_id = ? AND status = 'pending'
      `).run(
        claimToken,
        claimantId,
        now,
        now + input.claimTtlMs,
        now,
        next.notification_id
      );
      return this.requireNotification(String(next.notification_id));
    });
    return transaction.immediate();
  }

  ackNotification(input: {
    notificationId: string;
    claimToken: string;
    slackTimestamp: string;
    permalink: string;
    now?: string | Date | number;
  }): NotificationRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const now = toMilliseconds(input.now);
      this.expireNotificationClaimsInTransaction(now);
      const notification = this.requireNotification(input.notificationId);
      if (
        notification.status !== 'claimed' ||
        notification.claimToken !== input.claimToken
      ) {
        return { conflict: true as const };
      }
      database.prepare(`
        UPDATE notification_outbox
        SET status = 'acknowledged',
            slack_timestamp = ?,
            permalink = ?,
            claim_expires_at_ms = NULL,
            updated_at_ms = ?
        WHERE notification_id = ?
      `).run(
        requireText(input.slackTimestamp, 'slack_timestamp'),
        requireText(input.permalink, 'permalink'),
        now,
        input.notificationId
      );
      return {
        conflict: false as const,
        notification: this.requireNotification(input.notificationId),
      };
    });
    const result = transaction.immediate();
    if (result.conflict) throw new Error('NOTIFICATION_CLAIM_CONFLICT');
    return result.notification;
  }

  markNotificationDeliveryUnknown(input: {
    notificationId: string;
    claimToken?: string;
    reason: string;
    now?: string | Date | number;
  }): NotificationRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const notification = this.requireNotification(input.notificationId);
      if (notification.status === 'delivery_unknown') return notification;
      if (
        notification.status !== 'claimed' ||
        (input.claimToken !== undefined && notification.claimToken !== input.claimToken)
      ) {
        throw new Error('NOTIFICATION_CLAIM_CONFLICT');
      }
      const now = toMilliseconds(input.now);
      database.prepare(`
        UPDATE notification_outbox
        SET status = 'delivery_unknown',
            reconciliation_json = ?,
            claim_expires_at_ms = NULL,
            updated_at_ms = ?
        WHERE notification_id = ?
      `).run(
        stableStringify({ reason: requireText(input.reason, 'delivery_unknown_reason') }),
        now,
        input.notificationId
      );
      return this.requireNotification(input.notificationId);
    });
    return transaction.immediate();
  }

  expireNotificationClaims(input: {
    now?: string | Date | number;
  }): number {
    const database = this.requireDatabase();
    const transaction = database.transaction(() =>
      this.expireNotificationClaimsInTransaction(toMilliseconds(input.now))
    );
    return transaction.immediate();
  }

  private expireNotificationClaimsInTransaction(now: number): number {
    return this.requireDatabase().prepare(`
      UPDATE notification_outbox
      SET status = 'delivery_unknown',
          reconciliation_json = '{"reason":"claim_expired_without_ack"}',
          claim_expires_at_ms = NULL,
          updated_at_ms = ?
      WHERE status = 'claimed' AND claim_expires_at_ms <= ?
    `).run(now, now).changes;
  }

  reconcileNotification(input: {
    notificationId: string;
    action: 'acknowledge_existing' | 'retry_after_duplicate_risk';
    operatorId: string;
    slackTimestamp?: string;
    permalink?: string;
    now?: string | Date | number;
  }): NotificationRecord {
    const database = this.requireDatabase();
    const transaction = database.transaction(() => {
      const notification = this.requireNotification(input.notificationId);
      if (notification.status !== 'delivery_unknown') {
        throw new Error('NOTIFICATION_NOT_DELIVERY_UNKNOWN');
      }
      const now = toMilliseconds(input.now);
      const operatorId = requireText(input.operatorId, 'operator_id');
      if (input.action === 'acknowledge_existing') {
        database.prepare(`
          UPDATE notification_outbox
          SET status = 'acknowledged',
              slack_timestamp = ?,
              permalink = ?,
              reconciliation_json = ?,
              updated_at_ms = ?
          WHERE notification_id = ?
        `).run(
          requireText(input.slackTimestamp, 'slack_timestamp'),
          requireText(input.permalink, 'permalink'),
          stableStringify({ action: input.action, operatorId }),
          now,
          input.notificationId
        );
      } else {
        database.prepare(`
          UPDATE notification_outbox
          SET status = 'pending',
              claim_token = NULL,
              claimed_by = NULL,
              claimed_at_ms = NULL,
              claim_expires_at_ms = NULL,
              duplicate_risk_accepted_at_ms = ?,
              reconciliation_json = ?,
              updated_at_ms = ?
          WHERE notification_id = ?
        `).run(
          now,
          stableStringify({ action: input.action, operatorId }),
          now,
          input.notificationId
        );
      }
      return this.requireNotification(input.notificationId);
    });
    return transaction.immediate();
  }

  getNotification(notificationId: string): NotificationRecord | undefined {
    const row = this.requireDatabase().prepare(
      `SELECT * FROM notification_outbox WHERE notification_id = ?`
    ).get(notificationId) as DatabaseRow | undefined;
    return row ? asNotification(row) : undefined;
  }

  async createBackup(destinationPath: string): Promise<void> {
    const database = this.requireDatabase();
    const destination = resolve(requireText(destinationPath, 'backup_path'));
    if (destination === this.databasePath) {
      throw new Error('INVALID_BACKUP_PATH: destination is the live database');
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await database.backup(destination);
    await chmod(destination, 0o600);
    fsyncPath(destination);
    fsyncPath(dirname(destination));
  }

  private quarantineRestoredDatabase(input: {
    database: Database.Database;
    backupPath: string;
    reason: string;
    restoredAt: number;
    liveEpochBeforeRestore: number;
    liveStoreInstanceId: string;
  }): {
    previousEpoch: number;
    epoch: number;
    quarantinedOperationIds: string[];
  } {
    const {
      database,
      backupPath,
      reason,
      restoredAt,
      liveEpochBeforeRestore,
      liveStoreInstanceId,
    } = input;
    const restoredSnapshotEpoch = this.getDeploymentEpochFrom(database);
    const previousEpoch = liveEpochBeforeRestore;
    const epoch = Math.max(liveEpochBeforeRestore, restoredSnapshotEpoch) + 1;
    const transaction = database.transaction(() => {
      database.prepare(`
        UPDATE notification_outbox
        SET status = 'delivery_unknown',
            reconciliation_json = '{"reason":"backup_restore_notification_state_stale"}',
            claim_expires_at_ms = NULL,
            updated_at_ms = ?
        WHERE status IN ('pending', 'claimed')
      `).run(restoredAt);
      const rows = database.prepare(
        `SELECT * FROM runs ORDER BY operation_id`
      ).all() as DatabaseRow[];
      const quarantinedOperationIds: string[] = [];
      for (const row of rows) {
        const state = String(row.state) as ManufacturingRunState;
        if (RESTORE_TERMINAL_STATES.has(state) || state === 'restore_quarantine') continue;
        const operationId = String(row.operation_id);
        const revision = Number(row.state_revision) + 1;
        database.prepare(`
          UPDATE runs
          SET state = 'restore_quarantine',
              state_revision = ?,
              updated_at_ms = ?,
              restore_epoch = ?
          WHERE operation_id = ?
        `).run(revision, restoredAt, epoch, operationId);
        database.prepare(`
          INSERT INTO run_transitions (
            operation_id, from_state, to_state, state_revision, reason, at_ms
          ) VALUES (?, ?, 'restore_quarantine', ?, ?, ?)
        `).run(
          operationId,
          state,
          revision,
          `backup_restore:${reason}`,
          restoredAt
        );
        database.prepare(`
          INSERT INTO run_events (operation_id, event_type, detail_json, at_ms)
          VALUES (?, 'restore_quarantine', ?, ?)
        `).run(
          operationId,
          stableStringify({ previousState: state, restoreEpoch: epoch }),
          restoredAt
        );
        this.enqueueTransitionSignalsInTransaction(database, {
          operationId,
          toState: 'restore_quarantine',
          stateRevision: revision,
          at: restoredAt,
        });
        quarantinedOperationIds.push(operationId);
      }
      database.prepare(`DELETE FROM work_queue`).run();
      database.prepare(`DELETE FROM worker_lease`).run();
      const updateMetadata = database.prepare(`
        INSERT INTO schema_metadata (key, value, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at_ms = excluded.updated_at_ms
      `);
      updateMetadata.run('deployment_epoch', String(epoch), restoredAt);
      updateMetadata.run('store_instance_id', liveStoreInstanceId, restoredAt);
      database.prepare(`
        INSERT INTO restore_history (
          restore_epoch, source_backup_path, reason, restored_at_ms, quarantined_count
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        epoch,
        backupPath,
        reason,
        restoredAt,
        quarantinedOperationIds.length
      );
      return { previousEpoch, epoch, quarantinedOperationIds };
    });
    return transaction.immediate();
  }

  async restoreFromBackup(input: {
    backupPath: string;
    reason: string;
    restoredAt?: string | Date | number;
  }): Promise<{
    previousEpoch: number;
    epoch: number;
    quarantinedOperationIds: string[];
  }> {
    const liveDatabase = this.requireDatabase();
    const liveEpochBeforeRestore = this.getDeploymentEpoch();
    const liveStoreInstanceId = this.getStoreInstanceIdFrom(liveDatabase);
    const backupPath = resolve(requireText(input.backupPath, 'backup_path'));
    const reason = requireText(input.reason, 'restore_reason');
    if (backupPath === this.databasePath) {
      throw new Error('INVALID_BACKUP_PATH: source is the live database');
    }
    const backupInfo = lstatSync(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
      throw new Error('INVALID_BACKUP_PATH');
    }

    const source = new Database(backupPath, { readonly: true, fileMustExist: true });
    const restoreTemp = `${this.databasePath}.restore-${randomUUID()}`;
    const rollbackPath = `${this.databasePath}.pre-restore-${randomUUID()}`;
    try {
      this.verifyIntegrity(source);
      const version = Number(source.pragma('user_version', { simple: true }));
      if (![1, 2, MANUFACTURING_RUN_SCHEMA_VERSION].includes(version)) {
        throw new Error(`WRITE_GATE_CLOSED: UNSUPPORTED_SCHEMA_BACKUP: ${version}`);
      }
      this.verifySchemaMetadata(source, false, version);
      if (version === MANUFACTURING_RUN_SCHEMA_VERSION) {
        this.verifySchemaContract(source);
        this.verifyDataInvariants(source);
      }
      await source.backup(restoreTemp);
    } finally {
      source.close();
    }
    chmodSync(restoreTemp, 0o600);
    fsyncPath(restoreTemp);

    const restoredAt = toMilliseconds(input.restoredAt);
    this.close();
    let replaced = false;
    let preparedResult:
      | {
          previousEpoch: number;
          epoch: number;
          quarantinedOperationIds: string[];
        }
      | undefined;
    try {
      const restoredDatabase = new Database(restoreTemp, { fileMustExist: true });
      try {
        this.configureDatabaseConnection(restoredDatabase);
        this.verifyIntegrity(restoredDatabase);
        this.migrate(restoredDatabase, false);
        this.verifySchemaMetadata(restoredDatabase, false);
        this.verifySchemaContract(restoredDatabase);
        this.verifyDataInvariants(restoredDatabase);
        preparedResult = this.quarantineRestoredDatabase({
          database: restoredDatabase,
          backupPath,
          reason,
          restoredAt,
          liveEpochBeforeRestore,
          liveStoreInstanceId,
        });
        this.verifyIntegrity(restoredDatabase);
        this.verifySchemaMetadata(restoredDatabase);
        this.verifySchemaContract(restoredDatabase);
        this.verifyDataInvariants(restoredDatabase);
        restoredDatabase.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        restoredDatabase.close();
      }
      secureDatabaseFiles(restoreTemp);
      fsyncPath(restoreTemp);
      rmSync(`${restoreTemp}-wal`, { force: true });
      rmSync(`${restoreTemp}-shm`, { force: true });

      renameSync(this.databasePath, rollbackPath);
      replaced = true;
      rmSync(`${this.databasePath}-wal`, { force: true });
      rmSync(`${this.databasePath}-shm`, { force: true });
      renameSync(restoreTemp, this.databasePath);
      fsyncPath(dirname(this.databasePath));
      this.testHooks?.afterRestoredDatabaseRenamed?.(this.databasePath);
      this.initialize();
      secureDatabaseFiles(this.databasePath);
      await rm(rollbackPath, { force: true });
      this.diagnostics = this.readDiagnostics();
      if (!preparedResult) throw new Error('RESTORE_PREPARATION_INCOMPLETE');
      return preparedResult;
    } catch (error) {
      this.database?.close();
      this.database = undefined;
      this.diagnostics = undefined;
      if (replaced && existsSync(rollbackPath)) {
        rmSync(this.databasePath, { force: true });
        rmSync(`${this.databasePath}-wal`, { force: true });
        rmSync(`${this.databasePath}-shm`, { force: true });
        renameSync(rollbackPath, this.databasePath);
        this.initialize();
      } else if (existsSync(this.databasePath)) {
        this.initialize();
      }
      throw error;
    } finally {
      rmSync(restoreTemp, { force: true });
      rmSync(`${restoreTemp}-wal`, { force: true });
      rmSync(`${restoreTemp}-shm`, { force: true });
    }
  }

  private requireRun(operationId: string): ManufacturingRunRecord {
    const run = this.getRun(operationId);
    if (!run) throw new Error(`UNKNOWN_MANUFACTURING_RUN: ${operationId}`);
    return run;
  }

  private requireNotification(notificationId: string): NotificationRecord {
    const notification = this.getNotification(notificationId);
    if (!notification) throw new Error(`UNKNOWN_NOTIFICATION: ${notificationId}`);
    return notification;
  }

  private requireWebhookEvent(eventId: string): WebhookEventRecord {
    const row = this.requireDatabase().prepare(
      `SELECT * FROM webhook_outbox WHERE event_id = ?`
    ).get(eventId) as DatabaseRow | undefined;
    if (!row) throw new Error(`UNKNOWN_WEBHOOK_EVENT: ${eventId}`);
    return asWebhookEvent(row);
  }
}
