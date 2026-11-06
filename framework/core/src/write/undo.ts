// Undoing a write within its undo window (an approval level's `undoMs`, or a decision's own).
// A write that ran with a window and touched only served entities records what it changed
// (before and after) and holds back its events; the person it was for can reverse it with
// `POST /api/undo/:id` until the window closes. The reversal is a write like any other: it goes
// through runWrite, entity rules and scope apply, and every row it changes is audited. Its
// held events are withdrawn, so subscribers never see the write at all.
import {
  type AuthorizeResult,
  type Principal,
  type UndoResult,
  type UndoTicket,
} from '@hykr/contracts';
import { type Database, domainEvents, undoWindows } from '@hykr/db';
import { subjectOf, userIdOf } from '@hykr/policy';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type Table,
} from 'drizzle-orm';
import { z } from 'zod';
import { allow, RuleDenied } from '../authorize.js';
import { EntityEvent } from '../entity/cqrs-classes.js';
import { type AnyEntityDef, toJson } from '../entity/define-entity.js';
import { entityDef } from '../entity/registry.js';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { runWrite, type Touched, type WriteOp } from './pipeline.js';

type Values = Record<string, unknown>;
type WindowRow = typeof undoWindows.$inferSelect;
type StoredTouch = {
  type: string;
  id: string;
  change: Touched['change'];
  before: unknown;
  after: unknown;
};

/** A window is forgotten this long after it closes. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * How long this write can be undone, or 0: it ran (not parked, not an approved replay, not the
 * framework's own), with an undo window, for a person (a contact has no app to undo in), and
 * every row it touched is a served entity's (the reversal goes through the entity).
 */
export function undoWindowMs(
  p: Principal,
  op: Pick<WriteOp<unknown, unknown, unknown>, 'system'>,
  decision: AuthorizeResult,
  touched: readonly Touched[],
): number {
  if (decision.decision !== 'allow' || !decision.undoMs) return 0;
  if (p.approvedBy || op.system) return 0;
  if (subjectOf(p)?.kind !== 'user' || !p.tenantId) return 0;
  if (!touched.length || touched.some((t) => !entityDef(t.type))) return 0;
  return decision.undoMs;
}

/** Record the window, in the write's transaction. */
export async function openUndoWindow(
  tx: Tx,
  a: {
    p: Principal;
    op: Pick<WriteOp<unknown, unknown, unknown>, 'name' | 'resourceType'>;
    resourceId: string | null;
    touched: readonly Touched[];
    eventIds: readonly string[];
    undoMs: number;
    requestId: string;
  },
): Promise<UndoTicket> {
  const until = new Date(Date.now() + a.undoMs);
  const touched: StoredTouch[] = a.touched.map((t) => ({
    type: t.type,
    id: t.id,
    change: t.change,
    before: toJson(t.before) ?? null,
    after: toJson(t.after) ?? null,
  }));
  const [row] = await tx
    .insert(undoWindows)
    .values({
      tenantId: a.p.tenantId ?? '',
      userId: userIdOf(a.p) ?? '',
      action: a.op.name,
      resourceType: a.op.resourceType,
      resourceId: a.resourceId,
      touched,
      eventIds: [...a.eventIds],
      requestId: a.requestId,
      until,
    })
    .returning({ id: undoWindows.id });
  return { id: row.id, until: until.toISOString() };
}

/** JSON with its keys in order, so a row read again compares equal to the one stored. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as Values)
          .sort()
          .map((k) => [k, sort((v as Values)[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(toJson(value)));
}

const changedSince = () =>
  new ConflictException({
    error: 'changed_since',
    reason: 'It changed after that, so it cannot be undone',
  });

/** A stored row (JSON) as column values: only real columns, timestamps as dates again. */
function columnsOf(def: AnyEntityDef, json: Values): Values {
  const columns = getTableColumns(def.table as Table) as Record<string, { columnType: string }>;
  const out: Values = {};
  for (const [key, value] of Object.entries(json)) {
    const c = columns[key];
    if (!c || value === undefined) continue;
    out[key] =
      typeof value === 'string' && c.columnType === 'PgTimestamp' ? new Date(value) : value;
  }
  return out;
}

/** The fields of the entity's update schema that a write changed, with their earlier values. */
function revertPatch(def: AnyEntityDef, before: Values, after: Values): Values {
  const shape = (def.spec.schemas.update as z.ZodObject).shape as Record<string, unknown>;
  const patch: Values = {};
  for (const key of Object.keys(shape))
    if (canonical(before[key]) !== canonical(after[key])) patch[key] = before[key] ?? null;
  return patch;
}

/**
 * Reverse one touched row, scoped to the person undoing it: a created row is deleted, an
 * updated one gets its changed fields back, a deleted one is put back as it was (same id).
 * Each refuses when the row changed since (409). Returns the reversal's touched row and its
 * in-process event.
 */
