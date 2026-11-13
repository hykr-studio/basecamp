// SLA timers (B6): a clock per SLA a record starts when it enters a state, ended when it leaves,
// all in the write's own transaction (the `sla` write hook), and a sweeper that breaches the
// ones that run out, stores the breach event and runs the escalation's transition as the
// system principal. docs/decisions/B6B4.md.
import {
  addBusinessTime,
  BusinessHours,
  type Duration,
  durationMs,
  openHoursOf,
  type Principal,
  type SlaDecl,
  SlaSettings,
  type SlaTimer,
  slasIn,
  statesOf,
} from '@hykr/contracts';
import { type AuditInput, type Database, schema, slaTimers, writeAuditMany } from '@hykr/db';
import { and, type Column, eq, getTableColumns, isNull, lte, sql, type Table } from 'drizzle-orm';
import type { NamedEvent } from '../entity/cqrs-classes.js';
import type { AnyEntityDef } from '../entity/define-entity.js';
import { entityDef } from '../entity/registry.js';
import type { WriteHook } from '../hooks.js';
import { systemPrincipal } from '../system.js';
import { tenantZone } from '../tenants/time-zone.js';
import type { Conn, Tx } from '../tokens.js';
import { eventQueues, recordEvents } from '../write/events.js';
import { runWrite } from '../write/pipeline.js';
import { transitionOp } from './transition.js';

type Values = Record<string, unknown>;
type TimerRow = typeof slaTimers.$inferSelect;

/** What SLA clocks need of a business's settings: its zone, open hours and SLA overrides. */
export interface SlaConfig {
  timeZone: string;
  hours: BusinessHours;
  sla: SlaSettings;
}

/**
 * A business's SLA settings, read now in the caller's transaction. A section that does not
 * parse falls back to its default (every hour counts, the module's durations; the zone is
 * `tenantZone`'s): a bad setting never stops a write, and the clock never runs later than
 * declared.
 */
export async function slaConfig(conn: Conn, tenantId: string): Promise<SlaConfig> {
  const [row] = await conn
    .select({ settings: schema.tenants.settings })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  const stored = (row?.settings ?? {}) as Record<string, unknown>;
  const hours = BusinessHours.safeParse(stored.businessHours);
  const sla = SlaSettings.safeParse(stored.sla);
  return {
    timeZone: tenantZone(stored),
    hours: hours.success ? hours.data : BusinessHours.parse(undefined),
    sla: sla.success ? sla.data : SlaSettings.parse(undefined),
  };
}

/** When an SLA started now is due in this business, or null when the business switched it off. */
export function dueAt(decl: SlaDecl, at: Date, config: SlaConfig): Date | null {
  if (config.sla.off.includes(decl.name)) return null;
  const ms = durationMs((config.sla.within[decl.name] as Duration | undefined) ?? decl.within);
  return decl.hours === 'business'
    ? addBusinessTime(at, ms, openHoursOf(config.hours), config.timeZone)
    : new Date(at.getTime() + ms);
}

/** The timers of one record, as clients read them. */
export const timerOut = (r: TimerRow): SlaTimer => ({
  id: r.id,
  sla: r.sla,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  state: r.state,
  status: r.status,
  hours: r.hours,
  startedAt: r.startedAt.toISOString(),
  dueAt: r.dueAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
  breachedAt: r.breachedAt?.toISOString() ?? null,
  escalationError: r.escalationError,
});

/** Start the SLAs of the state a record entered. */
async function start(
  tx: Tx,
  a: { tenantId: string; def: AnyEntityDef; id: string; state: string; at: Date },
  config: () => Promise<SlaConfig>,
) {
  const trait = statesOf(a.def.spec);
  const slas = trait ? slasIn(trait, a.state) : [];
  if (!slas.length) return;
  const c = await config();
  const rows = slas.flatMap((decl) => {
    const due = dueAt(decl, a.at, c);
    return due
      ? [
          {
            tenantId: a.tenantId,
            resourceType: a.def.name,
            resourceId: a.id,
            sla: decl.name,
            state: a.state,
            hours: decl.hours ?? 'all',
            startedAt: a.at,
            dueAt: due,
            escalate: decl.escalate ?? null,
            queues: eventQueues(),
          },
        ]
      : [];
  });
  if (rows.length) await tx.insert(slaTimers).values(rows as never);
}

