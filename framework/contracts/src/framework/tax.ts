import { z } from 'zod';
import { CurrencyMismatch, Money, sumMoney } from './money.js';

/**
 * Tax as the framework carries it: lines an application's own function computes. The framework
 * knows no rates, names, rules or places; it checks what the function returns (whole minor
 * units, one currency, a code once) and adds it up.
 */
export const TaxLine = z.object({
  /** The application's code for the component, unique in one result: 'vat', 'levy.city'. */
  code: z.string().min(1).max(60),
  /** What a document prints for it. */
  label: z.string().max(120).optional(),
  /** The amount it is computed on. */
  basis: Money,
  /** Its rate in basis points (1800 is 18%), for display only. */
  rateBp: z.number().int().min(0).optional(),
  amount: Money,
  /** Already inside the prices (tax-inclusive): shown, not added to the total. */
  included: z.boolean().optional(),
});
export type TaxLine = z.infer<typeof TaxLine>;

/** One priced line as a tax function sees it: its amount, and whatever the application adds. */
export interface Taxable {
  amount: Money;
}

/** What a tax function knows besides the lines. */
export interface TaxContext {
  currency: string;
  /** When the document is dated (a rate change), default now. */
  at: Date;
}

/** The application's tax computation, named so documents and tests can say which one ran. */
export interface TaxFunction<L extends Taxable = Taxable> {
  name: string;
  compute(lines: readonly L[], ctx: TaxContext): readonly TaxLine[];
}

export function defineTaxFunction<L extends Taxable>(fn: TaxFunction<L>): TaxFunction<L> {
  if (!/^[a-z][a-z0-9_.-]*$/.test(fn.name))
    throw new Error(`Tax function "${fn.name}": name it in lower case, dotted`);
  return fn;
}

/** The lines' sum, the tax lines, the tax added and the total. */
export interface TaxTotals {
  subtotal: Money;
  taxLines: TaxLine[];
  /** The tax the total adds (included lines are not added). */
  taxTotal: Money;
  total: Money;
}

/**
 * Run the application's tax function over the lines and add it all up. Its lines are checked:
 * money in the document's currency, whole minor units, each code once. A wrong line throws.
 */
export function applyTax<L extends Taxable>(
  fn: TaxFunction<L>,
  lines: readonly L[],
  opts: { currency: string; at?: Date },
): TaxTotals {
  const { currency } = opts;
  const subtotal = sumMoney(
    lines.map((l) => l.amount),
    currency,
  );
  const taxLines = fn.compute(lines, { currency, at: opts.at ?? new Date() }).map((line) => {
    const parsed = TaxLine.safeParse(line);
    if (!parsed.success)
      throw new Error(`Tax function "${fn.name}" returned a bad line: ${parsed.error.message}`);
    for (const m of [parsed.data.basis, parsed.data.amount])
      if (m.currency !== currency) throw new CurrencyMismatch(currency, m.currency);
    return parsed.data;
  });
  const codes = new Set<string>();
  for (const line of taxLines) {
    if (codes.has(line.code))
      throw new Error(`Tax function "${fn.name}" returned the code "${line.code}" twice`);
    codes.add(line.code);
  }
  const taxTotal = sumMoney(
    taxLines.filter((l) => !l.included).map((l) => l.amount),
    currency,
  );
  return { subtotal, taxLines, taxTotal, total: sumMoney([subtotal, taxTotal], currency) };
}
