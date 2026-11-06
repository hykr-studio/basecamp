import {
  type AuthorizeResult,
  CurrencyCode,
  CurrencyMismatch,
  type EntitySpec,
  type MoneyTrait,
  resolveMoneyInput,
  type WriteAction,
} from '@hykr/contracts';
import { deny, RuleDenied } from '../authorize.js';
import type { EntityPlugin } from '../hooks.js';

type Values = Record<string, unknown>;

const traitOf = (spec: EntitySpec): MoneyTrait | undefined => spec.traits?.money;
const currencyKeyOf = (trait: MoneyTrait) => trait.currency ?? 'currency';
const given = (v: unknown) => v !== undefined && v !== null;

/**
 * The currency a write's money is in, or a refusal: amounts in two currencies, a change of the
 * record's currency, no currency at all on a create, an amount the currency cannot hold.
 */
export function moneyCurrency(
  trait: MoneyTrait,
  action: WriteAction,
  row: Values | null,
  input: Values | null,
): { currency: string } | AuthorizeResult {
  const key = currencyKeyOf(trait);
  const stored = row && typeof row[key] === 'string' ? (row[key] as string) : undefined;
  const named = input && typeof input[key] === 'string' ? (input[key] as string) : undefined;
  if (action === 'update' && named !== undefined && stored !== undefined && named !== stored)
    return deny('currency_fixed', `A record's currency cannot change (it is ${stored})`);
  const seen = new Set<string>();
  if (named !== undefined) seen.add(named);
  for (const field of trait.fields) {
    const v = input?.[field];
    if (v && typeof v === 'object' && typeof (v as Values).currency === 'string')
      seen.add((v as Values).currency as string);
  }
  if (stored !== undefined) seen.add(stored);
  if (seen.size > 1)
    return deny(
      'currency_mismatch',
      `Every amount of a record is in one currency, not ${[...seen].join(' and ')}`,
    );
  const currency = [...seen][0];
  if (action === 'delete') return { currency: currency ?? '' };
  if (currency === undefined || !CurrencyCode.safeParse(currency).success)
    return deny('currency_required', 'Say which currency the amounts are in');
  for (const field of trait.fields) {
    const v = input?.[field];
    if (!given(v)) continue;
    try {
      resolveMoneyInput(v as never, currency);
    } catch (e) {
      if (e instanceof CurrencyMismatch)
        return deny('currency_mismatch', `Every amount of a record is in ${currency}`);
      return deny('money_invalid', `${field}: ${(e as Error).message}`);
    }
  }
  return { currency };
}

const refused = (r: { currency: string } | AuthorizeResult): r is AuthorizeResult =>
  'decision' in r;

/**
 * Money on an entity with the `money` trait: stored as whole minor units beside one currency
 * column, read as `Money` (`{ minor, currency }`), written as `MoneyInput` (minor units, or a
 * decimal string in the record's currency). A write whose amounts disagree on the currency,
 * that changes a record's currency, or that names none on a create, is refused.
 */
export const moneyPlugin: EntityPlugin = {
  name: 'money',
  appliesTo: (spec) => traitOf(spec) !== undefined,
  // CRUD: refuse at the decision, so the refusal is audited before anything runs.
  decide: (_p, action, row, input, { spec }) => {
    const trait = traitOf(spec);
    if (!trait || action === 'delete') return null;
    const r = moneyCurrency(trait, action, row, input);
    return refused(r) ? r : null;
  },
  toValues: (values, { action, row, input }, { spec }) => {
    const trait = traitOf(spec);
    if (!trait) return values;
    // Commands write through the repository without a decision: the same checks, here.
    const r = moneyCurrency(trait, action, row, input);
    if (refused(r)) throw new RuleDenied(r);
    const out: Values = { ...values };
    for (const field of trait.fields) {
      const v = out[field];
      if (v === undefined) continue;
      out[field] = v === null ? null : resolveMoneyInput(v as never, r.currency).minor;
    }
    const key = currencyKeyOf(trait);
    if (action === 'create') out[key] = r.currency;
    else delete out[key];
    return out;
  },
  toJson: (row, { spec }) => {
    const trait = traitOf(spec);
    if (!trait) return row;
    const currency = row[currencyKeyOf(trait)];
    const out: Values = { ...row };
    for (const field of trait.fields) {
      const v = row[field];
      if (v === undefined || v === null || typeof v === 'object') continue;
      out[field] = { minor: Number(v), currency };
    }
    return out;
  },
};