/**
 * End a record's running clocks: those of the state it left (`met`, or `breached` when their
 * time had already passed), or all of them when it was deleted (`cancelled`, a breach stays).
 */
async function end(
  tx: Tx,
  a: { tenantId: string; type: string; id: string; state?: string; at: Date; deleted?: boolean },
) {
  const late = sql`${slaTimers.status} = 'running' and ${slaTimers.dueAt} <= ${a.at}`;
  await tx
    .update(slaTimers)
    .set({
      endedAt: a.at,
      status: a.deleted
        ? sql`case when ${slaTimers.status} = 'running' then 'cancelled' else ${slaTimers.status} end`
        : sql`case when ${late} then 'breached' when ${slaTimers.status} = 'running' then 'met' else ${slaTimers.status} end`,
      breachedAt: a.deleted
        ? sql`${slaTimers.breachedAt}`
        : sql`case when ${late} then ${slaTimers.dueAt} else ${slaTimers.breachedAt} end`,
    } as never)
    .where(
      and(
        eq(slaTimers.tenantId, a.tenantId),
        eq(slaTimers.resourceType, a.type),
        eq(slaTimers.resourceId, a.id),
        isNull(slaTimers.endedAt),
        a.state === undefined ? undefined : eq(slaTimers.state, a.state),
      ),
    );
}

const asRow = (v: unknown): Values | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Values) : undefined;

/**
 * Every write passes here, in its transaction, after its audit rows: each touched record of an
 * entity with states that entered a state starts that state's SLAs, and one that left a state
 * ends its clocks. A record created starts its initial state's; one deleted cancels them all.
 * Before and after come from the write's `touched`.
 */
export const slaHook: WriteHook = {
  name: 'sla',
  async afterRun({ ctx, tx, touched, result }) {
    if (result.status !== 'done' || !touched.length) return;
    const at = new Date();
    let config: SlaConfig | undefined;
    for (const t of touched) {
      const def = entityDef(t.type);
      const trait = def ? statesOf(def.spec) : undefined;
      if (!def || !trait) continue;
      const before = asRow(t.before);
      const after = asRow(t.after);
      const tenantId = String(after?.tenantId ?? before?.tenantId ?? ctx.principal.tenantId ?? '');
      if (!tenantId) continue;
      const settings = async () => {
        config ??= await slaConfig(tx, tenantId);
        return config;
      };
      if (t.change === 'deleted') {
        await end(tx, { tenantId, type: def.name, id: t.id, at, deleted: true });
        continue;
      }
      const to = after?.[trait.field];
      if (typeof to !== 'string') continue;
      const from = t.change === 'created' ? undefined : before?.[trait.field];
      if (t.change !== 'created' && (from === undefined || from === to)) continue;
      if (typeof from === 'string')
        await end(tx, { tenantId, type: def.name, id: t.id, state: from, at });
      await start(tx, { tenantId, def, id: t.id, state: to, at }, settings);
    }
  },
};

/**
 * '<entity>.sla.breached': an SLA ran out while its record was still in the state. The row is
 * the record as stored, with `sla` (the SLA's name, state, start, due time and escalation, whose
 * `notify`: the capabilities whose holders an application's notification tells).
 */
export class SlaBreached implements NamedEvent {
  readonly eventName: string;
  constructor(
    readonly resourceType: string,
    readonly row: Values,
  ) {
    this.eventName = `${resourceType}.sla.breached`;
  }
  get resourceId(): string {
    return String(this.row.id);
  }
}

