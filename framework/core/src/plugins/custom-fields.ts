// Custom fields (A11), server side: the entity plugin that stores a record's `custom` object, the
// list SQL that filters on it, and the write hook that checks it against the business's
// definitions (app.custom_fields) in the write's own transaction.
import {
  type CustomField,
  type CustomFilter,
  customValueProblems,
  type EntitySpec,
} from '@hykr/contracts';
import { customFields } from '@hykr/db';
import { BadRequestException } from '@nestjs/common';
import {
  and,
  type Column,
  eq,
  getTableColumns,
  getTableName,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { entityDef } from '../entity/registry.js';
import type { EntityPlugin, WriteHook } from '../hooks.js';
import { escapeLike, type ListFieldSql } from '../query/field-sql.js';
import type { Conn } from '../tokens.js';

type Values = Record<string, unknown>;

/** Does this entity take custom fields? */
export const hasCustomFields = (spec: EntitySpec) => spec.traits?.customFields !== undefined;

/** A business's definitions for one entity, in their order. */
export async function customFieldsOf(
  conn: Conn,
  tenantId: string,
  entity: string,
): Promise<Pick<CustomField, 'key' | 'type' | 'options' | 'required' | 'filterable'>[]> {
  const rows = await conn
    .select({
      key: customFields.key,
      type: customFields.type,
      options: customFields.options,
      required: customFields.required,
      filterable: customFields.filterable,
    })
    .from(customFields)
    .where(and(eq(customFields.tenantId, tenantId), eq(customFields.entity, entity)))
    .orderBy(customFields.position, customFields.createdAt);
  return rows.map((r) => ({ ...r, options: (r.options as string[] | null) ?? [] }));
}

/** A patch applied to a stored object: each key sent replaces it, null removes it. */
export function mergeCustom(base: unknown, patch: Readonly<Record<string, unknown>>): Values {
  const next: Values = { ...((base as Values | null) ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next;
}

/**
 * The same patch as SQL, applied to the column as it is when the UPDATE runs: the keys sent are
 * set, the null ones removed, and every other key stays as the row holds it then. Two updates of
 * one record that set different keys both keep theirs; a merge made from the row each one read
 * (unlocked, at READ COMMITTED) would let the second overwrite the first's.
 */
export function mergeCustomSql(column: Column, patch: Readonly<Record<string, unknown>>): SQL {
  const set: Values = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) removed.push(key);
    else if (value !== undefined) set[key] = value;
  }
  let merged = sql`(coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(set)}::jsonb)`;
  for (const key of removed) merged = sql`(${merged} - ${key}::text)`;
  return merged;
}

/**
 * The plugin on every entity with the `customFields` trait: a create stores the values sent,
 * an update merges its patch into the stored object in SQL, and a read always has an object.
 */
export const customFieldsPlugin: EntityPlugin = {
  name: 'custom-fields',
  appliesTo: hasCustomFields,
  toValues(values, { action, input }, { table }) {
    const { custom: _dropped, ...rest } = values;
    const patch = input.custom as Values | undefined;
    if (patch === undefined) return rest;
    if (action === 'create') return { ...rest, custom: mergeCustom({}, patch) };
    const column = getTableColumns(table).custom;
    if (!column)
      throw new Error(`${getTableName(table)} takes custom fields but has no \`custom\` column`);
    return { ...rest, custom: mergeCustomSql(column, patch) };
  },
  toJson: (row) => ({ ...row, custom: (row.custom as Values | null) ?? {} }),
};

const COMPARE = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/** One value compared with one key, by the stored JSON type (numbers as numbers, the rest as text). */
function compare(column: Column, key: string, op: keyof typeof COMPARE, value: unknown): SQL {
  const json = sql`(${column} -> ${key}::text)`;
  const text = sql`(${column} ->> ${key}::text)`;
  const cmp = sql.raw(COMPARE[op]);
  const parts: SQL[] = [];
  const asText = typeof value === 'string' ? value : String(value);
  parts.push(sql`(jsonb_typeof(${json}) = 'string' and ${text} ${cmp} ${asText})`);
  const asNumber =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : undefined;
  if (asNumber !== undefined)
    parts.push(
      sql`((case when jsonb_typeof(${json}) = 'number' then ${text}::numeric end) ${cmp} ${asNumber})`,
    );
  const asBool =
    typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null;
  if (asBool !== null && op === 'eq')
    parts.push(sql`(jsonb_typeof(${json}) = 'boolean' and ${text} = ${String(asBool)})`);
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

/** One key's filter: a bare value (eq) or { op: value }. */
function keyWhere(column: Column, key: string, filter: unknown): SQL[] {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter))
    return [compare(column, key, 'eq', filter)];
  const out: SQL[] = [];
  for (const [op, value] of Object.entries(filter as Values)) {
    if (value === undefined) continue;
    const present = sql`(${column} ? ${key}::text)`;
    switch (op) {
      case 'eq':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        out.push(compare(column, key, op, value));
        break;
      case 'ne':
        out.push(
          and(present, not(sql`coalesce(${compare(column, key, 'eq', value)}, false)`)) as SQL,
        );
        break;
      case 'in':
        out.push(or(...(value as unknown[]).map((v) => compare(column, key, 'eq', v))) as SQL);
        break;
      case 'contains':
        out.push(
          sql`(jsonb_typeof(${column} -> ${key}::text) = 'string' and (${column} ->> ${key}::text) ilike ${`%${escapeLike(String(value))}%`})`,
        );
        break;
      default:
        throw new BadRequestException({ error: 'bad_filter', message: `No operator "${op}"` });
    }
  }
  return out;
}

