#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { Server } from 'node:http';
import { InflowClient } from './client/inflow.js';
import { loadConfig } from './config.js';
import {
  resolveCoordinatorWriteGate,
  resolveManufacturingOperationCompletionGate,
} from './core/gates.js';
import {
  COORDINATOR_REQUESTS_PER_MINUTE,
  ManufacturingRunStore,
} from './core/manufacturing-run-store.js';
import {
  acquireNonStaleProcessLock,
  listenExclusiveLoopback,
  ManufacturingRunCoordinator,
  validateCoordinatorSingletonConfig,
  type CoordinatorProcessLock,
} from './services/manufacturing-run-coordinator.js';
import {
  loadManufacturingRunHmacKeyring,
  loadManufacturingRunHttpConfig,
} from './http/manufacturing-run-config.js';
import {
  evaluateManufacturingRunReadiness,
  type ManufacturingRunReadiness,
} from './http/manufacturing-run-readiness.js';
import {
  createCoordinatorComponentResolver,
  createManufacturingRunServer,
} from './http/manufacturing-run-server.js';
import { deliverNextManufacturingWebhook } from './services/manufacturing-run-webhook-delivery.js';

export async function runCoordinatorWorkerTick(input: {
  readiness(): Promise<Pick<ManufacturingRunReadiness, 'ready'>>;
  runOne(): Promise<unknown>;
  deliverWebhook(): Promise<unknown>;
}): Promise<'skipped_not_ready' | 'ran'> {
  const readiness = await input.readiness();
  if (!readiness.ready) return 'skipped_not_ready';
  await input.runOne();
  await input.deliverWebhook();
  return 'ran';
}

export function manufacturingWorkerFailureCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  if (typeof record.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(record.code)) {
    return record.code;
  }
  if (
    typeof record.message === 'string' &&
    /^[A-Z0-9_:-]{1,80}$/.test(record.message)
  ) {
    return record.message;
  }
  if (typeof record.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(record.name)) {
    return record.name;
  }
  return 'UNKNOWN';
}

export interface ManufacturingRunHttpRuntime {
  server: Server;
  close(): Promise<void>;
}

function localClockProbe(): () => { skewMs: number } {
  const wallStarted = Date.now();
  const monotonicStarted = process.hrtime.bigint();
  return () => {
    const monotonicElapsedMs =
      Number(process.hrtime.bigint() - monotonicStarted) / 1_000_000;
    return {
      skewMs: Date.now() - (wallStarted + monotonicElapsedMs),
    };
  };
}

