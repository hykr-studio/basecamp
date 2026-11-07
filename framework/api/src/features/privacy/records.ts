// Records modules declare as personal data (the `privacy` trait): found by the subject's ids,
// exported as their personal fields, and deleted, anonymised or kept when the person is
// forgotten or their period runs out. Nothing here loads Nest.
import {
  type PrivacyTrait,
  privacyOf,
  privacyTraitProblems,
  subjectColumnsOf,
} from '@hykr/contracts';
import { type AnyEntityDef, type Conn, entityDefs, type Tx, toJson } from '@hykr/core';
import {
  and,
  type Column,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import type { ErasedRecords } from '../../hooks.js';
import type { RetentionTarget } from './registry.js';
import type { Identities } from './subject.js';

type Values = Record<string, unknown>;

/** An entity whose records are someone's personal data, with its trait. */
export interface PersonalEntity {
  def: AnyEntityDef;
  trait: PrivacyTrait;
}

/** Every served entity with a privacy trait, by plural. */
export function personalEntities(): PersonalEntity[] {
  return entityDefs()
    .flatMap((def) => {
      const trait = privacyOf(def.spec);
      return trait ? [{ def, trait }] : [];
    })
    .sort((a, b) => a.def.plural.localeCompare(b.def.plural));
}

const columnsOf = (def: AnyEntityDef) =>
  getTableColumns(def.table as Table) as Record<string, Column>;

/**
 * What is wrong with the traits against their tables: a column that is not there, an anonymised
 * NOT NULL field with neither a replacement nor a default, a retention date column that is not
 * there or not a date, two rules of one name.
 */
export function personalEntityProblems(): string[] {
  const problems: string[] = [];
  const rules = new Map<string, string>();
  for (const { def, trait } of personalEntities()) {
    problems.push(...privacyTraitProblems(def.name, trait));
    const cols = columnsOf(def);
    const at = `Entity ${def.name}, trait privacy`;
    if (!cols.id || !cols.tenantId) problems.push(`${at}: its table needs id and tenantId`);
    for (const key of subjectColumnsOf(trait))
      if (!cols[key]) problems.push(`${at}: subject column "${key}" is not in its table`);
    for (const key of trait.fields) {
      const col = cols[key];
      if (!col) {
        problems.push(`${at}: field "${key}" is not in its table`);
        continue;
      }
      const anonymised = trait.erase === 'anonymise' || trait.retention?.action === 'anonymise';
      const replaced = trait.replace && key in trait.replace;
      if (anonymised && col.notNull && !col.hasDefault && !replaced)
        problems.push(`${at}: "${key}" cannot be empty (NOT NULL): give replace.${key}`);
    }
    const r = trait.retention;
    if (r) {
      const from = cols[r.from ?? 'createdAt'];
      if (!from) problems.push(`${at}: retention counts from "${r.from}", not in its table`);
      else if (from.dataType !== 'date')
        problems.push(`${at}: retention counts from "${r.from ?? 'createdAt'}", not a date`);
      const taken = rules.get(r.name);
      if (taken) problems.push(`${at}: the retention rule "${r.name}" is also ${taken}'s`);
      rules.set(r.name, def.name);
    }
  }
  return problems;
}

/** The records of this entity that are this person's, in their business. */
function theirs(pe: PersonalEntity, ids: Identities): SQL | undefined {
  const cols = columnsOf(pe.def);
  const match = (keys: readonly string[] | undefined, values: readonly string[]) =>
    values.length ? (keys ?? []).map((k) => inArray(cols[k] as Column, [...values])) : [];
  const any = [
    ...match(pe.trait.subject.user, ids.userId ? [ids.userId] : []),
    ...match(pe.trait.subject.customer, ids.customerIds),
    ...match(pe.trait.subject.contact, ids.contactIds),
  ];
  if (!any.length) return undefined;
  return and(eq(cols.tenantId as Column, ids.tenantId), or(...any)) as SQL;
}

/** The record as the person's export shows it: its id, dates and personal fields. */
function personalView(pe: PersonalEntity, row: Values): Values {
  const json = (toJson(row) ?? {}) as Values;
  const out: Values = { id: json.id };
  for (const key of pe.trait.fields) out[key] = json[key] ?? null;
  if ('createdAt' in json) out.createdAt = json.createdAt;
  if ('updatedAt' in json) out.updatedAt = json.updatedAt;
  return out;
}

/** Each entity's records of this person, by plural (entities with none are left out). */
export async function exportRecords(
  conn: Conn,
  ids: Identities,
): Promise<Record<string, Values[]>> {
  const out: Record<string, Values[]> = {};
  for (const pe of personalEntities()) {
    const where = theirs(pe, ids);
    if (!where) continue;
    const rows = (await conn
      .select()
      .from(pe.def.table as Table)
      .where(where)) as Values[];
    if (rows.length) out[pe.def.plural] = rows.map((r) => personalView(pe, r));
  }
  return out;
}

/** What anonymising writes: each field's replacement, its default, or null. */
function blanks(pe: PersonalEntity): Values {
  const cols = columnsOf(pe.def);
  const out: Values = {};
  for (const key of pe.trait.fields) {
    if (pe.trait.replace && key in pe.trait.replace) out[key] = pe.trait.replace[key];
    else if (cols[key]?.notNull && cols[key]?.hasDefault) out[key] = sql`DEFAULT`;
    else out[key] = null;
  }
  return out;
}

/** What happened to one entity's records. */
export interface RecordsOutcome {
  deleted?: number;
  anonymised?: number;
  kept?: number;
  keepReason?: string;
}

/** Delete or blank these records (in their business), and say which copies to redact. */
async function apply(
  tx: Tx,
  pe: PersonalEntity,
  where: SQL,
  action: 'delete' | 'anonymise',
): Promise<ErasedRecords | null> {
  const cols = columnsOf(pe.def);
  const table = pe.def.table as Table;
  const changed =
    action === 'delete'
      ? await tx
          .delete(table)
          .where(where)
          .returning({ id: cols.id as never })
      : await tx
          .update(table)
          .set(blanks(pe) as never)
          .where(where)
          .returning({ id: cols.id as never });
  const ids = changed.map((r) => String((r as { id: unknown }).id));
  return ids.length
    ? { type: pe.def.name, ids, fields: pe.trait.fields, deleted: action === 'delete' }
    : null;
}

/**
 * Forget this person in every declared entity: delete, anonymise or keep (counted, with the
 * reason) as each trait says.
 */
export async function eraseRecords(
  tx: Tx,
  ids: Identities,
): Promise<{ outcome: Record<string, RecordsOutcome>; erased: ErasedRecords[] }> {
  const outcome: Record<string, RecordsOutcome> = {};
  const erased: ErasedRecords[] = [];
  for (const pe of personalEntities()) {
    const where = theirs(pe, ids);
    if (!where) continue;
    if (pe.trait.erase === 'keep') {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(pe.def.table as Table)
        .where(where);
      if (row?.n)
        outcome[pe.def.plural] = { kept: row.n, keepReason: pe.trait.keepReason ?? 'kept' };
      continue;
    }
    const done = await apply(tx, pe, where, pe.trait.erase);
    if (!done) continue;
    erased.push(done);
    outcome[pe.def.plural] =
      pe.trait.erase === 'delete' ? { deleted: done.ids.length } : { anonymised: done.ids.length };
  }
  return { outcome, erased };
}

/**
 * Each declared retention rule as a retention target: the records that are someone's personal
 * data (a subject column set) whose date is older than the period are deleted or anonymised.
 */
export function recordTargets(): RetentionTarget[] {
  return personalEntities().flatMap((pe): RetentionTarget[] => {
    const r = pe.trait.retention;
    if (!r) return [];
    return [
      {
        name: r.name,
        // The entity's own label (the module's word), in every language.
        label: { en: pe.def.spec.label, hi: pe.def.spec.label, te: pe.def.spec.label },
        scope: 'tenant',
        action: r.action,
        days: r.days,
        async apply({ tenantId, before, tx }) {
          if (!tenantId) return { count: 0 };
          const cols = columnsOf(pe.def);
          const someone = or(
            ...subjectColumnsOf(pe.trait).map((k) => isNotNull(cols[k] as Column)),
          ) as SQL;
          const where = and(
            eq(cols.tenantId as Column, tenantId),
            someone,
            lt(cols[r.from ?? 'createdAt'] as Column, before),
          ) as SQL;
          const done = await apply(tx, pe, where, r.action);
          return done ? { count: done.ids.length, erased: [done] } : { count: 0 };
        },
      },
    ];
  });
}
