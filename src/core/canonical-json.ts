import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface DiffOperation {
  op: 'add' | 'remove' | 'replace';
  path: string;
  before?: JsonValue;
  after?: JsonValue;
}

export interface SemanticDiff {
  schemaVersion: 'diff/v1';
  operations: DiffOperation[];
}

export function canonicalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Canonical JSON accepts safe integers only; exact decimals must be strings');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at key ${key}`);
      }
      result[key] = canonicalizeJson(child);
    }
    return result;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function canonicalHash(value: unknown, domain = 'canonical/v1'): string {
  return createHash('sha256')
    .update(`${domain}\0${stableStringify(value)}`)
    .digest('hex');
}

function pointer(path: string, key: string | number): string {
  const escaped = String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path}/${escaped}`;
}

export function semanticDiff(before: unknown, after: unknown): SemanticDiff {
  const operations: DiffOperation[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (stableStringify(left) === stableStringify(right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        if (index >= left.length) {
          operations.push({ op: 'add', path: pointer(path, index), after: canonicalizeJson(right[index]) });
        } else if (index >= right.length) {
          operations.push({ op: 'remove', path: pointer(path, index), before: canonicalizeJson(left[index]) });
        } else {
          walk(left[index], right[index], pointer(path, index));
        }
      }
      return;
    }
    if (
      left && right && typeof left === 'object' && typeof right === 'object' &&
      !Array.isArray(left) && !Array.isArray(right)
    ) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of Array.from(new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])).sort()) {
        if (!(key in leftRecord)) {
          operations.push({ op: 'add', path: pointer(path, key), after: canonicalizeJson(rightRecord[key]) });
        } else if (!(key in rightRecord)) {
          operations.push({ op: 'remove', path: pointer(path, key), before: canonicalizeJson(leftRecord[key]) });
        } else {
          walk(leftRecord[key], rightRecord[key], pointer(path, key));
        }
      }
      return;
    }
    operations.push({
      op: 'replace',
      path: path || '/',
      before: canonicalizeJson(left),
      after: canonicalizeJson(right),
    });
  };
  walk(before, after, '');
  return { schemaVersion: 'diff/v1', operations };
}