async function loadRuntimeReleaseIdentity(): Promise<{ releaseOid: string; materialSha256: string }> {
  const path = process.env.YOUR_COMPANY_RUNTIME_IDENTITY_PATH?.trim() ?? '';
  if (!isAbsolute(path)) return { releaseOid: '', materialSha256: '' };
  const info = await lstat(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || uid === null || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 4096) {
    throw new Error('RUNTIME_IDENTITY_FILE_INVALID');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (parsed.schema_version !== 1 || !/^[0-9a-f]{40}$/.test(String(parsed.release_oid ?? ''))
    || !/^[0-9a-f]{64}$/.test(String(parsed.runtime_tree_sha256 ?? ''))
    || String(parsed.release_oid) !== (process.env.YOUR_COMPANY_RUNTIME_APPROVED_OID?.trim() ?? '')) {
    throw new Error('RUNTIME_IDENTITY_FILE_INVALID');
  }
  return { releaseOid: String(parsed.release_oid), materialSha256: String(parsed.runtime_tree_sha256) };
}

export async function startManufacturingRunHttp(): Promise<ManufacturingRunHttpRuntime> {
  const releaseIdentity = await loadRuntimeReleaseIdentity();
  const runtimeIdentity = {
    instanceId: randomUUID(),
    processId: process.pid,
    ...releaseIdentity,
    startedAt: new Date().toISOString(),
  };
  const inflowConfig = loadConfig();
  const httpConfig = loadManufacturingRunHttpConfig();
  validateCoordinatorSingletonConfig({
    listenerHost: httpConfig.host,
    listenerExclusive: httpConfig.listenerExclusive,
    processLockPath: httpConfig.processLockPath,
    workerLeaseMs: 30_000,
    launchdServiceLabels: [
      process.env.INFLOW_COORDINATOR_LAUNCHD_LABEL?.trim() ||
        'com.YOUR_COMPANY.biz.inflow-manufacturing-coordinator',
    ],
    requestsPerMinute: COORDINATOR_REQUESTS_PER_MINUTE,
  });

  const store = new ManufacturingRunStore({
    databasePath: httpConfig.databasePath,
  });
  store.initialize();
  let lock: CoordinatorProcessLock | undefined;
  let server: Server | undefined;
  let workerTimer: NodeJS.Timeout | undefined;
  try {
    lock = acquireNonStaleProcessLock(httpConfig.processLockPath);
    const client = new InflowClient(inflowConfig);
    const coordinator = new ManufacturingRunCoordinator({
      store,
      client,
      leaseMs: 30_000,
      verifyDefinitiveNoWrite: async (_error, domain) =>
        domain === 'manufacturing-operation-completion-v1'
          ? (
              await resolveManufacturingOperationCompletionGate(inflowConfig)
            ).enabled
          : (await resolveCoordinatorWriteGate(inflowConfig)).enabled,
      operationCompletionGate: async () =>
        (await resolveManufacturingOperationCompletionGate(inflowConfig))
          .enabled,
    });
    const clock = localClockProbe();
    const readiness = (): Promise<ManufacturingRunReadiness> =>
      evaluateManufacturingRunReadiness({
        host: () => ({
          healthy: server?.listening === true && lock !== undefined,
          reasonCode: 'HOST_UNHEALTHY',
        }),
        clock,
        gate: () => resolveCoordinatorWriteGate(inflowConfig),
        storage: () => store.getStartupDiagnostics(),
        rate: () => store.getRateBudgetStatus(),
      });
    server = createManufacturingRunServer({
      coordinator,
      store,
      componentResolver: createCoordinatorComponentResolver({
        coordinator,
        store,
        client,
        companyId: inflowConfig.companyId,
      }),
      readiness,
      keyring: () => loadManufacturingRunHmacKeyring(process.env),
      expectedAudience: httpConfig.audience,
      expectedCompanyId: httpConfig.companyId,
      limits: {
        bodyLimitBytes: httpConfig.bodyLimitBytes,
        requestTimeoutMs: httpConfig.requestTimeoutMs,
        headersTimeoutMs: httpConfig.headersTimeoutMs,
        keepAliveTimeoutMs: httpConfig.keepAliveTimeoutMs,
        maxHeaderBytes: httpConfig.maxHeaderBytes,
      },
      runtimeIdentity,
    });
    await listenExclusiveLoopback(server, {
      host: httpConfig.host,
      port: httpConfig.port,
    });

    let workerTickBusy = false;
    workerTimer = setInterval(() => {
      if (workerTickBusy) return;
      workerTickBusy = true;
      void runCoordinatorWorkerTick({
        readiness,
        runOne: () => coordinator.runOne(),
        deliverWebhook: () => {
          const key = loadManufacturingRunHmacKeyring(process.env).current;
          return deliverNextManufacturingWebhook({
            store,
            endpoints: {
              run_ready: httpConfig.webhookRunReadyUrl,
              terminal: httpConfig.webhookTerminalUrl,
            },
            signing: {
              kid: key.kid,
              secret: key.secret,
              audience: httpConfig.webhookAudience,
              companyId: httpConfig.companyId,
            },
            maxAttempts: httpConfig.webhookMaxAttempts,
            retryDelayMs: httpConfig.webhookRetryDelayMs,
            timeoutMs: httpConfig.webhookTimeoutMs,
            claimTtlMs: httpConfig.webhookClaimTtlMs,
          });
        },
      }).catch((error: unknown) => {
        console.error(JSON.stringify({
          event: 'manufacturing_run_worker_tick',
          code: 'WORKER_TICK_FAILED',
          failureCode: manufacturingWorkerFailureCode(error),
        }));
      }).finally(() => {
        workerTickBusy = false;
      });
    }, httpConfig.workerPollMs);
    workerTimer.unref();

    let closed = false;
    return {
      server,
      close: async () => {
        if (closed) return;
        closed = true;
        if (workerTimer) clearInterval(workerTimer);
        await new Promise<void>((finish) => {
          if (!server?.listening) {
            finish();
            return;
          }
          server.close(() => finish());
          server.closeIdleConnections();
        });
        store.close();
        lock?.release();
      },
    };
  } catch (error) {
    if (workerTimer) clearInterval(workerTimer);
    if (server?.listening) {
      await new Promise<void>((finish) => server?.close(() => finish()));
    }
    store.close();
    lock?.release();
    throw error;
  }
}

async function main(): Promise<void> {
  const runtime = await startManufacturingRunHttp();
  const close = async (): Promise<void> => {
    await runtime.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  console.error(JSON.stringify({
    event: 'manufacturing_run_http_started',
    address: runtime.server.address(),
  }));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'manufacturing_run_http_fatal',
      code: error instanceof Error
        ? /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? 'STARTUP_FAILED'
        : 'STARTUP_FAILED',
    }));
    process.exitCode = 1;
  });
}
