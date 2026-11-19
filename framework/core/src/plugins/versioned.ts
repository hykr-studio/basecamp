import {
  type AuthorizeResult,
  canMove,
  type EntitySpec,
  isFrozen,
  revisionFields,
  stateLabel,
  statesOf,
  type VersionedTrait,
  versionedOf,
  versionField,
  type WriteAction,
} from '@hykr/contracts';
import {
  and,
  type Column,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { deny, RuleDenied } from '../authorize.js';
import { childLinkOf } from '../entity/children.js';
import type { EntityPlugin } from '../hooks.js';

type Values = Record<string, unknown>;

const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/** What a frozen record is called in a refusal: "approved", or "frozen". */
function frozenAs(spec: EntitySpec, row: Values): string {
  const states = statesOf(spec);
  return states ? stateLabel(states, String(row[states.field]), 'en').toLowerCase() : 'frozen';
}

/**
 * A write to a frozen record: every delete, and an update that changes anything but its state
 * (along a declared transition, with that transition's own fields), the version and the fields
 * left editable. Null when it is not frozen or the write keeps to that.
 */
function frozenRefusal(
  spec: EntitySpec,
  trait: VersionedTrait,
  action: WriteAction,
  row: Values | null,
  input: Values | null,
): AuthorizeResult | null {
  if (action === 'create' || !row || !isFrozen(trait, row)) return null;
  const why = `This ${spec.label} is ${frozenAs(spec, row)}: it can't be changed`;
  if (action === 'delete') return deny('record_frozen', why);
  const allowed = new Set([versionField(trait), ...(trait.editableWhenFrozen ?? [])]);
  const states = statesOf(spec);
  if (states) {
    allowed.add(states.field);
    const to = input?.[states.field];
    if (to !== undefined && to !== row[states.field] && canMove(states, row[states.field], to))
      for (const t of states.transitions)
        if (t.to === to) for (const f of t.fields ?? []) allowed.add(f);
  }
  const changed = Object.entries(input ?? {}).filter(
    ([k, v]) => v !== undefined && !allowed.has(k) && !same(v, row[k]),
  );
  return changed.length ? deny('record_frozen', why) : null;
}

/** A versioned parent with states that freeze it, for a child entity: its table and condition. */
function frozenParentOf(spec: EntitySpec): { table: Table; frozen: SQL; fk: Column } | undefined {
  const link = childLinkOf(spec.name);
  const trait = link ? versionedOf(link.parent.spec) : undefined;
  if (!link || !trait?.frozenWhen) return undefined;
  const pc = getTableColumns(link.parent.table) as Record<string, Column>;
  const conditions = Object.entries(trait.frozenWhen).flatMap(([field, values]) => {
    const col = pc[field];
    if (!col) return [];
    const list = values.filter((v) => v !== null);
    return [
      ...(list.length ? [inArray(col, list as unknown[])] : []),
      ...(values.includes(null) ? [isNull(col)] : []),
    ];
  });
  if (!conditions.length) return undefined;
  return { table: link.parent.table, frozen: or(...conditions) as SQL, fk: link.fk };
}

/**
 * Versions and frozen records (`traits.versioned`): every update bumps the version, and a
 * write against an older one (the version the request carried, or the one it loaded) answers
 * 409; a parked write pins the version it loaded and its approval fails if the record moved on;
 * a frozen record refuses deletes and changes but a move of its state, and so do its children,
 * whether written through it (`children.insert` / `replace`) or one by one (not reachable).
 */
export const versionedPlugin: EntityPlugin = {
  name: 'versioned',
  appliesTo: (spec) => versionedOf(spec) !== undefined || frozenParentOf(spec) !== undefined,
  // CRUD: a frozen record's refusal is audited before anything runs.
  decide: (_p, action, row, input, { spec }) => {
    const trait = versionedOf(spec);
    return trait ? frozenRefusal(spec, trait, action, row, input) : null;
  },
  toValues: (values, { action, row }, { spec }) => {
    const trait = versionedOf(spec);
    if (!trait) return values;
    const field = versionField(trait);
    const out: Values = { ...values };
    const rev = revisionFields(trait);
    if (action === 'create') {
      out[field] = 1;
      // A first revision: its own series (null) and number 1. Later ones are made by revising.
      if (rev) {
        out[rev.series] = null;
        out[rev.number] = 1;
      }
      return out;
    }
    out[field] = Number(row?.[field] ?? 0) + 1;
    if (rev) {
      delete out[rev.series];
      delete out[rev.number];
    }
    return out;
  },
  // Every update and delete, commands' included: the version must still be the expected one,
  // and a frozen record is refused (a command's write never reaches `decide`).
  updateWhere: (row, input, { spec, table }) => {
    const trait = versionedOf(spec);
    if (!trait) return undefined;
    const r = frozenRefusal(spec, trait, input ? 'update' : 'delete', row, input);
    if (r) throw new RuleDenied(r);
    const field = versionField(trait);
    const col = (getTableColumns(table) as Record<string, Column>)[field];
    if (!col) throw new Error(`${spec.name}: the version column "${field}" is missing`);
    const expected = typeof input?.[field] === 'number' ? input[field] : row[field];
    return eq(col, expected);
  },
  // A child of a frozen record is not reachable for writing (its parent's tree writes refuse it).
  scope: (_p, op, { spec }) => {
    if (op !== 'write' || versionedOf(spec)) return undefined;
    const parent = frozenParentOf(spec);
    if (!parent) return undefined;
    const pc = getTableColumns(parent.table) as Record<string, Column>;
    return sql`not exists (select 1 from ${parent.table} where ${and(eq(pc.id as Column, parent.fk), parent.frozen)})`;
  },
  childWrite: (parent, { spec }) => {
    const trait = versionedOf(spec);
    return trait && isFrozen(trait, parent)
      ? deny(
          'record_frozen',
          `This ${spec.label} is ${frozenAs(spec, parent)}: its lines can't be changed`,
        )
      : null;
  },
  onPark: (row, { spec }) => {
    const trait = versionedOf(spec);
    return trait ? { version: row[versionField(trait)] } : undefined;
  },
  onReplay: (row, pinned, { spec }) => {
    const trait = versionedOf(spec);
    if (!trait || pinned.version === undefined) return null;
    const now = row[versionField(trait)];
    return now === pinned.version
      ? null
      : {
          error: 'stale',
          message: `This ${spec.label} changed since it was asked for (version ${String(pinned.version)} then, ${String(now)} now). Ask again.`,
        };
  },
};