/** What one sweep did. */
export interface SweepResult {
  breached: number;
  escalated: number;
  failed: number;
}

/**
 * Breach the clocks of this queue prefix that ran out by `now`, one transaction each (skipping
 * any another sweeper holds): mark it breached, store '<entity>.sla.breached', and run the
 * escalation's transition as the system principal in a savepoint. A refused escalation (the
 * record moved, a transition that would wait) is kept on the timer; the breach stands. The
 * events of each committed breach go to `publish` (the process's event bus).
 */
export async function sweepSla(
  db: Database,
  opts: { prefix: string; now?: Date; limit?: number; publish?: (events: object[]) => void },
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const out: SweepResult = { breached: 0, escalated: 0, failed: 0 };
  const due = await db
    .select({ id: slaTimers.id })
    .from(slaTimers)
    .where(
      and(
        eq(slaTimers.queues, opts.prefix),
        eq(slaTimers.status, 'running'),
        lte(slaTimers.dueAt, now),
      ),
    )
    .orderBy(slaTimers.dueAt)
    .limit(opts.limit ?? 100);
  for (const { id } of due) {
    const events = await db.transaction(async (tx) => {
      const [timer] = await tx
        .select()
        .from(slaTimers)
        .where(and(eq(slaTimers.id, id), eq(slaTimers.status, 'running')))
        .for('update', { skipLocked: true });
      if (!timer) return [];
      await tx
        .update(slaTimers)
        .set({ status: 'breached', breachedAt: now })
        .where(eq(slaTimers.id, id));
      out.breached++;
      const def = entityDef(timer.resourceType);
      if (!def) return [];
      const cols = getTableColumns(def.table) as Record<string, Column>;
      const [row] = (await tx
        .select()
        .from(def.table as Table)
        .where(
          and(eq(cols.id as Column, timer.resourceId), eq(cols.tenantId as Column, timer.tenantId)),
        )) as Values[];
      if (!row) return [];
      // It left the state without its write ending the clock (a command that did not list the
      // row's before and after): too late to escalate.
      const trait = statesOf(def.spec);
      if (trait && row[trait.field] !== timer.state) {
        await tx.update(slaTimers).set({ endedAt: now }).where(eq(slaTimers.id, id));
        return [];
      }
      const system: Principal = systemPrincipal({ tenantId: timer.tenantId, job: 'sla.escalate' });
      const requestId = `sla:${timer.id}`;
      const escalate = (timer.escalate ?? null) as {
        notify?: string[];
        transition?: string;
      } | null;
      const breach = new SlaBreached(def.name, {
        ...row,
        sla: {
          id: timer.id,
          name: timer.sla,
          state: timer.state,
          startedAt: timer.startedAt.toISOString(),
          dueAt: timer.dueAt.toISOString(),
          escalate,
        },
      });
      await recordEvents(tx, { principal: system, requestId, events: [breach] });
      const published: object[] = [breach];
      if (escalate?.transition) {
        // A refused escalation's audit row: written on this transaction, which outlives the
        // savepoint the refusal rolls back.
        const refusals: AuditInput[] = [];
        try {
          const done = await tx.transaction((sp) =>
            runWrite(
              db,
              {
                principal: system,
                requestId,
                outer: { tx: sp as Tx, refused: (audit) => refusals.push(audit) },
              },
              transitionOp(def, { id: timer.resourceId, transition: escalate.transition }),
              {},
            ),
          );
          published.push(...done.events);
          out.escalated++;
        } catch (e) {
          const body = (e as { getResponse?: () => unknown }).getResponse?.() as
            | { reason?: string; message?: string }
            | undefined;
          if (refusals.length) await writeAuditMany(tx, refusals);
          await tx
            .update(slaTimers)
            .set({ escalationError: body?.reason ?? body?.message ?? (e as Error).message })
            .where(eq(slaTimers.id, id));
          out.failed++;
        }
      }
      return published;
    });
    if (events.length) opts.publish?.(events);
  }
  return out;
}
