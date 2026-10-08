import type {
  AuthorizeResult,
  EntitySpec,
  ListInput,
  ListQuery,
  Page,
  Principal,
  WriteAction,
} from '@app/contracts';
import { listInputSchema, parksFor } from '@app/contracts';
import { defaultOwnerOf } from '@app/db';
import {
  type Access,
  accessFor,
  DEFAULT_ACCESS,
  type Grant,
  rowAllowed,
  subjectOf,
} from '@app/policy';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  and,
  type Column,
  count,
  eq,
  getTableColumns,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import type { z } from 'zod';
import { RuleDenied } from '../authorize.js';
import { buildListSql, decodeCursor, encodeCursor } from '../query/list-grammar.js';
import type { Conn, Tx } from '../tokens.js';
import { defineEntityCqrs, type EntityCqrs } from './cqrs-classes.js';

type Row<T extends Table> = T['$inferSelect'];

/** Where a write comes from: plain CRUD, or a named command calling the repository. */
export type RuleContext = { via: 'crud' | string };

/** A business rule: return a decision to refuse or park, or null to have no opinion. */
export type EntityRule<T extends Table> = (
  p: Principal,
  action: WriteAction,
  row: Row<T> | null,
  input: Record<string, unknown> | null,
  ctx: RuleContext,
) => AuthorizeResult | null;

export interface EntityConfig<S extends EntitySpec, T extends Table> {
  table: T;
  /** The owner column: the person whose record it is ('own' access), set on create. */
  owner: (table: T) => Column;
  /** The customer column, when customers have records here ('customer' access). */
  customer?: (table: T) => Column;
  /**
   * Who reaches which rows, by role: their own, their customer's, or the whole business.
   * Rows are always limited to the principal's business first. Default: everyone their own,
   * customers theirs.
   */
  access?: Access;
  rules?: EntityRule<T>[];
  /** What an approval card says. Defaults to e.g. Delete "Buy cement". */
  summarize?: (
    action: WriteAction,
    input: Record<string, unknown> | null,
    row: Row<T> | null,
  ) => string;
  /** Publish <Name>Created/Updated/Deleted after commit. Default true. */
  events?: boolean;
  /** Unused generics anchor. */
  _spec?: S;
}

export interface EntityRepository<T extends Table> {
  get(conn: Conn, p: Principal, id: string): Promise<Row<T>>;
  find(conn: Conn, p: Principal, id: string): Promise<Row<T> | undefined>;
  list(conn: Conn, p: Principal, q: ListQuery | ListInput): Promise<Page<Row<T>>>;
  insert(tx: Tx, p: Principal, input: Record<string, unknown>, ctx?: RuleContext): Promise<Row<T>>;
  update(
    tx: Tx,
    p: Principal,
    row: Row<T>,
    patch: Record<string, unknown>,
    ctx?: RuleContext,
  ): Promise<Row<T>>;
  delete(tx: Tx, p: Principal, row: Row<T>, ctx?: RuleContext): Promise<Row<T>>;
}

