import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  compareDecimal,
  decimalToString,
  floorDivideDecimal,
  multiplyDecimal,
  normalizeDecimal,
  parseDecimal,
  subtractDecimal,
} from './decimal.js';

describe('exact decimal arithmetic', () => {
  it('normalizes without binary floating point', () => {
    expect(normalizeDecimal('00012.3400')).toBe('12.34');
    expect(normalizeDecimal('.5000')).toBe('0.5');
    expect(normalizeDecimal('-0.000')).toBe('0');
    expect(() => normalizeDecimal('1e3')).toThrow(/Invalid decimal/);
  });

  it('adds, subtracts, multiplies, compares, and floor-divides exactly', () => {
    const a = parseDecimal('1.25');
    const b = parseDecimal('0.5');
    expect(decimalToString(addDecimal(a, b))).toBe('1.75');
    expect(decimalToString(subtractDecimal(a, b))).toBe('0.75');
    expect(decimalToString(multiplyDecimal(a, b))).toBe('0.625');
    expect(compareDecimal(a, b)).toBe(1);
    expect(floorDivideDecimal(parseDecimal('5'), parseDecimal('2'))).toBe(2n);
    expect(floorDivideDecimal(parseDecimal('-5'), parseDecimal('2'))).toBe(-3n);
  });

  it('enforces precision and scale limits', () => {
    expect(() => parseDecimal(`1.${'0'.repeat(13)}`)).toThrow(/scale/);
    expect(() => parseDecimal('1234567890123456789012345678901')).toThrow(/digits/);
  });
});
