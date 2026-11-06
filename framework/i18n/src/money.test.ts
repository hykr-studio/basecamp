import { describe, expect, it } from 'vitest';
import { currencyExponent, moneyText, spokenMoney } from './index.js';

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

  it("uses the language's grouping", () => {
    expect(moneyText({ minor: 12345678950, currency: 'EUR' }, 'hi')).toContain('12,34,56,789.50');
  });

  it('says the currency by name', () => {
    expect(spokenMoney({ minor: 250, currency: 'EUR' }, 'en')).toBe('2.50 euros');
  });
});
