import { describe, expect, it } from 'vitest';
import { formatCredits, meterQuantity, minorPerMajor, toMinor } from './money';

describe('credits as money', () => {
  it('knows each currency’s minor units', () => {
    expect(minorPerMajor('EUR')).toBe(100);
    expect(minorPerMajor('JPY')).toBe(1);
    expect(minorPerMajor('KWD')).toBe(1000);
  });

  it('formats minor units in major units, and shows bare credits without a currency', () => {
    expect(formatCredits(12345, 'EUR')).toBe('€123.45');
    expect(formatCredits(500, 'JPY')).toBe('¥500');
    expect(formatCredits(42, null)).toBe('42');
  });

  it('reads what a person typed as minor units', () => {
    expect(toMinor('12.5', 'EUR')).toBe(1250);
    expect(toMinor('1,000', 'EUR')).toBe(100000);
    expect(toMinor('0', 'EUR')).toBeUndefined();
    expect(toMinor('abc', 'EUR')).toBeUndefined();
    expect(toMinor('0.001', 'EUR')).toBeUndefined();
  });

  it('shows voice in minutes', () => {
    expect(meterQuantity('voice_seconds', 61)).toBe('2 min');
    expect(meterQuantity('tokens', 12345)).toBe('12,345');
  });
});
