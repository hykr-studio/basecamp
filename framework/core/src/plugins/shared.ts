// Platform-scoped shared records (A11): an entity whose platform rows (kept by the platform's own
// business, PLATFORM_TENANT_ID) every business reads, read-only, unless it overrides one with a
// row of its own that names it (`sharedId`). The entity's own table holds both. What is shared
// is the application's data; this is only the mechanism.
import type { EntitySpec, ListInput, ListQuery, Page, Principal } from '@hykr/contracts';
import { listInputSchema } from '@hykr/contracts';
import { accessFor, DEFAULT_ACCESS } from '@hykr/policy';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  and,
  type Column,
  count,
  eq,
  getTableColumns,
  inArray,
  ne,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import { deny } from '../authorize.js';
import { defineEntity, type EntityConfig, type EntityDef } from '../entity/define-entity.js';
import { entityDef } from '../entity/registry.js';
import type { EntityPlugin, WriteHook } from '../hooks.js';
import { buildListSql, decodeCursor, type ListSelected, listQuery } from '../query/list-grammar.js';
import type { Conn } from '../tokens.js';

type Values = Record<string, unknown>;

let platformTenant: string | undefined;

/**
 * Which business keeps the shared rows: deployment configuration (PLATFORM_TENANT_ID), never a
 * business's own setting. Unset: nothing is shared, and shared entities are plain ones.
 */
export function configureSharedRecords(opts: { platformTenantId?: string | null }) {
  platformTenant = opts.platformTenantId || undefined;
}

/** The business that keeps the shared rows, if one is configured. */
export const platformTenantId = (): string | undefined => platformTenant;

/** Does this entity share the platform's rows? */
export const isShared = (spec: EntitySpec) => spec.traits?.shared !== undefined;

/**
 * The plugin on every shared entity: a row says whether it is the platform's (`shared`), and no
 * business writes a row of another (the platform's rows are read-only to everyone else).
 */
export const sharedRecordsPlugin: EntityPlugin = {
  name: 'shared-records',
  appliesTo: isShared,
  rules: [
    (p, action, row) =>
      row && (row as Values).tenantId !== p.tenantId
        ? deny(
            'shared_read_only',
            `This ${action === 'delete' ? 'shared record cannot be deleted' : 'shared record cannot be changed'} here: override it with your own copy`,
          )
        : null,
  ],
  toJson: (row) => ({
    ...row,
    shared: platformTenant !== undefined && row.tenantId === platformTenant,
    sharedId: (row.sharedId as string | null | undefined) ?? null,
  }),
};

/**
 * `defineEntity` for an entity with the `shared` trait. Its table also needs `sharedId`
 * (`sharedFromColumn()` from @hykr/db). Reads (list, find, get, and so its routes and tools) see
 * the business's own rows plus the platform's rows it has not overridden; writes are the plain
 * entity's, so they only ever touch the business's own rows.
 */
