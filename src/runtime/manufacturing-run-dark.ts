#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type Server,
} from 'node:http';
import { isIP } from 'node:net';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

interface DarkSignals {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface ManufacturingRunDarkOptions {
  host: string;
  port: number;
  evidencePath: string;
  repositoryRoot?: string;
  signals?: DarkSignals;
}

export interface ManufacturingRunDarkArguments {
  host: string;
  port: number;
  evidencePath: string;
}

const DEFAULT_REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '127.0.0.1' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}

function isInside(candidate: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === '' ||
    (!relation.startsWith('..') && !isAbsolute(relation));
}

function validateEvidencePath(
  evidencePath: string,
  repositoryRoot: string
): void {
  if (!isAbsolute(evidencePath)) {
    throw new Error('DARK_EVIDENCE_PATH_ABSOLUTE_REQUIRED');
  }
  if (isInside(evidencePath, repositoryRoot)) {
    throw new Error('DARK_EVIDENCE_PATH_EXTERNAL_REQUIRED');
  }
}

export interface EvidenceDirectoryMetadata {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid: number;
}

export function validateEvidenceDirectoryMetadata(
  metadata: EvidenceDirectoryMetadata,
  currentUid: number | undefined
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('DARK_EVIDENCE_DIRECTORY_INVALID');
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error('DARK_EVIDENCE_DIRECTORY_MODE_INVALID');
  }
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('DARK_EVIDENCE_DIRECTORY_OWNER_INVALID');
  }
}

function ensureSecureEvidenceDirectory(
  path: string,
  repositoryRoot: string
): string {
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;

  const validateDirectory = (
    candidate: string
  ): { path: string; dev: number; ino: number } => {
    const metadata = lstatSync(candidate);
    validateEvidenceDirectoryMetadata(metadata, uid);
    const canonicalPath = realpathSync(candidate);
    if (canonicalPath !== resolve(candidate)) {
      throw new Error('DARK_EVIDENCE_DIRECTORY_INVALID');
    }
    const canonicalMetadata = lstatSync(canonicalPath);
    if (
      canonicalMetadata.dev !== metadata.dev ||
      canonicalMetadata.ino !== metadata.ino
    ) {
      throw new Error('DARK_EVIDENCE_DIRECTORY_CHANGED');
    }
    validateEvidencePath(canonicalPath, repositoryRoot);
    return {
      path: canonicalPath,
      dev: metadata.dev,
      ino: metadata.ino,
    };
  };

  const requestedPath = resolve(path);
  validateEvidencePath(requestedPath, repositoryRoot);
  const missingSegments: string[] = [];
  let existingPath = requestedPath;
  let existing: ReturnType<typeof validateDirectory> | undefined;
  while (existing === undefined) {
    try {
      existing = validateDirectory(existingPath);
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error
          ? error.code
          : undefined;
      if (code !== 'ENOENT') throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        throw new Error('DARK_EVIDENCE_DIRECTORY_ANCHOR_REQUIRED');
      }
      missingSegments.unshift(basename(existingPath));
      existingPath = parent;
    }
  }

  const identities = [existing];
  let current = existing.path;
  for (const segment of missingSegments) {
    const candidate = join(current, segment);
    try {
      mkdirSync(candidate, { mode: 0o700 });
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error
          ? error.code
          : undefined;
      if (code !== 'EEXIST') throw error;
    }
    const created = validateDirectory(candidate);
    identities.push(created);
    current = created.path;
  }

  for (const identity of identities) {
    const metadata = lstatSync(identity.path);
    if (
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino
    ) {
      throw new Error('DARK_EVIDENCE_DIRECTORY_CHANGED');
    }
  }
  return current;
}

export function parseManufacturingRunDarkArguments(
  argv: readonly string[],
  repositoryRoot = DEFAULT_REPOSITORY_ROOT
): ManufacturingRunDarkArguments {
  let host = '127.0.0.1';
  let port = 8_787;
  let evidencePath: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== '--host' &&
      argument !== '--port' &&
      argument !== '--evidence-path'
    ) {
      throw new Error('DARK_ARGUMENT_UNKNOWN');
    }
    if (seen.has(argument)) throw new Error('DARK_ARGUMENT_DUPLICATE');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('DARK_ARGUMENT_VALUE_REQUIRED');
    }
    seen.add(argument);
    index += 1;
    if (argument === '--host') host = value;
    if (argument === '--port') {
      const parsedPort = Number(value);
      if (
        !Number.isSafeInteger(parsedPort) ||
        parsedPort < 0 ||
        parsedPort > 65_535
      ) {
        throw new Error('DARK_PORT_INVALID');
      }
      port = parsedPort;
    }
    if (argument === '--evidence-path') evidencePath = value;
  }
  if (!isLoopback(host)) throw new Error('DARK_LOOPBACK_REQUIRED');
  if (evidencePath === undefined) {
    throw new Error('DARK_EVIDENCE_PATH_REQUIRED');
  }
  validateEvidencePath(evidencePath, repositoryRoot);
  return { host, port, evidencePath };
}