export interface EntityDef<S extends EntitySpec = EntitySpec, T extends Table = Table> {
  kind: 'entity';
  spec: S;
  name: string;
  plural: string;
  pascal: string;
  table: T;
  repo: EntityRepository<T>;
  rules: EntityRule<T>[];
  /** A row as it leaves the API: dates as ISO strings, only the read schema's fields. */
  toRead(row: Row<T>): z.infer<S['schemas']['read']>;
  summarize(action: WriteAction, input: Record<string, unknown> | null, row: Row<T> | null): string;
  /** Rules, then approval: the decision for one write before it runs. */
  decide(
    p: Principal,
    action: WriteAction,
    row: Row<T> | null,
    input: Record<string, unknown> | null,
  ): AuthorizeResult;
  events: boolean;
  cqrs: EntityCqrs;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry of heterogeneous definitions
export type AnyEntityDef = EntityDef<any, any>;

/** Dates become ISO strings, recursively, so rows and command results serialise as the contracts say. */
export function toJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

/** The person a principal acts for, when it has an account (a contact has none). */
export function subjectOrThrow(p: Principal): string {
  const subject = subjectOf(p);
  if (!subject)
    throw new ForbiddenException({ error: 'forbidden', rule: 'agent_needs_acting_for' });
  if (subject.kind !== 'user')
    throw new ForbiddenException({ error: 'forbidden', rule: 'needs_an_account' });
  return subject.userId;
}

/** The business a principal works in. Every scoped query starts here. */
export function tenantOf(p: Principal): string {
  if (!p.tenantId) throw new ForbiddenException({ error: 'forbidden', rule: 'no_tenant' });
  return p.tenantId;
}

export function defineEntity<S extends EntitySpec, T extends Table>(
  spec: S,
  config: EntityConfig<S, T>,
): EntityDef<S, T> {
  const { table } = config;
  const columns = getTableColumns(table) as Record<string, Column>;
  const idCol = columns.id;
  const ownerCol = config.owner(table);
  const ownerKey = Object.entries(columns).find(([, c]) => c === ownerCol)?.[0];
  const tenantCol = columns.tenantId;
  const customerCol = config.customer?.(table);
  if (!idCol || !ownerKey || !tenantCol)
    throw new Error(`${spec.name}: table needs id, tenantId and owner columns`);
  const keyOf = (col: Column) => Object.entries(columns).find(([, c]) => c === col)?.[0];
  const rules = config.rules ?? [];
  const label = spec.label;
  const access = config.access ?? DEFAULT_ACCESS;

  /** One grant as SQL: own rows, the customer's rows, or every row in the tenant. */
  const grantSql = (p: Principal, g: Grant): SQL | undefined => {
    if (g === 'tenant') return sql`true`;
    if (g === 'own') {
      const s = subjectOf(p);
      return s?.kind === 'user' ? eq(ownerCol, s.userId) : undefined;
    }
    return customerCol && p.customerId ? eq(customerCol, p.customerId) : undefined;
  };

  /**
   * The rows this principal reaches, for reading or writing: its tenant, then any of its
   * grants. No grant: no rows (a 404 for someone else's id, never a hint it exists).
   */
  const scoped = (p: Principal, op: 'read' | 'write', ...more: SQL[]) => {
    const decision = accessFor(p, access, op);
    const grants =
      decision.kind === 'grants' ? decision.grants.flatMap((g) => grantSql(p, g) ?? []) : [];
    return and(
      eq(tenantCol, tenantOf(p)),
      grants.length ? or(...grants) : sql`false`,
      ...more,
    ) as SQL;
  };

  /**
   * Who a new row belongs to. A person's own record is theirs; a customer's record is the
   * customer's, owned by the business's default owner (so it shows in the owner's lists).
   */
  const ownership = async (tx: Tx, p: Principal) => {
    const decision = accessFor(p, access, 'write');
    const grants = decision.kind === 'grants' ? decision.grants : [];
    const subject = subjectOf(p);
    const tenantId = tenantOf(p);
    if (subject?.kind === 'user' && (grants.includes('own') || grants.includes('tenant')))
      return { tenantId, ownerId: subject.userId };
    if (grants.includes('customer') && customerCol && p.customerId)
      return { tenantId, ownerId: await defaultOwnerOf(tx, tenantId), customerId: p.customerId };
    throw new ForbiddenException({ error: 'forbidden', rule: 'no_access' });
  };

  /** Only real columns, with ISO strings turned into Dates for timestamp columns. */
  function toValues(input: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const c = columns[key];
      if (
        !c ||
        value === undefined ||
        key === ownerKey ||
        key === 'id' ||
        key === 'createdBy' ||
        key === 'tenantId' ||
        c === customerCol
      )
        continue;
      out[key] =
        typeof value === 'string' && c.columnType === 'PgTimestamp' ? new Date(value) : value;
    }
    return out;
  }

  function checkRules(
    p: Principal,
    action: WriteAction,
    row: Row<T> | null,
    input: Record<string, unknown> | null,
    ctx: RuleContext,
  ) {
    for (const rule of rules) {
      const result = rule(p, action, row, input, ctx);
      if (result?.decision === 'deny') throw new RuleDenied(result);
    }
  }

