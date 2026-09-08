import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const MODULE_EXTENSION = extname(fileURLToPath(import.meta.url));

export const ADAPTER_PRODUCTION_ROOTS = [
  'client',
  'core',
  'http',
  'runtime',
  'services',
  'tools',
  'types',
] as const;

function productionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(MODULE_EXTENSION) && !entry.name.includes('.test.')) files.push(path);
    }
  };
  visit(root);
  return files;
}

function digest(label: string, files: string[]): string {
  const hash = createHash('sha256').update(`${label}\0`);
  for (const path of files.sort()) {
    hash.update(relative(MODULE_ROOT, path).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface BuildIdentities {
  adapterManifestHash: string;
  probeBuild: string;
}

export function computeBuildIdentities(): BuildIdentities {
  const adapterRoots = ADAPTER_PRODUCTION_ROOTS
    .map((name) => join(MODULE_ROOT, name));
  const adapterFiles = [
    ...adapterRoots.flatMap(productionFiles),
    join(MODULE_ROOT, `build-identity${MODULE_EXTENSION}`),
    join(MODULE_ROOT, `config${MODULE_EXTENSION}`),
    join(MODULE_ROOT, `registry${MODULE_EXTENSION}`),
  ];
  const probeFiles = [
    ...productionFiles(join(MODULE_ROOT, 'probes')),
    join(MODULE_ROOT, `build-identity${MODULE_EXTENSION}`),
  ];
  return {
    adapterManifestHash: digest('inflow-adapter-manifest/v1', adapterFiles),
    probeBuild: digest('inflow-probe-build/v1', probeFiles),
  };
}

export function verifyBuildIdentityOverride(name: string, supplied: string | undefined, computed: string): string {
  if (supplied && supplied !== computed) {
    throw new Error(`${name}_MISMATCH: supplied build identity does not match the running artifacts`);
  }
  return computed;
}
