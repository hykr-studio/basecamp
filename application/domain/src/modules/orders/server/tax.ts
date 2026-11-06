import { defineTaxFunction, type Money, mulDiv, sumMoney } from '@hykr/contracts';

/** A priced line as the orders tax sees it. */
export interface TaxedLine {
  amount: Money;
  /** Basis points: 1800 is 18%. */
  taxRateBp: number;
}

/**
 * The orders module's tax: each line carries its own percentage; lines at the same rate are
 * added up and taxed once, rounded half up, so a long order does not gather rounding from every
 * line. One tax line per rate. A product with real tax rules writes its own function.
 */
export const percentageTax = defineTaxFunction<TaxedLine>({
  name: 'orders.percentage',
  compute: (lines, { currency }) => {
    const rates = [...new Set(lines.map((l) => l.taxRateBp).filter((r) => r > 0))].sort(
      (a, b) => a - b,
    );
    return rates.map((rateBp) => {
      const basis = sumMoney(
        lines.filter((l) => l.taxRateBp === rateBp).map((l) => l.amount),
        currency,
      );
      return {
        code: `tax.${rateBp}`,
        label: `Tax ${rateBp / 100}%`,
        basis,
        rateBp,
        amount: { minor: mulDiv(basis.minor, rateBp, 10_000, 'half-up'), currency },
      };
    });
  },
});
