import { HistoryEntry, type Principal } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { type Database, events } from '@app/db';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, eq, or } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DB } from '../../infra/db.module.js';

class HistoryQuery extends createZodDto(
  z.object({ resourceType: z.enum(['todo', 'note', 'meeting']), resourceId: z.uuid() }),
) {}

/**
 * A record's history from the audit trail: who asked, who approved, what happened.
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
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.resourceType, q.resourceType),
          eq(events.resourceId, q.resourceId),
          or(eq(events.actorId, me), eq(events.actingFor, me)),
        ),
      )
      .orderBy(asc(events.at))
      .limit(50);
    return rows.map((r) =>
      HistoryEntry.parse({
        at: r.at.toISOString(),
        action: r.action,
        actor: r.actorKind === 'agent' ? 'assistant' : 'you',
        approvedByYou: r.approvedBy === me,
        outcome: r.outcome,
        reason: r.reason,
        runId: r.runId,
      }),
    );
  }
}
