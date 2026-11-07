import { randomUUID } from 'node:crypto';
import {
  type EntitySpec,
  flattenTree,
  type ListQuery,
  type ParentTrait,
  type Principal,
  TREE_MAX_DEPTH,
  TREE_MAX_NODES,
  treeDepth,
} from '@hykr/contracts';
import { type Access, accessFor, rowAllowed } from '@hykr/policy';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { type Column, getTableColumns, is, SQL, type Table } from 'drizzle-orm';
import { deny, RuleDenied } from '../authorize.js';
import type { Conn, Tx } from '../tokens.js';
import type { Touched } from '../write/pipeline.js';
import {
  type AnyEntityDef,
  defineEntity,
  type EntityConfig,
  type EntityDef,
  type RuleContext,
  tenantOf,
} from './define-entity.js';

type Values = Record<string, unknown>;
type Row<T extends Table> = T['$inferSelect'];

/** One node of a tree to write: its fields, its id if it is already stored, the nodes under it. */
export type ChildNode = Values & { id?: string; children?: readonly ChildNode[] };

/** What a tree write did, row by row, in tree order. */
export interface ChildrenResult<R> {
  /** Every child of the parent after the write, a parent before its children. */
  rows: R[];
  created: R[];
  updated: R[];
  /** As they were before they were deleted. */
  deleted: R[];
  /** One entry per created, updated and deleted row: what `run` returns for the audit. */
  touched: Touched[];
}

/** A child entity's link to its parent: what the `parent` plugin and the tree writes use. */
export interface ChildLink {
  child: EntitySpec;
  trait: ParentTrait;
  parent: AnyEntityDef;
  table: Table;
  /** The child's columns, by role. */
  fk: Column;
  nest?: Column;
  tenant: Column;
  owner: Column;
  customer?: Column;
  /** The parent's columns the child mirrors. */
  parentOwner: Column;
  parentCustomer?: Column;
  maxDepth: number;
  maxNodes: number;
}

const links = new Map<string, ChildLink>();

/** The link of a child entity, by its name; undefined for any other entity. */
export const childLinkOf = (name: string): ChildLink | undefined => links.get(name);

/** The child entities whose parent is this entity, by the parent's name. */
export const childLinksOf = (parentName: string): ChildLink[] =>
  [...links.values()].filter((l) => l.parent.name === parentName);

/** A child entity: an entity whose rows are written through their parent, a whole tree at once. */
export interface ChildEntityDef<S extends EntitySpec = EntitySpec, T extends Table = Table>
  extends EntityDef<S, T> {
  children: ChildRepository<T>;
  link: ChildLink;
}

export interface ChildRepository<T extends Table> {
  /** Every child of a parent the principal reaches (404 otherwise), a parent before its children. */
  list(conn: Conn, p: Principal, parentId: string): Promise<Row<T>[]>;
  /**
   * Add these nodes under the parent (or under one of its nodes, `under`), after the children
   * already there. New rows are inserted together, a few hundred per statement.
   */
  insert(
    tx: Tx,
    p: Principal,
    parent: Values,
    nodes: readonly ChildNode[],
    via: RuleContext,
    opts?: { under?: string },
  ): Promise<ChildrenResult<Row<T>>>;
  /**
   * Make the parent's children exactly this tree: nodes with an id are kept (updated where they
   * changed, moved where they moved), nodes without one are inserted, and stored children left
   * out are deleted.
   */
  replace(
    tx: Tx,
    p: Principal,
    parent: Values,
    nodes: readonly ChildNode[],
    via: RuleContext,
  ): Promise<ChildrenResult<Row<T>>>;
}

export interface ChildEntityConfig<S extends EntitySpec, T extends Table, P extends Table>
  extends EntityConfig<S, T> {
  /** Required: give the parent's own access, so a child is reached exactly as its parent. */
  access: Access;
  parent: {
    def: EntityDef<EntitySpec, P>;
    /** The parent's owner column, which each child mirrors. */
    owner: (table: P) => Column;
    /** The parent's customer column, when it has one. */
    customer?: (table: P) => Column;
  };
}

/** Rows per multi-row INSERT. */
const INSERT_CHUNK = 500;

