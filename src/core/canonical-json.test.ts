import { describe, expect, it } from 'vitest';
import { canonicalHash, semanticDiff, stableStringify } from './canonical-json.js';

describe('canonical JSON', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 }, 'semantic/v1')).not.toBe(
      canonicalHash({ a: 1 }, 'write-shape/v1')
    );
    expect(() => stableStringify({ a: undefined })).toThrow(/undefined/);
    expect(() => stableStringify({ a: 1.5 })).toThrow(/safe integers/);
  });

  it('produces versioned deterministic diffs', () => {
    expect(semanticDiff({ a: 1 }, { a: 2, b: true })).toEqual({
      schemaVersion: 'diff/v1',
      operations: [
        { op: 'replace', path: '/a', before: 1, after: 2 },
        { op: 'add', path: '/b', after: true },
      ],
    });
  });
});
