import { entityNames, HistoryEntry, type Principal } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { type Database, events } from '@app/db';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DB } from '../../infra/db.module.js';

class HistoryQuery extends createZodDto(
  z
    .object({
      // One record: any entity in the catalog (the domain's and the framework's).
      resourceType: z.enum(entityNames).optional(),
      resourceId: z.uuid().optional(),
      // Without a record: the latest across every record, since a moment, by one actor.
      since: z.iso.datetime().optional(),
      actor: z.enum(['assistant', 'you']).optional(),
    })
    .refine((q) => Boolean(q.resourceType) === Boolean(q.resourceId), {
      message: 'resourceType and resourceId go together',
    }),
) {}

/** The record's name as it was written, for a line in a feed ("Site review"). */
function titleOf(before: unknown, after: unknown): string | null {
  for (const row of [after, before]) {
    if (row && typeof row === 'object') {
      const r = row as { title?: unknown; name?: unknown };
      if (typeof r.title === 'string') return r.title;
      if (typeof r.name === 'string') return r.name;
    }
  }
  return null;
}

/**
 * A record's history from the audit trail: who asked, who approved, what happened. Without a
 * record, the latest 20 across every record (Today's "what the assistant did"), newest first.
 * Scoped to rows the person did or that were done for them; people only.
 */
@Controller('api/history')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class HistoryController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: HistoryQuery): Promise<HistoryEntry[]> {
    const me = p.actor.id;
    // In this business: what you (or the assistant for you) did; ops see the whole business's.
    const everyone = (p.roles ?? []).some((r) => r === 'ops' || r === 'admin');
    const one = q.resourceType && q.resourceId;
    const scope = and(
      eq(events.tenantId, p.tenantId ?? ''),
      everyone ? undefined : or(eq(events.actorId, me), eq(events.actingFor, me)),
    );
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          scope,
          one ? eq(events.resourceType, q.resourceType as string) : undefined,
          one ? eq(events.resourceId, q.resourceId as string) : undefined,
          // A feed lists records only (not, say, a voice session's start and end).
          one ? undefined : inArray(events.resourceType, entityNames),
          q.since ? gt(events.at, new Date(q.since)) : undefined,
          q.actor ? eq(events.actorKind, q.actor === 'assistant' ? 'agent' : 'user') : undefined,
        ),
      )
      .orderBy(one ? asc(events.at) : desc(events.at))
      .limit(one ? 50 : 20);
    // A request or a delete carries no row: name the record from its latest line that does.
    const titles = new Map<string, string>();
    const unnamed = [
      ...new Set(
        rows
          .filter((r) => r.resourceId && !titleOf(r.before, r.after))
          .map((r) => r.resourceId as string),
      ),
    ];
    if (!one && unnamed.length) {
      const named = await this.db
        .select({ id: events.resourceId, before: events.before, after: events.after })
        .from(events)
        .where(and(scope, inArray(events.resourceId, unnamed)))
        .orderBy(desc(events.at));
      for (const n of named) {
        const title = titleOf(n.before, n.after);
        if (n.id && title && !titles.has(n.id)) titles.set(n.id, title);
      }
    }
    return rows.map((r) =>
      HistoryEntry.parse({
        at: r.at.toISOString(),
        action: r.action,
        actor: r.actorKind === 'agent' ? 'assistant' : 'you',
        approvedByYou: r.approvedBy === me,
        outcome: r.outcome,
        reason: r.reason,
        runId: r.runId,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        title:
          titleOf(r.before, r.after) ?? (r.resourceId ? titles.get(r.resourceId) : null) ?? null,
      }),
    );
  }
}
