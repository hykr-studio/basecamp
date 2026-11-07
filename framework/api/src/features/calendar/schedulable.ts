// Schedulable records on the server: which entities carry the trait, whose calendars a record
// belongs on (from its raw row), and what a calendar shows of it (from its read, projected for
// whoever it is shown to).
import { createHash } from 'node:crypto';
import {
  type Address,
  addressText,
  type SchedulableTrait,
  schedulableOf,
  schedulableProblems,
} from '@hykr/contracts';
import { type AnyEntityDef, entityDef, entityDefs } from '@hykr/core';
import { getTableColumns, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { uidHost } from './settings.js';

type Values = Record<string, unknown>;

/** A schedulable entity: its definition and its trait. */
export interface Schedulable {
  def: AnyEntityDef;
  trait: SchedulableTrait;
}

/** The served entity of this name, if it is schedulable. */
export function schedulable(name: string): Schedulable | undefined {
  const def = entityDef(name);
  const trait = def ? schedulableOf(def.spec) : undefined;
  return def && trait ? { def, trait } : undefined;
}

/** Every served schedulable entity. */
export const schedulables = (): Schedulable[] =>
  entityDefs().flatMap((def) => {
    const trait = schedulableOf(def.spec);
    return trait ? [{ def, trait }] : [];
  });

/** The owner column's key: the default `people`. */
function ownerKey(def: AnyEntityDef): string | undefined {
  const columns = getTableColumns(def.table) as Record<string, PgColumn>;
  // The owner column is the one the entity scopes 'own' by; tables name it ownerId.
  return 'ownerId' in columns ? 'ownerId' : undefined;
}

/** The columns (table keys) that hold whose calendars a record belongs on. */
export function peopleKeys(s: Schedulable): string[] {
  const keys = s.trait.people?.length ? [...s.trait.people] : [ownerKey(s.def)].filter(Boolean);
  return keys as string[];
}

/**
 * What is wrong with the served schedulable entities: fields their read schemas lack, people
 * columns their tables lack. Checked when the server starts.
 */
export function checkSchedulables(): void {
  const problems = schedulables().flatMap((s) => {
    const columns = getTableColumns(s.def.table) as Record<string, PgColumn>;
    const keys = peopleKeys(s);
    return [
      ...schedulableProblems(s.def.spec),
      ...(keys.length
        ? []
        : [`${s.def.name}: name the people columns (traits.schedulable.people)`]),
      ...keys
        .filter((k) => !columns[k])
        .map(
          (k) => `${s.def.name}: the schedulable trait's people column "${k}" is not in its table`,
        ),
    ];
  });
  if (problems.length) throw new Error(`Schedulable entities:\n- ${problems.join('\n- ')}`);
}

/** The people (user ids) a raw row names. */
export function peopleOf(s: Schedulable, row: Values): string[] {
  const out = new Set<string>();
  for (const key of peopleKeys(s)) {
    const v = row[key];
    if (typeof v === 'string' && v) out.add(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x) out.add(x);
  }
  return [...out];
}

/** SQL: the row names this person among its people. */
export function namesPerson(s: Schedulable, userId: string): SQL {
  const columns = getTableColumns(s.def.table) as Record<string, PgColumn>;
  const parts = peopleKeys(s).flatMap((key) => {
    const c = columns[key];
    if (!c) return [];
    return c.columnType === 'PgArray' ? [sql`${userId} = any(${c})`] : [sql`${c} = ${userId}`];
  });
  return parts.length ? sql.join(parts, sql` or `) : sql`false`;
}

/** What a calendar shows of a record. */
export interface EventContent {
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  description?: string;
}

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'string') return v.trim().slice(0, max) || undefined;
  if (v && typeof v === 'object' && typeof (v as Address).line1 === 'string')
    return addressText(v as Address).slice(0, max) || undefined;
  return undefined;
};

/**
 * The event a read record makes (already projected for the reader), or null when it is off
 * calendars: hidden by its state, or without a valid start and end.
 */
export function contentOf(trait: SchedulableTrait, read: Values): EventContent | null {
  if (trait.hiddenWhen?.in.includes(read[trait.hiddenWhen.field])) return null;
  const start = Date.parse(String(read[trait.startsAt] ?? ''));
  const end = Date.parse(String(read[trait.endsAt] ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    title: text(read[trait.title], 500) ?? '(untitled)',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    ...(trait.location && text(read[trait.location], 1000)
      ? { location: text(read[trait.location], 1000) }
      : {}),
    ...(trait.description && text(read[trait.description], 8000)
      ? { description: text(read[trait.description], 8000) }
      : {}),
  };
}

/** A hash of what is sent: unchanged content sends nothing. */
export const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A record's event id in a provider: Google's base32hex alphabet, the same for every person. */
export const googleEventId = (tenantId: string, entity: string, id: string) =>
  `bc${createHash('sha256').update(`${tenantId}:${entity}:${id}`).digest('hex').slice(0, 40)}`;

/** A record's iCalendar UID: the same in invites and feeds. */
export const uidOf = (entity: string, id: string) => `${entity}-${id}@${uidHost()}`;
