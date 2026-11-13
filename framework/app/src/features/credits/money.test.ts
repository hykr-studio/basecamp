import { describe, expect, it } from 'vitest';
import { entryDetail, formatCredits, meterQuantity, parseCredits } from './money';

describe('credits as money', () => {
  it('formats minor units in major units, and shows bare credits without a currency', () => {
    expect(formatCredits(12345, 'EUR')).toBe('€123.45');
    expect(formatCredits(-12345, 'EUR')).toBe('-€123.45');
    expect(formatCredits(500, 'JPY')).toBe('JP¥500');
    expect(formatCredits(42, null)).toBe('42');
    expect(formatCredits(42, 'not a currency')).toBe('not a currency 42');
  });

  it('formats in the reader’s language', () => {
    const hindi = new Intl.NumberFormat('hi-IN', { style: 'currency', currency: 'EUR' });
    expect(formatCredits(12345, 'EUR', 'hi')).toBe(hindi.format(123.45));
  });

  it('reads what a person typed as minor units, in the currency’s own decimals', () => {
    expect(parseCredits('12.5', 'EUR')).toBe(1250);
    expect(parseCredits(' 1,000 ', 'EUR')).toBe(100000);
    expect(parseCredits('500', 'JPY')).toBe(500);
    expect(parseCredits('1.234', 'KWD')).toBe(1234);
    expect(parseCredits('0', 'EUR')).toBeUndefined();
    expect(parseCredits('-5', 'EUR')).toBeUndefined();
    expect(parseCredits('abc', 'EUR')).toBeUndefined();
    expect(parseCredits('', 'EUR')).toBeUndefined();
    // More decimals than the currency has are refused, not rounded.
    expect(parseCredits('0.001', 'EUR')).toBeUndefined();
    expect(parseCredits('12.345', 'EUR')).toBeUndefined();
    expect(parseCredits('5.5', 'JPY')).toBeUndefined();
    expect(parseCredits('12', 'not a currency')).toBeUndefined();
  });

  it('shows voice in minutes', () => {
    expect(meterQuantity('voice_seconds', 61)).toBe('2 min');
    expect(meterQuantity('tokens', 12345)).toBe('12,345');
  });

  it('words a debit by its use, never by the note naming the meter in the code', () => {
    const use = { meter: 'tool_calls', label: 'Assistant actions', quantity: 1 };
    expect(entryDetail({ note: null, use })).toBe('Assistant actions: 1');
    // A debit read before the API worded it (or by an older API): its note is not shown.
    expect(entryDetail({ kind: 'debit', note: 'tool_calls × 1' })).toBe('');
    const voice = { meter: 'voice_seconds', label: 'वॉइस मिनट', quantity: 150 };
    expect(entryDetail({ note: null, use: voice })).toBe('वॉइस मिनट: 3 min');
    // A grant or a top-up keeps the words written with it.
    expect(entryDetail({ kind: 'grant', note: 'Welcome credits' })).toBe('Welcome credits');
    expect(entryDetail({ kind: 'topup', note: null })).toBe('');
  });
});
