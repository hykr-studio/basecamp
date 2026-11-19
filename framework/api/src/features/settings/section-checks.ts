// What a settings section's schema cannot check (docs/decisions/H2.md): names that must be
// declared (an approval level, a capability, an SLA), people who must be in the business, open
// hours that overlap, bands no amount reaches. Each check runs in the write's transaction after
// the section parses; a problem refuses the write (400 settings_invalid). The framework's own are
// below; an application adds checks for its own sections (`contributes.settingsChecks`).
import {
  type ApprovalSettings,
  approvalLevels,
  type BusinessHours,
  type Catalog,
  capabilities,
  createHookRegistry,
  type EditableSettingsKey,
  type EditableSettingsValue,
  type GeneralSettings,
  type Money,
  type MoneySettings,
  minutesOf,
  type Principal,
  type SharesSettings,
  type SlaSettings,
  statesOf,
  WEEKDAYS,
} from '@hykr/contracts';
import { type Tx, zoneName } from '@hykr/core';
import { membershipOf } from '@hykr/db';
import { knownCurrency } from '@hykr/i18n';

declare module '@hykr/contracts' {
  interface Contributions {
    settingsChecks: readonly SettingsCheck[];
  }
}

/** What a check may look at besides the value. */
export interface SettingsCheckContext {
  /** The write's transaction: read what the check needs through it. */
  tx: Tx;
  tenantId: string;
  /** Who is changing it. */
  principal: Principal;
  /** What this server serves: its entities, commands and modules. */
  catalog: Catalog;
}

/** A check of one section's new value: the problems it finds, none when it is fine. */
export interface SettingsCheck<K extends EditableSettingsKey = EditableSettingsKey> {
  /** Unique: 'approvals.approvers'. */
  name: string;
  /** The section it checks: an editable section, or `general`. */
  section: K;
  check(
    value: EditableSettingsValue<K>,
    ctx: SettingsCheckContext,
  ): readonly string[] | Promise<readonly string[]>;
}

const NAME = /^[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/;

/** A check, with its name checked. Register it by contributing it (`settingsChecks`). */
export function defineSettingsCheck<K extends EditableSettingsKey>(
  check: SettingsCheck<K>,
): SettingsCheck<K> {
  if (!NAME.test(check.name))
    throw new Error(`Settings check "${check.name}": name it with dotted words ('orders.bands')`);
  return check;
}

/** Every settings check, in registration order. Collects `contributes.settingsChecks`. */
export const settingsChecks = createHookRegistry<SettingsCheck>(
  'settings check',
  (c) => defineSettingsCheck(c).name,
  { collects: 'settingsChecks' },
);

/* ── The framework's own checks ────────────────────────────────────────── */

const currencyProblem = (path: string, m: Money) =>
  knownCurrency(m.currency) ? [] : [`${path}.currency: "${m.currency}" is not a currency`];

/** The most bands one key may have. */
const MAX_BANDS = 50;

/**
 * Bands are tried in order, the first that fits wins: a band after one without `upTo`, or after
 * one in the same currency whose `upTo` is at least its own, is never reached.
 */
export function unreachableBands(
  bounds: readonly (Money | undefined)[],
  path: (i: number) => string,
): string[] {
  const problems: string[] = [];
  bounds.forEach((upTo, i) => {
    const earlier = bounds.slice(0, i);
    const taken = earlier.some(
      (e) => e === undefined || (upTo && e.currency === upTo.currency && e.minor >= upTo.minor),
    );
    if (taken) problems.push(`${path(i)}: no amount reaches this band (an earlier one takes it)`);
  });
  return problems;
}

/** Approvals: declared levels, approvers who can decide, bands an amount reaches. */
export async function approvalsProblems(
  value: ApprovalSettings,
  ctx: Pick<SettingsCheckContext, 'tx' | 'tenantId'>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, override] of Object.entries(value.levels)) {
    const level = approvalLevels.get(name);
    if (!level) {
      problems.push(`approvals.levels.${name}: no approval level is called this`);
      continue;
    }
    if (override.parks === false && !level.policy?.tenantMayLoosen)
      problems.push(`approvals.levels.${name}.parks: this level always waits; it cannot be off`);
  }
  for (const [key, money] of Object.entries(value.thresholds))
    problems.push(...currencyProblem(`approvals.thresholds.${key}`, money));
  for (const [key, bands] of Object.entries(value.bands)) {
    const at = (i: number) => `approvals.bands.${key}[${i}]`;
    if (bands.length > MAX_BANDS) problems.push(`approvals.bands.${key}: at most ${MAX_BANDS}`);
    problems.push(
      ...unreachableBands(
        bands.map((b) => b.upTo),
        at,
      ),
    );
    for (const [i, band] of bands.entries()) {
      if (band.upTo) problems.push(...currencyProblem(`${at(i)}.upTo`, band.upTo));
      const who = band.approver;
      if ('capability' in who) {
        if (!capabilities.has(who.capability))
          problems.push(`${at(i)}.approver: nobody defines the capability "${who.capability}"`);
        continue;
      }
      // A named approver decides alone: a member of this business's team. Another business's
      // person and one who does not exist get the same answer.
      const member = await membershipOf(ctx.tx, who.userId, ctx.tenantId);
      if (!member?.roles.some((r) => r !== 'customer'))
        problems.push(`${at(i)}.approver: "${who.userId}" is not on this business's team`);
    }
  }
  return problems;
}