interface DarkEvidence {
  schemaVersion: 'inflow-manufacturing-run-shadow/v1';
  mode: 'shadow';
  gate: 'closed';
  effectful: false;
  state: 'running' | 'closed';
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  observedAt: string;
  healthRequests: number;
}

function writeEvidenceAtomically(
  evidencePath: string,
  evidence: DarkEvidence
): void {
  const temporaryPath = join(
    dirname(evidencePath),
    `.${basename(evidencePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, evidencePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may already have been atomically renamed.
    }
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((finish, reject) => {
    if (!server.listening) {
      finish();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else finish();
    });
    server.closeIdleConnections();
  });
}

export async function startManufacturingRunDark(
  options: ManufacturingRunDarkOptions
): Promise<{
  address: { address: string; port: number };
  close(): Promise<void>;
}> {
  if (!isLoopback(options.host)) throw new Error('DARK_LOOPBACK_REQUIRED');
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error('DARK_PORT_INVALID');
  }
  const repositoryRoot = realpathSync(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT
  );
  if (!isAbsolute(options.evidencePath)) {
    throw new Error('DARK_EVIDENCE_PATH_ABSOLUTE_REQUIRED');
  }
  validateEvidencePath(options.evidencePath, repositoryRoot);
  const evidenceParent = ensureSecureEvidenceDirectory(
    dirname(options.evidencePath),
    repositoryRoot
  );
  const evidencePath = join(evidenceParent, basename(options.evidencePath));
  validateEvidencePath(evidencePath, repositoryRoot);
  const signals = options.signals ?? process;
  const startedAt = new Date().toISOString();
  let healthRequests = 0;
  let state: DarkEvidence['state'] = 'running';
  let boundPort = options.port;
  const evidence = (): DarkEvidence => ({
    schemaVersion: 'inflow-manufacturing-run-shadow/v1',
    mode: 'shadow',
    gate: 'closed',
    effectful: false,
    state,
    host: options.host,
    port: boundPort,
    pid: process.pid,
    startedAt,
    observedAt: new Date().toISOString(),
    healthRequests,
  });
  const healthBody = JSON.stringify({
    mode: 'shadow',
    gate: 'closed',
    effectful: false,
  });
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method !== 'GET' || request.url !== '/healthz') {
      const body = JSON.stringify({ error: 'NOT_FOUND' });
      response.writeHead(404, { 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    healthRequests += 1;
    try {
      writeEvidenceAtomically(evidencePath, evidence());
      response.writeHead(200, {
        'Content-Length': Buffer.byteLength(healthBody),
      });
      response.end(healthBody);
    } catch {
      const body = JSON.stringify({ error: 'EVIDENCE_UPDATE_FAILED' });
      response.writeHead(503, { 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    }
  });

  await new Promise<void>((finish, reject) => {
    server.once('error', reject);
    server.listen({
      host: options.host,
      port: options.port,
      exclusive: true,
    }, () => {
      server.off('error', reject);
      finish();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('DARK_LISTENER_ADDRESS_INVALID');
  }
  boundPort = address.port;
  try {
    writeEvidenceAtomically(evidencePath, evidence());
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    closePromise = (async () => {
      await closeServer(server);
      state = 'closed';
      writeEvidenceAtomically(evidencePath, evidence());
    })();
    return closePromise;
  };
  const onSignal = (): void => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  signals.once('SIGINT', onSignal);
  signals.once('SIGTERM', onSignal);
  return {
    address: { address: options.host, port: boundPort },
    close,
  };
}

async function main(): Promise<void> {
  const options = parseManufacturingRunDarkArguments(process.argv.slice(2));
  const runtime = await startManufacturingRunDark(options);
  console.error(JSON.stringify({
    event: 'manufacturing_run_shadow_started',
    mode: 'shadow',
    gate: 'closed',
    effectful: false,
    address: runtime.address,
  }));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch(() => {
    console.error(JSON.stringify({
      event: 'manufacturing_run_shadow_fatal',
      code: 'DARK_STARTUP_FAILED',
    }));
    process.exitCode = 1;
  });
}
