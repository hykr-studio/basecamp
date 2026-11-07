// What a trigger means, without the database: when a schedule fires next, whether an event or a
// message matches, a condition's moving times, and how a run says what started it.
import type { AgentTrigger, DomainEventEnvelope } from '@hykr/contracts';
import { Cron } from 'croner';
import { matchesEvent } from '../events/subscriber.js';

/** A schedule may fire at most this often. */
export const MIN_INTERVAL_MS = 5 * 60_000;

/** An IANA zone this process knows, or undefined. */
export function knownZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The cron pattern in a zone, or why it is not one. */
function cronOf(pattern: string, zone: string): Cron | string {
  try {
    return new Cron(pattern, { timezone: zone, paused: true, mode: '5-part' });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Why this schedule cannot be used, or null: a bad pattern, a bad zone, or more often than 5 min. */
export function cronProblem(pattern: string, zone: string): string | null {
  if (!knownZone(zone)) return `"${zone}" is not a time zone`;
  const cron = cronOf(pattern, zone);
  if (typeof cron === 'string') return `"${pattern}" is not a schedule: ${cron}`;
  // Look a while ahead: the tightest gap between runs (a pattern like "*/2 9 * * *").
  const runs = cron.nextRuns(30, new Date());
  if (!runs.length) return `"${pattern}" never runs`;
  for (let i = 1; i < runs.length; i++)
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MS)
      return `"${pattern}" runs more often than every 5 minutes`;
  return null;
}

/** When this schedule fires next after `from`, in its zone. */
export function nextRun(pattern: string, zone: string, from: Date): Date | null {
  const cron = cronOf(pattern, zone);
  return typeof cron === 'string' ? null : cron.nextRun(from);
}

/** When a trigger is due first, from `now`: time triggers and conditions; null for the others. */
export function firstDue(t: AgentTrigger, businessZone: string, now: Date): Date | null {
  if (t.kind === 'once') return new Date(t.at);
  if (t.kind === 'recurring') return nextRun(t.cron, knownZone(t.timeZone) ?? businessZone, now);
  if (t.kind === 'condition') return now;
  return null;
}

/** After it fired at `now`: when it is due again (a missed time runs once, not once per miss). */
export function nextDue(t: AgentTrigger, businessZone: string, now: Date): Date | null {
  if (t.kind === 'recurring') return nextRun(t.cron, knownZone(t.timeZone) ?? businessZone, now);
  if (t.kind === 'condition') return new Date(now.getTime() + t.everyMinutes * 60_000);
  return null;
}

/* ── Conditions: `$now`, `$today` ─────────────────────────────────────────── */

const MOVING = /^\$(now|today)(?:([+-])(\d{1,5})([mhd]))?$/;

/** Is this a moving time (`$now`, `$today-7d`)? */
export const isMoving = (v: unknown): v is string => typeof v === 'string' && MOVING.test(v);

/** A moving time as of `now`: `$now…` an ISO instant, `$today…` a date in the business's zone. */
export function movingValue(v: string, now: Date, zone: string): string {
  const m = MOVING.exec(v);
  if (!m) return v;
  const [, base, sign, n, unit] = m;
  const ms = n
    ? Number(n) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 'm' | 'h' | 'd']
    : 0;
  const at = new Date(now.getTime() + (sign === '-' ? -ms : ms));
  if (base === 'now') return at.toISOString();
  return at.toLocaleDateString('sv', { timeZone: zone });
}

/** A condition's filters with every moving time replaced, as of `now`. */
export function resolveWhere(
  where: Readonly<Record<string, unknown>>,
  now: Date,
  zone: string,
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (isMoving(v)) return movingValue(v, now, zone);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(where) as Record<string, unknown>;
}

/* ── Events and messages ───────────────────────────────────────────────── */

/** Does an event trigger take this event, with the record as the owner sees it? */
export function eventMatches(
  t: Extract<AgentTrigger, { kind: 'event' }>,
  event: Pick<DomainEventEnvelope, 'name'>,
  row: unknown,
): boolean {
  if (!t.on.some((p) => matchesEvent(p, event.name))) return false;
  if (!t.where) return true;
  const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return Object.entries(t.where).every(([field, value]) => (record[field] ?? null) === value);
}

/** Words as a message trigger compares them: lower case, letters and digits of any script. */
const words = (s: string) => s.toLocaleLowerCase().normalize('NFC');

/** Does a message trigger take this text? Any message without `contains`; else one of its words. */
export function messageMatches(t: Extract<AgentTrigger, { kind: 'message' }>, text: string) {
  if (!t.contains?.length) return true;
  const said = words(text);
  return t.contains.some((w) => said.includes(words(w)));
}

/** Does a webhook trigger take this inbound event of its connection? */
export const webhookMatches = (
  t: Extract<AgentTrigger, { kind: 'webhook' }>,
  connectionId: string,
  type: string,
) => t.connectionId === connectionId && t.on.some((p) => p === '*' || matchesEvent(p, type));

/* ── How a run says what started it ────────────────────────────────────── */

/** A short line about a trigger, for the run log and the run's own message. */
export function triggerLabel(t: AgentTrigger | { kind: 'manual' }): string {
  switch (t.kind) {
    case 'once':
      return `once at ${t.at}`;
    case 'recurring':
      return `on the schedule "${t.cron}"${t.timeZone ? ` (${t.timeZone})` : ''}`;
    case 'event':
      return `on ${t.on.join(', ')}`;
    case 'condition':
      return `when a ${t.entity} matches its condition`;
    case 'message':
      return t.contains?.length
        ? `on a WhatsApp message with ${t.contains.map((w) => `"${w}"`).join(' or ')}`
        : 'on a WhatsApp message';
    case 'mention':
      return 'on an @-mention';
    case 'webhook':
      return `on a webhook (${t.on.join(', ')})`;
    case 'manual':
      return 'run now';
  }
}