/** The `custom` list field type's SQL: every key's filter, all of them must hold. */
export const customListSql: ListFieldSql = {
  name: 'custom',
  where({ column, field, value }) {
    if (!column) throw new Error(`List config names "${field}", which is not a column`);
    const conditions = Object.entries(value as CustomFilter).flatMap(([key, f]) =>
      keyWhere(column, key, f),
    );
    return (conditions.length ? and(...conditions) : sql`true`) as SQL;
  },
};

const invalid = (problems: string[]) =>
  new BadRequestException({
    error: 'custom_field_invalid',
    message: `Custom fields: ${problems.join('; ')}`,
    problems,
  });

/**
 * Every write that stores custom values (CRUD, commands, approved replays, system jobs) is checked
 * in its transaction against the business's definitions; a problem rolls the write back with a 400.
 * A parked write's input is checked when it parks, so nobody approves values that cannot be saved.
 *
 * A required field is enforced only where the writer could supply it: the entity's own create,
 * and any write that sets custom values on the record. A record another operation makes without
 * custom values (a command that makes records of this entity from its own input) is not refused
 * for a field that operation cannot know about; it shows the field as unset until someone fills
 * it.
 */
export const customFieldsHook: WriteHook = {
  name: 'custom-fields',
  async afterRun({ ctx, op, input, tx, touched, result }) {
    const tenantId = ctx.principal.tenantId;
    if (!tenantId) return;
    if (result.status === 'needs_approval') {
      const def = op.kind === 'entity' ? entityDef(op.resourceType) : undefined;
      const patch = (input as Values | null)?.custom as Values | undefined;
      const creating = op.name.endsWith('.create');
      if (!def || !hasCustomFields(def.spec) || (!patch && !creating)) return;
      const values = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== null));
      const fields = await customFieldsOf(tx, tenantId, def.name);
      const problems = customValueProblems(fields, values, { checkRequired: creating });
      if (problems.length) throw invalid(problems);
      return;
    }
    for (const t of touched) {
      if (t.change === 'deleted') continue;
      const def = entityDef(t.type);
      if (!def || !hasCustomFields(def.spec)) continue;
      const after = ((t.after as Values | undefined)?.custom ?? {}) as Values;
      const before = ((t.before as Values | undefined)?.custom ?? {}) as Values;
      const same = (k: string) => JSON.stringify(after[k]) === JSON.stringify(before[k]);
      const created = t.change === 'created';
      if (!created && Object.keys({ ...after, ...before }).every(same)) continue;
      // Only the values this write set are checked: one kept from before its field was removed
      // (or its option dropped) stays as it is until someone changes or clears it. `before` is
      // the row as this write read it, so a key a concurrent write changed in between is
      // checked too.
      const set = Object.fromEntries(Object.entries(after).filter(([k]) => created || !same(k)));
      // Required fields must hold a value on the entity's own create and whenever this write
      // sets custom values; not on a record another operation made without any.
      const ownCreate = op.kind === 'entity' && op.name === `${t.type}.create`;
      const checkRequired = !created || ownCreate || Object.keys(set).length > 0;
      const fields = await customFieldsOf(tx, tenantId, def.name);
      const problems = [
        ...customValueProblems(fields, set, { checkRequired: false }),
        ...(checkRequired
          ? fields
              .filter((f) => f.required && (after[f.key] === undefined || after[f.key] === ''))
              .map((f) => `${f.key}: required`)
          : []),
      ];
      if (problems.length) throw invalid(problems);
    }
  },
};
