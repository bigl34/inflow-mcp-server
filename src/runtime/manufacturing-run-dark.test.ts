import { EventEmitter } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const darkModule = await import('./manufacturing-run-dark.js')
  .catch(() => ({})) as Record<string, unknown>;

function createTemporaryDirectory(prefix: string): string {
  for (const root of new Set([tmpdir(), '/tmp'])) {
    let created: string | undefined;
    try {
      created = mkdtempSync(join(realpathSync(root), prefix));
      const canonical = realpathSync(created);
      chmodSync(canonical, 0o700);
      if ((statSync(canonical).mode & 0o777) === 0o700) {
        return canonical;
      }
    } catch {
      // Try the next host-supported temporary root.
    }
    if (created !== undefined) {
      rmSync(created, { recursive: true, force: true });
    }
  }
  throw new Error('TEST_SECURE_TEMP_DIRECTORY_REQUIRED');
}

function getJson(
  host: string,
  port: number,
  path: string
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = get({ host, port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(body) as unknown,
        });
      });
    });
    request.on('error', reject);
  });
}

describe('manufacturing run dark process', () => {
  it('rejects non-loopback binding and evidence inside the repository', () => {
    expect(darkModule.parseManufacturingRunDarkArguments)
      .toBeTypeOf('function');
    const parse = darkModule.parseManufacturingRunDarkArguments as (
      argv: string[],
      repositoryRoot: string
    ) => unknown;

    expect(() => parse([
      '--host',
      '0.0.0.0',
      '--port',
      '8787',
      '--evidence-path',
      '/tmp/inflow-shadow.json',
    ], '/repo/inflow')).toThrow(/LOOPBACK_REQUIRED/);
    expect(() => parse([
      '--host',
      '127.0.0.1',
      '--port',
      '8787',
      '--evidence-path',
      '/repo/inflow/var/shadow.json',
    ], '/repo/inflow')).toThrow(/EVIDENCE_PATH_EXTERNAL_REQUIRED/);
  });

  it('rejects an in-repository direct start before creating its missing parent', async () => {
    const start = darkModule.startManufacturingRunDark as (
      options: Record<string, unknown>
    ) => Promise<unknown>;
    const repositoryRoot = createTemporaryDirectory('inflow-dark-repo-');
    const evidenceDirectory = join(repositoryRoot, 'shadow');
    const aliasRoot = createTemporaryDirectory('inflow-dark-alias-');
    try {
      await expect(start({
        host: '127.0.0.1',
        port: 0,
        evidencePath: join(evidenceDirectory, 'evidence.json'),
        repositoryRoot,
      })).rejects.toThrow(/EVIDENCE_PATH_EXTERNAL_REQUIRED/);
      expect(() => lstatSync(evidenceDirectory)).toThrow();

      const repositoryAlias = join(aliasRoot, 'repository-link');
      symlinkSync(repositoryRoot, repositoryAlias);
      const aliasedEvidenceDirectory = join(repositoryAlias, 'shadow');
      await expect(start({
        host: '127.0.0.1',
        port: 0,
        evidencePath: join(aliasedEvidenceDirectory, 'evidence.json'),
        repositoryRoot,
      })).rejects.toThrow(
        /EVIDENCE_(PATH_EXTERNAL_REQUIRED|DIRECTORY_INVALID)/
      );
      expect(() => lstatSync(evidenceDirectory)).toThrow();
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe existing evidence parent and wrong ownership metadata', async () => {
    const start = darkModule.startManufacturingRunDark as (
      options: Record<string, unknown>
    ) => Promise<unknown>;
    const validateMetadata =
      darkModule.validateEvidenceDirectoryMetadata as (
        metadata: {
          isDirectory(): boolean;
          isSymbolicLink(): boolean;
          mode: number;
          uid: number;
        },
        currentUid: number | undefined
      ) => void;
    const repositoryRoot =
      createTemporaryDirectory('inflow-dark-repository-');
    const directory = createTemporaryDirectory('inflow-dark-parent-');
    try {
      const wrongMode = join(directory, 'wrong-mode');
      mkdirSync(wrongMode, { mode: 0o700 });
      chmodSync(wrongMode, 0o750);
      await expect(start({
        host: '127.0.0.1',
        port: 0,
        evidencePath: join(wrongMode, 'evidence.json'),
        repositoryRoot,
      })).rejects.toThrow(/DIRECTORY_MODE_INVALID/);

      const target = join(directory, 'target');
      mkdirSync(target, { mode: 0o700 });
      const linkedParent = join(directory, 'linked-parent');
      symlinkSync(target, linkedParent);
      await expect(start({
        host: '127.0.0.1',
        port: 0,
        evidencePath: join(linkedParent, 'evidence.json'),
        repositoryRoot,
      })).rejects.toThrow(/DIRECTORY_INVALID/);

      const fileParent = join(directory, 'file-parent');
      writeFileSync(fileParent, 'not a directory', { mode: 0o600 });
      await expect(start({
        host: '127.0.0.1',
        port: 0,
        evidencePath: join(fileParent, 'evidence.json'),
        repositoryRoot,
      })).rejects.toThrow(/DIRECTORY_INVALID/);

      expect(() => validateMetadata({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o40700,
        uid: 2000,
      }, 1000)).toThrow(/DIRECTORY_OWNER_INVALID/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('serves effect-free loopback health, atomically records external evidence, and closes on SIGINT', async () => {
    expect(darkModule.startManufacturingRunDark).toBeTypeOf('function');
    const start = darkModule.startManufacturingRunDark as (
      options: Record<string, unknown>
    ) => Promise<{
      address: { address: string; port: number };
      close(): Promise<void>;
    }>;
    const repositoryRoot =
      createTemporaryDirectory('inflow-dark-repository-');
    const directory = createTemporaryDirectory('inflow-dark-');
    const evidenceDirectory = join(
      directory,
      'tasks',
      'inflow-manufacturing-run',
      'shadow'
    );
    const evidencePath = join(evidenceDirectory, 'shadow-evidence.json');
    const signals = new EventEmitter();
    try {
      expect(() => lstatSync(evidenceDirectory)).toThrow();
      const runtime = await start({
        host: '127.0.0.1',
        port: 0,
        evidencePath,
        repositoryRoot,
        signals,
      });
      const health = await getJson(
        runtime.address.address,
        runtime.address.port,
        '/healthz'
      );
      expect(health).toEqual({
        status: 200,
        body: {
          mode: 'shadow',
          gate: 'closed',
          effectful: false,
        },
      });
      const runningEvidence = JSON.parse(
        readFileSync(evidencePath, 'utf8')
      ) as Record<string, unknown>;
      expect(runningEvidence).toMatchObject({
        mode: 'shadow',
        gate: 'closed',
        effectful: false,
        state: 'running',
        host: '127.0.0.1',
        port: runtime.address.port,
        healthRequests: 1,
      });
      expect(statSync(evidenceDirectory).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(directory, 'tasks')).mode & 0o777
      ).toBe(0o700);
      expect(
        statSync(join(directory, 'tasks', 'inflow-manufacturing-run')).mode &
          0o777
      ).toBe(0o700);
      expect(readdirSync(evidenceDirectory)).toEqual([
        'shadow-evidence.json',
      ]);

      signals.emit('SIGINT');
      await vi.waitFor(() => {
        const evidence = JSON.parse(
          readFileSync(evidencePath, 'utf8')
        ) as Record<string, unknown>;
        expect(evidence.state).toBe('closed');
      });
      await runtime.close();
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