/** Money: a currency the runtime knows, bands that go up. */
export function moneyProblems(value: MoneySettings): string[] {
  const problems: string[] = [];
  if (value.currency && !knownCurrency(value.currency))
    problems.push(`money.currency: "${value.currency}" is not a currency`);
  for (const [key, m] of Object.entries(value.amounts))
    problems.push(...currencyProblem(`money.amounts.${key}`, m));
  for (const [key, bounds] of Object.entries(value.bands)) {
    bounds.forEach((m, i) => {
      problems.push(...currencyProblem(`money.bands.${key}[${i}]`, m));
    });
    const last = new Map<string, number>();
    bounds.forEach((m, i) => {
      const before = last.get(m.currency);
      if (before !== undefined && m.minor <= before)
        problems.push(`money.bands.${key}[${i}]: each bound is above the one before it`);
      last.set(m.currency, m.minor);
    });
  }
  return problems;
}

/** Business hours: a day's intervals do not overlap (open time would count twice), no repeats. */
export function businessHoursProblems(value: BusinessHours): string[] {
  const problems: string[] = [];
  for (const day of WEEKDAYS) {
    const list = (value.week as Record<string, { from: string; to: string }[] | undefined>)?.[day];
    if (!list) continue;
    const spans = list
      .map((i) => [minutesOf(i.from), minutesOf(i.to)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++)
      if (spans[i][0] < spans[i - 1][1])
        problems.push(`businessHours.week.${day}: open intervals overlap`);
  }
  const seen = new Set<string>();
  for (const date of value.holidays) {
    if (seen.has(date)) problems.push(`businessHours.holidays: ${date} is listed twice`);
    seen.add(date);
  }
  return problems;
}

/** The SLAs this server's entities declare, by name. */
export function declaredSlas(catalog: Catalog): Set<string> {
  const names = new Set<string>();
  for (const spec of Object.values(catalog.entities))
    for (const sla of statesOf(spec)?.slas ?? []) names.add(sla.name);
  return names;
}

/** SLAs: every name is an SLA an entity declares (a typo would change nothing). */
export function slaProblems(value: SlaSettings, catalog: Catalog): string[] {
  const declared = declaredSlas(catalog);
  const problems: string[] = [];
  for (const name of Object.keys(value.within))
    if (!declared.has(name)) problems.push(`sla.within.${name}: no SLA is called this`);
  const seen = new Set<string>();
  for (const name of value.off) {
    if (!declared.has(name)) problems.push(`sla.off: no SLA is called "${name}"`);
    else if (seen.has(name)) problems.push(`sla.off: "${name}" is listed twice`);
    seen.add(name);
  }
  return problems;
}

/** Share links: the usual lifetime within the longest, a session within the longest too. */
export function sharesProblems(value: SharesSettings): string[] {
  const problems: string[] = [];
  if (value.defaultDays > value.maxDays)
    problems.push('shares.defaultDays: at most maxDays (the longest a link may last)');
  if (value.sessionHours > value.maxDays * 24)
    problems.push('shares.sessionHours: at most maxDays (a session never outlasts its link)');
  return problems;
}

/**
 * The business's own zone, read the same way by Intl and Postgres (`zoneName`, docs/decisions/
 * X2.md): the schema has refused offsets, abbreviations and names Intl does not know; Postgres
 * must know it too, with the same offsets, or periods computed in SQL would disagree.
 */
export async function timeZoneProblems(
  value: GeneralSettings,
  { tx }: Pick<SettingsCheckContext, 'tx'>,
): Promise<string[]> {
  if (value.timeZone === undefined || (await zoneName(tx, value.timeZone))) return [];
  return [
    `general.timeZone: "${value.timeZone}" is not a time zone this server can use (give UTC or an IANA name such as Europe/Berlin)`,
  ];
}

/** The framework's checks of its own sections. */
export const frameworkSettingsChecks: readonly SettingsCheck[] = [
  defineSettingsCheck({
    name: 'approvals.policy',
    section: 'approvals',
    check: (value, ctx) => approvalsProblems(value, ctx),
  }),
  defineSettingsCheck({ name: 'money.values', section: 'money', check: moneyProblems }),
  defineSettingsCheck({
    name: 'businessHours.calendar',
    section: 'businessHours',
    check: businessHoursProblems,
  }),
  defineSettingsCheck({
    name: 'sla.names',
    section: 'sla',
    check: (value, { catalog }) => slaProblems(value, catalog),
  }),
  defineSettingsCheck({ name: 'shares.lifetimes', section: 'shares', check: sharesProblems }),
  defineSettingsCheck({ name: 'general.timeZone', section: 'general', check: timeZoneProblems }),
] as SettingsCheck[];