  const repo: EntityRepository<T> = {
    async find(conn, p, id) {
      const [row] = await conn
        .select()
        .from(table as Table)
        .where(scoped(p, 'read', eq(idCol, id)))
        .limit(1);
      return row as Row<T> | undefined;
    },
    async get(conn, p, id) {
      const row = await repo.find(conn, p, id);
      // Someone else's id and a missing id look the same: 404, never 403.
      if (!row) throw new NotFoundException({ error: 'not_found', message: `No such ${label}` });
      return row;
    },
    async list(conn, p, input) {
      const q: ListQuery =
        'filters' in input && Array.isArray(input.filters)
          ? (input as ListQuery)
          : listInputSchema(spec, { maxLimit: 1000 }).parse(input);
      const built = buildListSql(table, spec.list, q);
      const where = [scoped(p, 'read'), ...built.where];
      const cursorWhere = q.cursor ? [built.after(decodeCursor(q.cursor, q.sort))] : [];
      const rows = (await conn
        .select()
        .from(table as Table)
        .where(and(...where, ...cursorWhere))
        .orderBy(...built.orderBy)
        .limit(built.limit + 1)) as Row<T>[];
      const items = rows.slice(0, built.limit);
      const last = items.at(-1) as Record<string, unknown> | undefined;
      const nextCursor =
        rows.length > built.limit && last
          ? encodeCursor(q.sort, built.cursorValues(last), String(last.id))
          : null;
      let total: number | undefined;
      if (q.count) {
        const [c] = await conn
          .select({ n: count() })
          .from(table as Table)
          .where(and(...where));
        total = Number(c?.n ?? 0);
      }
      return { items, nextCursor, ...(total !== undefined ? { total } : {}) };
    },
    async insert(tx, p, input, ctx = { via: 'crud' }) {
      const parsed = spec.schemas.create.parse(input) as Record<string, unknown>;
      checkRules(p, 'create', null, parsed, ctx);
      const owned = await ownership(tx, p);
      const [row] = await tx
        .insert(table as Table)
        .values({
          ...toValues(parsed),
          tenantId: owned.tenantId,
          [ownerKey]: owned.ownerId,
          ...(owned.customerId && customerCol
            ? { [keyOf(customerCol) as string]: owned.customerId }
            : {}),
          // Provenance, when the table records it: the assistant's rows stay marked as its own.
          ...(columns.createdBy
            ? { createdBy: p.actor.kind === 'agent' ? 'assistant' : 'person' }
            : {}),
        } as never)
        .returning();
      return row as Row<T>;
    },
    async update(tx, p, row, patch, ctx = { via: 'crud' }) {
      const parsed = spec.schemas.update.parse(patch) as Record<string, unknown>;
      checkRules(p, 'update', row, parsed, ctx);
      const [updated] = await tx
        .update(table as Table)
        .set(toValues(parsed) as never)
        .where(scoped(p, 'write', eq(idCol, (row as { id: string }).id)))
        .returning();
      if (!updated)
        throw new NotFoundException({ error: 'not_found', message: `No such ${label}` });
      return updated as Row<T>;
    },
    async delete(tx, p, row, ctx = { via: 'crud' }) {
      checkRules(p, 'delete', row, null, ctx);
      const [deleted] = await tx
        .delete(table as Table)
        .where(scoped(p, 'write', eq(idCol, (row as { id: string }).id)))
        .returning();
      if (!deleted)
        throw new NotFoundException({ error: 'not_found', message: `No such ${label}` });
      return deleted as Row<T>;
    },
  };

  const title = (row: Row<T> | null, input: Record<string, unknown> | null) =>
    String(
      (input?.title as string | undefined) ?? (row as { title?: string } | null)?.title ?? label,
    );
  const verb = { create: 'Create', update: 'Update', delete: 'Delete' } as const;

  const def: EntityDef<S, T> = {
    kind: 'entity',
    spec,
    name: spec.name,
    plural: spec.plural,
    pascal: spec.pascal,
    table,
    repo,
    rules,
    events: config.events ?? true,
    toRead: (row) => spec.schemas.read.parse(toJson(row)) as z.infer<S['schemas']['read']>,
    summarize:
      config.summarize ??
      ((action, input, row) =>
        action === 'create'
          ? `Create ${label} "${title(row, input)}"`
          : `${verb[action]} "${title(row, input)}"`),
    decide(p, action, row, input) {
      // Whose rows these are: a write needs a grant that covers the row (or, to create, any).
      const reach = accessFor(p, access, 'write');
      if (reach.kind === 'needs_assurance')
        return {
          decision: 'deny',
          rule: 'needs_assurance',
          reason: `To ${action} a ${label} here, link your number to your account in the app`,
        };
      const owned = row as { ownerId?: unknown; customerId?: unknown } | null;
      if (
        reach.kind === 'none' ||
        (owned &&
          !rowAllowed(p, reach.grants, {
            ownerId: owned[ownerKey as 'ownerId'],
            customerId: customerCol ? owned[keyOf(customerCol) as 'customerId'] : undefined,
          }))
      )
        return { decision: 'deny', rule: 'no_access', reason: `You can't ${action} this ${label}` };
      // Framework checks: who may call this action at all.
      if (p.actor.kind === 'agent' && spec.expose[action] !== 'all') {
        return {
          decision: 'deny',
          rule: 'humans_only',
          reason: `Only people can ${action} a ${label}`,
        };
      }
      // Then the entity's own rules: any refusal wins.
      for (const rule of rules) {
        const result = rule(p, action, row, input, { via: 'crud' });
        if (result?.decision === 'deny') return result;
      }
      // Then approval: who must confirm this action.
      const approval = spec.approval[action];
      if (parksFor(approval, p)) {
        return {
          decision: 'needs_approval',
          rule: `${spec.name}_${action}_needs_approval`,
          // Says why it waits, in the person's words: "Deletes by the assistant need your approval".
          reason:
            approval === 'always'
              ? `Every ${label} ${action} needs your approval`
              : `${action[0].toUpperCase()}${action.slice(1)}s by the ${p.actor.kind === 'agent' ? 'assistant' : 'requester'} need your approval`,
        };
      }
      return {
        decision: 'allow',
        rule: 'scoped_access',
        reason: `Works on ${spec.plural} they may reach`,
      };
    },
    cqrs: defineEntityCqrs(spec.pascal, spec.plural),
  };
  return def;
}
