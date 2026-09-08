export type DecimalInput = string | number;

export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

export const MAX_DECIMAL_DIGITS = 30;
export const MAX_DECIMAL_SCALE = 12;

function pow10(power: number): bigint {
  if (!Number.isInteger(power) || power < 0) {
    throw new Error(`Invalid decimal scale: ${power}`);
  }
  return 10n ** BigInt(power);
}

export function parseDecimal(
  value: DecimalInput,
  options: { maxDigits?: number; maxScale?: number } = {}
): ExactDecimal {
  const input = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(input);
  if (!match || (!match[2] && !match[3])) {
    throw new Error(`Invalid decimal value: ${String(value)}`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const integer = (match[2] || '0').replace(/^0+(?=\d)/, '') || '0';
  const fraction = match[3] ?? '';
  const maxDigits = options.maxDigits ?? MAX_DECIMAL_DIGITS;
  const maxScale = options.maxScale ?? MAX_DECIMAL_SCALE;
  const digits = `${integer}${fraction}`.replace(/^0+/, '') || '0';

  if (digits.length > maxDigits) {
    throw new Error(`Decimal exceeds ${maxDigits} significant digits`);
  }
  if (fraction.length > maxScale) {
    throw new Error(`Decimal exceeds scale ${maxScale}`);
  }

  return normalizeExact({
    coefficient: sign * BigInt(`${integer}${fraction}` || '0'),
    scale: fraction.length,
  });
}

export function normalizeExact(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function decimalToString(value: ExactDecimal): string {
  const normalized = normalizeExact(value);
  const negative = normalized.coefficient < 0n;
  const absolute = negative ? -normalized.coefficient : normalized.coefficient;
  const digits = absolute.toString().padStart(normalized.scale + 1, '0');
  const integer = normalized.scale === 0
    ? digits
    : digits.slice(0, -normalized.scale) || '0';
  const fraction = normalized.scale === 0
    ? ''
    : digits.slice(-normalized.scale);
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

export function normalizeDecimal(value: DecimalInput): string {
  return decimalToString(parseDecimal(value));
}

function align(a: ExactDecimal, b: ExactDecimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.coefficient * pow10(scale - a.scale),
    b.coefficient * pow10(scale - b.scale),
    scale,
  ];
}

export function addDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const [left, right, scale] = align(a, b);
  return normalizeExact({ coefficient: left + right, scale });
}

export function subtractDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const [left, right, scale] = align(a, b);
  return normalizeExact({ coefficient: left - right, scale });
}

export function multiplyDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalizeExact({
    coefficient: a.coefficient * b.coefficient,
    scale: a.scale + b.scale,
  });
}

export function compareDecimal(a: ExactDecimal, b: ExactDecimal): number {
  const [left, right] = align(a, b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function maxDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return compareDecimal(a, b) >= 0 ? a : b;
}

export function minDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return compareDecimal(a, b) <= 0 ? a : b;
}

export function floorDivideDecimal(
  numerator: ExactDecimal,
  denominator: ExactDecimal
): bigint {
  if (denominator.coefficient === 0n) throw new Error('Division by zero');
  const left = numerator.coefficient * pow10(denominator.scale);
  const right = denominator.coefficient * pow10(numerator.scale);
  let quotient = left / right;
  const remainder = left % right;
  if (remainder !== 0n && (left < 0n) !== (right < 0n)) quotient -= 1n;
  return quotient;
}

export function isPositiveDecimal(value: ExactDecimal): boolean {
  return value.coefficient > 0n;
}

export const ZERO_DECIMAL: ExactDecimal = Object.freeze({
  coefficient: 0n,
  scale: 0,
});