async function reverse(
  tx: Tx,
  p: Principal,
  t: StoredTouch,
): Promise<{ touched?: Touched; event?: EntityEvent }> {
  const def = entityDef(t.type);
  if (!def) throw new ConflictException({ error: 'not_undoable', reason: 'It cannot be undone' });
  const via = { via: 'write.undo' };
  const after = (t.after ?? {}) as Values;
  const before = (t.before ?? {}) as Values;
  const event = (change: Touched['change'], row: unknown, was?: unknown) =>
    def.events ? new EntityEvent(def.name, change, row, was) : undefined;

  if (t.change === 'created' || t.change === 'updated') {
    const current = await def.repo.find(tx, p, t.id);
    if (!current || canonical(current) !== canonical(after)) throw changedSince();
    if (t.change === 'created') {
      const gone = await def.repo.delete(tx, p, current, via);
      return {
        touched: { type: def.name, id: t.id, change: 'deleted', before: current },
        event: event('deleted', gone, current),
      };
    }
    const patch = revertPatch(def, before, after);
    if (!Object.keys(patch).length) return {};
    let restored: Values;
    try {
      restored = await def.repo.update(tx, p, current, patch, via);
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new ConflictException({ error: 'not_undoable', reason: 'It cannot be undone' });
      throw e;
    }
    return {
      touched: { type: def.name, id: t.id, change: 'updated', before: current, after: restored },
      event: event('updated', restored, current),
    };
  }

  // Deleted: put it back as it was, in this business only, if its rules let this person make it.
  if (before.tenantId !== p.tenantId) throw changedSince();
  if (await def.repo.find(tx, p, t.id)) throw changedSince();
  const createShape = (def.spec.schemas.create as z.ZodObject).shape as Record<string, unknown>;
  const asInput = Object.fromEntries(Object.keys(createShape).map((k) => [k, before[k]]));
  const decision = def.decide(p, 'create', null, asInput);
  if (decision.decision === 'deny') throw new RuleDenied(decision);
  const [back] = await tx
    .insert(def.table as Table)
    .values(columnsOf(def, before) as never)
    .returning();
  return {
    touched: { type: def.name, id: t.id, change: 'created', after: back },
    event: event('created', back),
  };
}

const UndoInput = z.object({ id: z.string() });

/** Undoes writes within their undo window. People only; the person the write was for. */
@Injectable()
export class UndoService {
  private readonly db: Database;
  constructor(
    @Inject(CORE_OPTIONS) options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
  ) {
    this.db = options.db;
  }

  /**
   * Undo it. Another business's or another person's window is a 404; once undone, 409
   * `already_undone`; after its window, 403 `undo_window_closed`; a row changed since, or an
   * event already passed on, 409 (`changed_since`, `too_late`). Nothing is changed then.
   */
  async undo(p: Principal, id: string, requestId: string): Promise<UndoResult> {
    const self = userIdOf(p);
    if (!self || !p.tenantId) throw notFound();
    const [found] = await this.db
      .select()
      .from(undoWindows)
      .where(mine(p, self, id));
    if (!found) throw notFound();
    check(found);
    const published: EntityEvent[] = [];
    const { result } = await runWrite(
      this.db,
      { principal: p, requestId },
      undoOp(found, self, published),
      {
        id,
      },
    );
    if (result.status !== 'done')
      throw new ConflictException({ error: 'not_undoable', reason: 'It cannot be undone' });
    // In-process listeners (scheduled reminders) catch up; nothing was stored for subscribers.
    for (const event of published) this.events.publish(event);
    return result.value as UndoResult;
  }

  /** Forget windows closed for a day. Returns how many. */
  async forgetClosed(): Promise<number> {
    const gone = await this.db
      .delete(undoWindows)
      .where(lt(undoWindows.until, new Date(Date.now() - KEEP_MS)))
      .returning({ id: undoWindows.id });
    return gone.length;
  }
}

const notFound = () => new NotFoundException({ error: 'not_found', message: 'Nothing to undo' });

const mine = (p: Principal, self: string, id: string) =>
  and(
    eq(undoWindows.id, id),
    eq(undoWindows.tenantId, p.tenantId ?? ''),
    eq(undoWindows.userId, self),
  );

function check(w: WindowRow) {
  if (w.undoneAt)
    throw new ConflictException({ error: 'already_undone', reason: 'It was already undone' });
  if (w.until.getTime() <= Date.now())
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'undo_window_closed',
      reason: 'It can no longer be undone',
    });
}

/** The undo as a write: locked, checked again, then each row reversed (last first). */
function undoOp(
  w: WindowRow,
  self: string,
  published: EntityEvent[],
): WriteOp<{ id: string }, WindowRow, UndoResult> {
  return {
    name: 'write.undo',
    kind: 'command',
    system: true,
    resourceType: w.resourceType,
    resourceId: () => w.resourceId,
    input: UndoInput,
    async load(tx, p, input) {
      const [locked] = await tx
        .select()
        .from(undoWindows)
        .where(mine(p, self, input.id))
        .for('update');
      if (!locked) throw notFound();
      check(locked);
      return locked;
    },
    authorize: () => allow('undo_own_write', 'Undone by the person it was for, in time'),
    summarize: () => `Undo ${w.action}`,
    async run({ tx, principal, loaded }) {
      const held = loaded.eventIds;
      if (held.length) {
        const [passed] = await tx
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(and(inArray(domainEvents.id, held), isNotNull(domainEvents.relayedAt)))
          .limit(1);
        if (passed)
          throw new ConflictException({
            error: 'too_late',
            reason: 'It was already passed on, so it cannot be undone',
          });
        await tx
          .update(domainEvents)
          .set({ cancelledAt: sql`now()` })
          .where(and(inArray(domainEvents.id, held), isNull(domainEvents.relayedAt)));
      }
      const touched: Touched[] = [];
      for (const t of [...(loaded.touched as StoredTouch[])].reverse()) {
        const out = await reverse(tx, principal, t);
        if (out.touched) touched.push(out.touched);
        if (out.event) published.push(out.event);
      }
      await tx
        .update(undoWindows)
        .set({ undoneAt: new Date() })
        .where(eq(undoWindows.id, loaded.id));
      return {
        value: {
          id: loaded.id,
          undone: true,
          action: loaded.action,
          resourceType: loaded.resourceType,
          resourceId: loaded.resourceId,
        },
        touched,
      };
    },
    present: (value) => value,
  };
}
