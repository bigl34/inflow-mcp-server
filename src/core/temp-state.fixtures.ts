import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const trackedPaths: string[] = [];

afterAll(async () => {
  const pathsToRemove = trackedPaths.splice(0);
  const removals = pathsToRemove.map((path) => rm(path, { recursive: true, force: true }));
  await Promise.all(removals);
});

export function trackTempPath(path: string): string {
  trackedPaths.push(path);
  return path;
}

export async function createTempStateDir(prefix: string, root: string = tmpdir()): Promise<string> {
  const stateDir = await mkdtemp(join(root, prefix));
  await chmod(stateDir, 0o700);
  return trackTempPath(stateDir);
}
