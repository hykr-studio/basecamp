import { z } from 'zod';

/**
 * Money, as the framework moves it: a whole number of the currency's minor units and the
 * currency itself (ISO 4217). The framework assumes no currency: a business's default lives in
 * its settings and a deployment's default in its environment. Formatting goes through Intl,
 * which also knows each currency's minor-unit exponent.
 */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'An ISO 4217 currency code, upper case: "EUR"');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.object({
  /** Whole minor units of the currency (an integer). */
  minor: z.number().int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;
