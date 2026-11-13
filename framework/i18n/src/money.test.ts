import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currencyExponent,
  defineLanguages,
  knownCurrency,
  moneyText,
  resetLanguages,
  setLanguages,
  spokenMoney,
} from './index.js';

afterEach(resetLanguages);

describe('money words', () => {
  it("knows each currency's minor-unit exponent from Intl", () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('BHD')).toBe(3);
  });

  it('formats minor units in the currency, without floats', () => {
    expect(moneyText({ minor: 123450, currency: 'EUR' }, 'en')).toBe('€1,234.50');
    expect(moneyText({ minor: 1235, currency: 'JPY' }, 'en')).toBe('JP¥1,235');
    expect(moneyText({ minor: 1234500, currency: 'BHD' }, 'en')).toMatch(/1,234\.500/);
    expect(moneyText({ minor: -5, currency: 'EUR' }, 'en')).toBe('-€0.05');
    // Past what a float keeps to the cent.
    expect(moneyText({ minor: 9007199254740991, currency: 'EUR' }, 'en')).toBe(
      '€90,071,992,547,409.91',
    );
  });

  it("uses the language's grouping, in its declared locale", () => {
    setLanguages(defineLanguages({ hi: { name: 'हिंदी', english: 'Hindi', locale: 'hi-IN' } }));
    expect(moneyText({ minor: 12345678950, currency: 'EUR' }, 'hi')).toContain('12,34,56,789.50');
  });

  it('says the currency by name', () => {
    expect(spokenMoney({ minor: 250, currency: 'EUR' }, 'en')).toBe('2.50 euros');
  });
});

describe('known currencies', () => {
  it('knows what Intl lists, and XXX (no currency)', () => {
    for (const code of ['EUR', 'JPY', 'BHD', 'INR', 'XXX'])
      expect(knownCurrency(code), code).toBe(true);
    // Well formed, but no currency: ISO's testing code is not one Intl lists either.
    for (const code of ['ABC', 'QZX', 'XTS', 'eur', 'EURO', ''])
      expect(knownCurrency(code), code).toBe(false);
  });

  it('formatting stays lenient: a stored made-up code still reads', () => {
    expect(currencyExponent('ABC')).toBe(2);
    expect(moneyText({ minor: 100, currency: 'ABC' }, 'en')).toContain('1.00');
  });

  it('where the runtime cannot list currencies (Hermes), the format is the check', async () => {
    const intl = Intl as { supportedValuesOf?: unknown };
    const saved = intl.supportedValuesOf;
    vi.resetModules();
    intl.supportedValuesOf = undefined;
    try {
      const fresh = await import('./money.js');
      expect(fresh.knownCurrency('ABC')).toBe(true);
      expect(fresh.knownCurrency('abc')).toBe(false);
    } finally {
      intl.supportedValuesOf = saved;
    }
  });
});