/**
 * An entity whose rows belong to a parent record (`traits.parent` on its spec): an order's
 * items, nested to any depth through the trait's `nest` field. Its rows carry the parent's
 * owner and customer and take the parent's access, so whoever reaches the parent reaches all
 * of its children and nobody else does; the `parent` plugin also requires the parent to exist
 * in the same business. Children are created only through `children.insert` and
 * `children.replace` (inside a command), never one by one with `repo.insert`.
 */
export function defineChildEntity<S extends EntitySpec, T extends Table, P extends Table>(
  spec: S,
  config: ChildEntityConfig<S, T, P>,
): ChildEntityDef<S, T> {
  const declared = spec.traits?.parent;
  if (!declared) throw new Error(`${spec.name}: a child entity needs traits.parent`);
  const trait: ParentTrait = declared;
  const parentDef = config.parent.def;
  if (trait.entity !== parentDef.name)
    throw new Error(`${spec.name}: traits.parent names "${trait.entity}", not ${parentDef.name}`);
  const def = defineEntity(spec, config);
  const columns = getTableColumns(config.table) as Record<string, Column>;
  const keyOf = (col: Column | undefined) =>
    col ? Object.entries(columns).find(([, c]) => c === col)?.[0] : undefined;
  const column = (key: string | undefined, what: string) => {
    if (key === undefined) return undefined;
    const c = columns[key];
    if (!c) throw new Error(`${spec.name}: traits.parent.${what} "${key}" is not a column`);
    return c;
  };
  const fk = column(trait.field, 'field') as Column;
  const nest = column(trait.nest, 'nest');
  column(trait.position, 'position'); // checked: a column of the table
  if (spec.list.filterable[trait.field] !== 'id')
    throw new Error(
      `${spec.name}: list.filterable.${trait.field} must be 'id' (children by parent)`,
    );
  for (const key of [trait.nest, trait.position])
    if (key && !(key in spec.schemas.update.shape))
      throw new Error(`${spec.name}: the update schema needs "${key}" (the tree moves nodes)`);
  const parentTable = parentDef.table as P;
  const owner = config.owner(config.table);
  const customer = config.customer?.(config.table);
  const parentOwner = config.parent.owner(parentTable);
  const parentCustomer = config.parent.customer?.(parentTable);
  if (Boolean(customer) !== Boolean(parentCustomer))
    throw new Error(
      `${spec.name}: give both a customer column or neither (it mirrors the parent's)`,
    );
  const ownerKey = keyOf(owner) as string;
  const customerKey = keyOf(customer);
  const parentColumns = getTableColumns(parentTable) as Record<string, Column>;
  const parentKeyOf = (col: Column | undefined) =>
    col ? Object.entries(parentColumns).find(([, c]) => c === col)?.[0] : undefined;
  const parentOwnerKey = parentKeyOf(parentOwner) as string;
  const parentCustomerKey = parentKeyOf(parentCustomer);
  const childMoney = spec.traits?.money;
  const parentMoney = parentDef.spec.traits?.money;
  const link: ChildLink = {
    child: spec,
    trait,
    parent: parentDef as AnyEntityDef,
    table: config.table,
    fk,
    nest,
    tenant: columns.tenantId as Column,
    owner,
    customer,
    parentOwner,
    parentCustomer,
    maxDepth: nest ? (trait.maxDepth ?? TREE_MAX_DEPTH) : 1,
    maxNodes: trait.maxNodes ?? TREE_MAX_NODES,
  };
  if (links.has(spec.name) && links.get(spec.name)?.parent !== link.parent)
    throw new Error(`${spec.name} is already a child of another entity`);
  links.set(spec.name, link);
  const label = spec.label;
  const notFound = () => new NotFoundException({ error: 'not_found', message: `No such ${label}` });
  const id = (row: Values) => String(row.id);

  /** The parent, again through its own repository, and writable by p under the child's access. */
  async function writableParent(tx: Conn, p: Principal, parent: Values): Promise<Values> {
    const row = (await parentDef.repo.find(tx, p, id(parent))) as Values | undefined;
    if (!row || row.tenantId !== tenantOf(p))
      throw new NotFoundException({
        error: 'not_found',
        message: `No such ${parentDef.spec.label}`,
      });
    const reach = accessFor(p, config.access, 'write');
    if (reach.kind === 'needs_assurance')
      throw new RuleDenied(
        deny(
          'needs_assurance',
          `To change a ${label} here, link your number to your account in the app`,
        ),
      );
    const mirror = {
      ownerId: row[parentOwnerKey] as string,
      customerId: parentCustomerKey ? (row[parentCustomerKey] as string | null) : undefined,
    };
    if (reach.kind !== 'grants' || !rowAllowed(p, reach.grants, mirror))
      throw new NotFoundException({
        error: 'not_found',
        message: `No such ${parentDef.spec.label}`,
      });
    // The parent's plugins may refuse a write to its children (a frozen record's lines).
    const target = { spec: parentDef.spec, table: parentDef.table };
    for (const x of parentDef.plugins()) {
      const r = x.childWrite?.(row, target);
      if (r?.decision === 'deny') throw new RuleDenied(r);
    }
    return row;
  }

  /** Every stored child of the parent, through the child's scoped repository. */
  async function stored(conn: Conn, p: Principal, parentId: string): Promise<Row<T>[]> {
    const q: ListQuery = {
      filters: [{ field: trait.field, op: 'eq', value: parentId }],
      sort: trait.position ? [{ field: trait.position, dir: 'asc' }] : [],
      limit: link.maxNodes + 1,
      count: false,
    };
    const page = await def.repo.list(conn, p, q);
    if (page.items.length > link.maxNodes)
      throw new BadRequestException({
        error: 'too_many',
        message: `More than ${link.maxNodes} ${label}s`,
      });
    return page.items;
  }

  /** In tree order: a parent before its children, siblings by position. */
  function treeOrder(rows: Row<T>[]): Row<T>[] {
    const pos = trait.position;
    const sorted = pos
      ? [...rows].sort((a, b) => Number((a as Values)[pos] ?? 0) - Number((b as Values)[pos] ?? 0))
      : rows;
    if (!trait.nest) return sorted;
    const under = new Map<unknown, Row<T>[]>();
    for (const r of sorted) {
      const up = (r as Values)[trait.nest] ?? null;
      under.set(up, [...(under.get(up) ?? []), r]);
    }
    const out: Row<T>[] = [];
    const walk = (up: unknown) => {
      for (const r of under.get(up) ?? []) {
        out.push(r);
        walk(id(r as Values));
      }
    };
    walk(null);
    return out;
  }

  /** Real columns only, ISO strings as Dates for timestamps, never the framework's own. */
  const framed = (key: string) =>
    key === 'id' ||
    key === 'tenantId' ||
    key === 'createdBy' ||
    key === ownerKey ||
    key === customerKey ||
    key === trait.field;
  function columnValues(input: Values): Values {
    const out: Values = {};
    for (const [key, value] of Object.entries(input)) {
      const c = columns[key];
      if (!c || value === undefined || framed(key)) continue;
      out[key] =
        typeof value === 'string' && c.columnType === 'PgTimestamp' ? new Date(value) : value;
    }
    return out;
  }

  /**
   * A new node's columns: its fields parsed by the create schema (with the parent's currency),
   * the child's rules and its plugins' (all but the parent plugin's: this is the path it asks
   * for), then the plugins' column values.
   */
  function checkCreate(p: Principal, fields: Values, via: RuleContext): Values {
    const input = { ...(spec.schemas.create.parse(fields) as Values), ...inherited(fields) };
    for (const rule of def.rules) {
      const r = rule(p, 'create', null, input, via);
      if (r?.decision === 'deny') throw new RuleDenied(r);
    }
    let values = columnValues(input);
    for (const x of def.plugins()) {
      if (x.name === 'parent') continue;
      for (const rule of x.rules ?? []) {
        const r = rule(p, 'create', null, input, via);
        if (r?.decision === 'deny') throw new RuleDenied(r);
      }
      if (x.toValues)
        values = x.toValues(
          values,
          { p, action: 'create', row: null, input },
          { spec, table: config.table },
        );
    }
    return Object.fromEntries(
      Object.entries(values).filter(([k, v]) => columns[k] && v !== undefined && !framed(k)),
    );
  }

  const currencyKey = childMoney ? (childMoney.currency ?? 'currency') : undefined;

  /** A node's own fields: its children and id removed, the parent's currency added. */
  function fieldsOf(node: ChildNode, parent: Values): Values {
    const { children: _c, id: _i, ...fields } = node;
    if (currencyKey && parentMoney)
      fields[currencyKey] = parent[parentMoney.currency ?? 'currency'];
    return fields;
  }

  /** What the create schema may not carry but the child inherits: the parent's currency. */
  const inherited = (fields: Values): Values =>
    currencyKey && fields[currencyKey] !== undefined ? { [currencyKey]: fields[currencyKey] } : {};

  function checkShape(nodes: readonly ChildNode[], have: number, depthAbove: number) {
    const depth = treeDepth(nodes);
    if (!nest && depth > 1)
      throw new BadRequestException({
        error: 'not_a_tree',
        message: `A ${label} has no nodes under it`,
      });
    if (depthAbove + depth > link.maxDepth)
      throw new BadRequestException({
        error: 'too_deep',
        message: `At most ${link.maxDepth} levels of ${label}s`,
      });
    const count = flattenTree(nodes).length;
    if (have + count > link.maxNodes)
      throw new BadRequestException({
        error: 'too_many',
        message: `At most ${link.maxNodes} ${label}s`,
      });
  }

  /** Insert new nodes, a parent before its children, in a few statements. */
  async function insertRows(tx: Tx, rows: Values[]): Promise<Row<T>[]> {
    const out: Row<T>[] = [];
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      out.push(
        ...((await tx
          .insert(config.table)
          .values(chunk as never)
          .returning()) as Row<T>[]),
      );
    }
    return out;
  }

  /** The columns a new node is stored with: its own, then the framework's (mirrored from the parent). */
  function newRow(
    p: Principal,
    parent: Values,
    node: ChildNode,
    upId: string | null,
    pos: number,
    via: RuleContext,
  ): { id: string; values: Values } {
    const nodeId = randomUUID();
    const values = checkCreate(p, fieldsOf(node, parent), via);
    return {
      id: nodeId,
      values: {
        ...values,
        ...(trait.nest ? { [trait.nest]: upId } : {}),
        ...(trait.position ? { [trait.position]: pos } : {}),
        id: nodeId,
        tenantId: parent.tenantId,
        [trait.field]: parent.id,
        [ownerKey]: parent[parentOwnerKey],
        ...(customerKey && parentCustomerKey ? { [customerKey]: parent[parentCustomerKey] } : {}),
        ...(columns.createdBy
          ? { createdBy: p.actor.kind === 'agent' ? 'assistant' : 'person' }
          : {}),
      },
    };
  }

  const same = (a: unknown, b: unknown) => {
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  };

  /**
   * Would this patch change the stored row? Compared as the columns it would write. A value a
   * plugin computes in SQL from the row as it is then (a custom fields merge) counts as a change.
   */
  function changes(p: Principal, row: Values, patch: Values): boolean {
    const parsed = spec.schemas.update.parse(patch) as Values;
    let values = columnValues(parsed);
    for (const x of def.plugins())
      if (x.toValues && x.name !== 'parent')
        values = x.toValues(
          values,
          { p, action: 'update', row, input: parsed },
          { spec, table: config.table },
        );
    for (const key of [trait.nest, trait.position])
      if (key && key in parsed) values[key] = parsed[key];
    return Object.entries(values).some(
      ([k, v]) => columns[k] && v !== undefined && (is(v, SQL) || !same(v, row[k])),
    );
  }

  const children: ChildRepository<T> = {
    async list(conn, p, parentId) {
      const parent = (await parentDef.repo.get(conn, p, parentId)) as Values;
      return treeOrder(await stored(conn, p, id(parent)));
    },

    async insert(tx, p, parentRow, nodes, via, opts = {}) {
      const parent = await writableParent(tx, p, parentRow);
      const existing = await stored(tx, p, id(parent));
      let depthAbove = 0;
      let upId: string | null = null;
      if (opts.under !== undefined) {
        if (!nest) throw notFound();
        const byId = new Map(existing.map((r) => [id(r as Values), r as Values]));
        if (!byId.has(opts.under)) throw notFound();
        upId = opts.under;
        for (let at: unknown = upId; at; at = byId.get(String(at))?.[trait.nest as string])
          depthAbove++;
      }
      checkShape(nodes, existing.length, depthAbove);
      const siblings = existing.filter((r) => ((r as Values)[trait.nest ?? ''] ?? null) === upId);
      const rows: Values[] = [];
      const walk = (list: readonly ChildNode[], up: string | null, start: number) => {
        list.forEach((node, i) => {
          if (node.id !== undefined)
            throw new BadRequestException({
              error: 'stored_node',
              message: `Only new ${label}s are inserted: leave out their id`,
            });
          const made = newRow(p, parent, node, up, start + i, via);
          rows.push(made.values);
          walk(node.children ?? [], made.id, 0);
        });
      };
      walk(nodes, upId, trait.nest ? siblings.length : existing.length);
      const created = await insertRows(tx, rows);
      return {
        rows: treeOrder([...existing, ...created]),
        created,
        updated: [],
        deleted: [],
        touched: created.map((r) => ({
          type: spec.name,
          id: id(r as Values),
          change: 'created' as const,
          after: r,
        })),
      };
    },

    async replace(tx, p, parentRow, nodes, via) {
      const parent = await writableParent(tx, p, parentRow);
      const existing = await stored(tx, p, id(parent));
      checkShape(nodes, 0, 0);
      const byId = new Map(existing.map((r) => [id(r as Values), r as Values]));
      const kept = new Set<string>();
      const inserts: Values[] = [];
      const patches: { row: Values; patch: Values }[] = [];
      const walk = (list: readonly ChildNode[], up: string | null) => {
        list.forEach((node, i) => {
          let nodeId: string;
          if (node.id !== undefined) {
            const row = byId.get(node.id);
            // Not a child of this parent (another one's, another business's, or none): 404.
            if (!row || kept.has(node.id)) throw notFound();
            kept.add(node.id);
            nodeId = node.id;
            const patch: Values = {
              ...fieldsOf(node, parent),
              ...(trait.nest ? { [trait.nest]: up } : {}),
              ...(trait.position ? { [trait.position]: i } : {}),
            };
            // A record's currency is its parent's and never changes: not part of a patch.
            if (currencyKey) delete patch[currencyKey];
            if (changes(p, row, patch)) patches.push({ row, patch });
          } else {
            const made = newRow(p, parent, node, up, i, via);
            inserts.push(made.values);
            nodeId = made.id;
          }
          walk(node.children ?? [], nodeId);
        });
      };
      walk(nodes, null);

      // New rows first (a kept node may move under one), then changes, then deletions.
      const created = await insertRows(tx, inserts);
      const updated: Row<T>[] = [];
      const touched: Touched[] = created.map((r) => ({
        type: spec.name,
        id: id(r as Values),
        change: 'created' as const,
        after: r,
      }));
      for (const { row, patch } of patches) {
        const after = (await def.repo.update(tx, p, row as Row<T>, patch, via)) as Row<T>;
        updated.push(after);
        touched.push({ type: spec.name, id: id(row), change: 'updated', before: row, after });
      }
      // Removed nodes, deepest first, so no foreign key between them is ever left dangling.
      const removed = existing.filter((r) => !kept.has(id(r as Values)));
      const depthOf = (r: Values) => {
        let d = 0;
        for (
          let at: unknown = trait.nest ? r[trait.nest] : null;
          at;
          at = byId.get(String(at))?.[trait.nest as string]
        )
          d++;
        return d;
      };
      removed.sort((a, b) => depthOf(b as Values) - depthOf(a as Values));
      const deleted: Row<T>[] = [];
      for (const row of removed) {
        await def.repo.delete(tx, p, row, via);
        deleted.push(row);
        touched.push({ type: spec.name, id: id(row as Values), change: 'deleted', before: row });
      }
      const after = new Map<string, Row<T>>();
      for (const r of existing) if (kept.has(id(r as Values))) after.set(id(r as Values), r);
      for (const r of [...updated, ...created]) after.set(id(r as Values), r);
      return { rows: treeOrder([...after.values()]), created, updated, deleted, touched };
    },
  };

  return Object.assign(def, { children, link });
}

/**
 * Insert several records of any entity in one write: one `repo.insert` each (its rules, its
 * ownership), with the touched list a command returns. Children go in bulk through their
 * parent instead (`children.insert`).
 */
export async function insertMany<T extends Table>(
  tx: Tx,
  p: Principal,
  def: EntityDef<EntitySpec, T>,
  inputs: readonly Values[],
  via: RuleContext,
): Promise<{ rows: Row<T>[]; touched: Touched[] }> {
  const rows: Row<T>[] = [];
  for (const input of inputs) rows.push(await def.repo.insert(tx, p, input, via));
  return {
    rows,
    touched: rows.map((r) => ({
      type: def.name,
      id: String((r as Values).id),
      change: 'created' as const,
      after: r,
    })),
  };
}