export function defineSharedEntity<S extends EntitySpec, T extends Table>(
  spec: S,
  config: EntityConfig<S, T>,
): EntityDef<S, T> {
  if (!isShared(spec)) throw new Error(`${spec.name}: give the spec the shared trait`);
  const def = defineEntity(spec, config);
  const table = config.table;
  const columns = getTableColumns(table) as Record<string, Column>;
  const idCol = columns.id;
  const tenantCol = columns.tenantId;
  const sharedCol = columns.sharedId;
  if (!sharedCol)
    throw new Error(`${spec.name}: a shared table needs sharedId (sharedFromColumn())`);
  const access = config.access ?? DEFAULT_ACCESS;
  const mine = alias(table as unknown as PgTable, 'mine') as unknown as Record<string, Column>;
  type Row = T['$inferSelect'];

  /** The platform rows this principal reads, or undefined when none: not overridden ones only for lists. */
  const platformWhere = (p: Principal, opts: { overridden: boolean }): SQL | undefined => {
    if (!platformTenant || !p.tenantId || p.tenantId === platformTenant) return undefined;
    if (accessFor(p, access, 'read').kind !== 'grants') return undefined;
    return and(
      eq(tenantCol, platformTenant),
      ...(opts.overridden
        ? []
        : [
            sql`not exists (select 1 from ${table} ${sql.identifier('mine')} where ${mine.tenantId} = ${p.tenantId} and ${mine.sharedId} = ${idCol})`,
          ]),
      // Plugins narrow the platform's rows too (never widen).
      ...def.plugins().map((x) => x.scope?.(p, 'read', { spec, table })),
    ) as SQL;
  };

  const own = def.repo;
  const toQuery = (input: ListQuery | ListInput): ListQuery =>
    'filters' in input && Array.isArray(input.filters)
      ? (input as ListQuery)
      : listInputSchema(spec, { maxLimit: 1000 }).parse(input);

  async function list(conn: Conn, p: Principal, input: ListQuery | ListInput): Promise<Page<Row>> {
    const q = toQuery(input);
    const theirs = platformWhere(p, { overridden: false });
    const page = await own.list(conn, p, q);
    if (!theirs) return page;
    const built = buildListSql(table, spec.list, q);
    const where = [theirs, ...built.where];
    const after = q.cursor ? [built.after(decodeCursor(q.cursor, q.sort))] : [];
    const platform = (await listQuery(q.cursor, () =>
      conn
        .select(built.fields)
        .from(table as Table)
        .where(and(...where, ...after))
        .orderBy(...built.orderBy)
        .limit(built.limit + 1),
    )) as ListSelected[];
    // The first `limit` rows of both, in one order: Postgres orders the candidates, so text
    // sorts by the database's collation exactly as each half did.
    const candidates = [
      ...page.items,
      ...platform.slice(0, built.limit).map((r) => r.row),
    ] as Values[];
    let found: ListSelected[] = [];
    if (candidates.length) {
      const ids = candidates.map((r) => String(r.id));
      found = (await conn
        .select(built.fields)
        .from(table as Table)
        .where(inArray(idCol, ids))
        .orderBy(...built.orderBy)
        .limit(built.limit)) as ListSelected[];
    }
    const items = found.map((r) => r.row) as Row[];
    const more =
      page.nextCursor !== null || platform.length > built.limit || candidates.length > built.limit;
    const last = found.at(-1);
    const nextCursor = more && last ? built.cursorAfter(last) : null;
    let total: number | undefined;
    if (q.count) {
      const [c] = await conn
        .select({ n: count() })
        .from(table as Table)
        .where(and(...where));
      total = (page.total ?? 0) + Number(c?.n ?? 0);
    }
    return { items, nextCursor, ...(total !== undefined ? { total } : {}) };
  }

  async function find(conn: Conn, p: Principal, id: string): Promise<Row | undefined> {
    const row = await own.find(conn, p, id);
    if (row) return row;
    const theirs = platformWhere(p, { overridden: true });
    if (!theirs) return undefined;
    const [shared] = await conn
      .select()
      .from(table as Table)
      .where(and(theirs, eq(idCol, id)))
      .limit(1);
    return shared as Row | undefined;
  }

  return {
    ...def,
    repo: {
      ...own,
      list,
      find,
      async get(conn, p, id) {
        const row = await find(conn, p, id);
        if (!row)
          throw new NotFoundException({ error: 'not_found', message: `No such ${spec.label}` });
        return row;
      },
    },
  };
}

/**
 * A row that overrides a platform row must name one of the same entity, and a business overrides
 * each platform row once. Checked in the write's transaction, on every path.
 */
export const sharedRecordsHook: WriteHook = {
  name: 'shared-records',
  async afterRun({ ctx, tx, touched }) {
    const tenantId = ctx.principal.tenantId;
    for (const t of touched) {
      if (t.change === 'deleted') continue;
      const def = entityDef(t.type);
      if (!def || !isShared(def.spec)) continue;
      const sharedId = (t.after as Values | undefined)?.sharedId as string | null | undefined;
      if (!sharedId || sharedId === (t.before as Values | undefined)?.sharedId) continue;
      const columns = getTableColumns(def.table) as Record<string, Column>;
      const [target] = platformTenant
        ? await tx
            .select({ id: sql<string>`${columns.id}` })
            .from(def.table)
            .where(and(eq(columns.id, sharedId), eq(columns.tenantId, platformTenant)))
            .limit(1)
        : [];
      if (!target || tenantId === platformTenant)
        throw new BadRequestException({
          error: 'shared_override_invalid',
          message: `No shared ${def.spec.label} ${sharedId} to override`,
        });
      const [other] = await tx
        .select({ id: sql<string>`${columns.id}` })
        .from(def.table)
        .where(
          and(
            eq(columns.tenantId, String(tenantId)),
            eq(columns.sharedId, sharedId),
            ne(columns.id, t.id),
          ),
        )
        .limit(1);
      if (other)
        throw new ConflictException({
          error: 'shared_override_exists',
          message: `This business already overrides that shared ${def.spec.label}`,
          id: other.id,
        });
    }
  },
};
