// An agent's definition against what this server has (its tools, entities, connections and
// schedules), and its triggers kept in step with it, both in the write's transaction.
import {
  AgentBudget,
  AgentCapabilities,
  AgentScope,
  AgentTrigger,
  FrameworkCapabilities,
  listInputSchema,
  type Principal,
} from '@hykr/contracts';
import { entityDef, type Tx, tenantZoneOf, type WriteHook } from '@hykr/core';
import { agentTriggers, integrationConnections } from '@hykr/db';
import { can } from '@hykr/policy';
import { BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';
import { connectorHandlers } from '../integrations/registry.js';
import { allToolIds, readableIn, unscoped } from './scope.js';
import { agentTemplates } from './templates.js';
import { cronProblem, firstDue, keptTriggers, resolveWhere } from './triggers.js';

/** The parts of a definition that say what it does. */
export const Definition = z.object({
  triggers: z.array(AgentTrigger),
  scope: AgentScope,
  budget: AgentBudget,
});
export type Definition = z.infer<typeof Definition>;

/**
 * Every problem with a definition, for its owner, with the business's time zone. `kept`: the
 * positions of triggers an edit keeps as they are (their rows stay), whose time may have passed
 * since (a `once` that fired): they fire nothing again. Everything else about them is checked.
 */
export async function definitionProblems(
  conn: Tx,
  a: {
    tenantId: string;
    owner: Principal;
    zone: string;
    def: Definition;
    template?: string | null;
    now?: Date;
    kept?: ReadonlySet<number>;
  },
): Promise<string[]> {
  const problems: string[] = [];
  const now = a.now ?? new Date();
  const { catalog } = runtime();
  const tools = new Set(allToolIds());
  const off = unscoped();
  for (const tool of a.def.scope.tools) {
    if (off.has(tool))
      problems.push(`scope: ${tool} manages agents or the canvas; no agent may use it`);
    else if (!tools.has(tool)) problems.push(`scope: there is no tool ${tool}`);
  }
  const reads = readableIn(a.def.scope.tools, catalog);
  for (const [i, t] of a.def.triggers.entries()) {
    const at = `triggers.${i} (${t.kind})`;
    if (t.kind === 'once' && !a.kept?.has(i) && new Date(t.at).getTime() < now.getTime() - 60_000)
      problems.push(`${at}: ${t.at} is in the past`);
    if (t.kind === 'recurring') {
      const why = cronProblem(t.cron, t.timeZone ?? a.zone);
      if (why) problems.push(`${at}: ${why}`);
    }
    if (t.kind === 'condition') {
      const def = entityDef(t.entity);
      if (!def) {
        problems.push(`${at}: there is no entity ${t.entity}`);
        continue;
      }
      if (!reads.has(t.entity))
        problems.push(`${at}: the scope has no tool that reads ${def.plural} (list-${def.plural})`);
      const parsed = listInputSchema(def.spec, { maxLimit: 100 }).safeParse(
        resolveWhere(t.where, now, a.zone),
      );
      if (!parsed.success) {
        const said = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`);
        problems.push(`${at}: ${said.join('; ')}`);
      } else {
        // A filter on a field the owner cannot see is refused, as their list would refuse it.
        for (const x of def.plugins())
          try {
            x.query?.(parsed.data, a.owner, { spec: def.spec, table: def.table });
          } catch (e) {
            problems.push(`${at}: ${e instanceof Error ? e.message : String(e)}`);
          }
      }
    }
    if (t.kind === 'message' && !can(a.owner, FrameworkCapabilities.backOffice))
      problems.push(
        `${at}: only someone who works in the back office may have agents read messages`,
      );
    if (t.kind === 'webhook') {
      const [connection] = await conn
        .select({ connector: integrationConnections.connector })
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, t.connectionId),
            eq(integrationConnections.tenantId, a.tenantId),
          ),
        );
      if (!connection) problems.push(`${at}: there is no connection ${t.connectionId}`);
      else if (!connectorHandlers.has(`agents.${connection.connector}`))
        problems.push(`${at}: agents do not take events from ${connection.connector} connections`);
    }
  }
  if (a.template && !agentTemplates.has(a.template))
    problems.push(`template: there is no agent template ${a.template}`);
  return problems;
}

type Row = {
  id: string;
  tenantId: string;
  ownerId: string;
  triggers: unknown;
  scope: unknown;
  budget: unknown;
  status: string;
  template?: string | null;
};

const storedTriggers = (tx: Tx, agentId: string) =>
  tx.select().from(agentTriggers).where(eq(agentTriggers.agentId, agentId));

/**
 * The definition's triggers as rows: one per position. A trigger that did not change keeps its
 * row (its id, when it fires next, a condition's records seen), whatever order its keys come
 * back in and wherever it moved (`keptTriggers`); a changed or new one starts again. A change of
 * `status` alone changes no trigger.
 */
async function syncTriggers(tx: Tx, row: Row, zone: string, now: Date) {
  const triggers = z.array(AgentTrigger).parse(row.triggers);
  const stored = await storedTriggers(tx, row.id);
  const kept = keptTriggers(stored, triggers);
  const keep = new Set(kept);
  for (const gone of stored)
    if (!keep.has(gone)) await tx.delete(agentTriggers).where(eq(agentTriggers.id, gone.id));
  // A kept row that moved goes through a negative position first: (agent, position) is unique.
  const moved = kept.flatMap((r, position) =>
    r && r.position !== position ? [{ id: r.id, position }] : [],
  );
  for (const m of moved)
    await tx
      .update(agentTriggers)
      .set({ position: -1 - m.position })
      .where(eq(agentTriggers.id, m.id));
  for (const m of moved)
    await tx.update(agentTriggers).set({ position: m.position }).where(eq(agentTriggers.id, m.id));
  for (const [position, t] of triggers.entries()) {
    if (kept[position]) continue;
    await tx.insert(agentTriggers).values({
      tenantId: row.tenantId,
      agentId: row.id,
      position,
      kind: t.kind,
      spec: t,
      nextAt: firstDue(t, zone, now),
      queues: config.queuePrefix,
    });
  }
}

const OPS = new Set(['agent.create', 'agent.update']);

/**
 * Every create and update of an agent, parked or run: the definition as it would be is checked
 * against this server (400 `invalid_agent`, nothing written or parked). A write that ran syncs the
 * triggers in its transaction. A change of `status` alone is not checked again, and an edit does
 * not hold the time of a trigger it keeps (a `once` that fired) against it.
 */
export const AgentDefinitions: WriteHook = {
  name: 'agents.definitions',
  afterRun: async ({ tx, op, input, loaded, result, touched, ctx }) => {
    if (!OPS.has(String(op.name))) return;
    const before = (loaded ?? null) as Row | null;
    const given = (input ?? {}) as Partial<Row> & Record<string, unknown>;
    const changes = Object.keys(given).filter((k) => given[k] !== undefined);
    const p = ctx.principal;
    const tenantId = before?.tenantId ?? p.tenantId ?? '';
    // Schedules without their own zone run in the business's (`tenantZone`).
    const zone = await tenantZoneOf(tx, tenantId);
    if (!before || changes.some((k) => k !== 'status')) {
      const def = Definition.safeParse({
        triggers: given.triggers ?? before?.triggers ?? [],
        scope: given.scope ?? before?.scope ?? { tools: [] },
        budget: given.budget ?? before?.budget ?? {},
      });
      // The triggers this edit keeps as they are, as `syncTriggers` will keep them.
      const kept = new Set<number>();
      if (before && def.success)
        for (const [i, r] of keptTriggers(
          await storedTriggers(tx, before.id),
          def.data.triggers,
        ).entries())
          if (r) kept.add(i);
      const problems = def.success
        ? await definitionProblems(tx, {
            tenantId,
            owner: p,
            zone,
            def: def.data,
            template: before ? null : (given.template as string | null | undefined),
            kept,
          })
        : def.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      if (problems.length)
        throw new BadRequestException({
          error: 'invalid_agent',
          message: problems.join('; '),
          problems,
        });
    }
    if (result.status !== 'done') return;
    const written = touched.find((t) => t.type === 'agent')?.after as Row | undefined;
    if (written) await syncTriggers(tx, written, zone, new Date());
  },
};

/** Does this principal manage every agent of its business? */
export const managesAgents = (p: Principal) => can(p, AgentCapabilities.manage);
