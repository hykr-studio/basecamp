import { type Principal, SlaQuery, type SlaTimer } from '@hykr/contracts';
import {
  type AnyEntityDef,
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  entityDef,
  entityDefs,
  PrincipalGuard,
  tenantOf,
  timerOut,
} from '@hykr/core';
import { slaTimers } from '@hykr/db';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, eq } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';

class SlaListQuery extends createZodDto(SlaQuery) {}

const byPlural = (plural: string): AnyEntityDef | undefined =>
  entityDefs().find((d) => d.plural === plural);

/**
 * SLA clocks, as the records they run on allow: a record's own (404 when the caller cannot read
 * it), and the business's breached or running ones on records the caller reads (a Today view).
 */
@Controller('api/sla')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class SlaController {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: SlaListQuery): Promise<SlaTimer[]> {
    const db = this.options.db;
    const rows = await db
      .select()
      .from(slaTimers)
      .where(
        and(
          eq(slaTimers.tenantId, tenantOf(p)),
          eq(slaTimers.status, q.status),
          q.resourceType ? eq(slaTimers.resourceType, q.resourceType) : undefined,
        ),
      )
      .orderBy(asc(slaTimers.dueAt))
      .limit(q.limit * 4);
    // Each record through its entity's scoped read: a timer on a record they can't read is not
    // theirs to see. An unknown type is never shown.
    const readable = new Map<string, boolean>();
    const out: SlaTimer[] = [];
    for (const r of rows) {
      const key = `${r.resourceType}:${r.resourceId}`;
      if (!readable.has(key)) {
        const def = entityDef(r.resourceType);
        readable.set(key, Boolean(def && (await def.repo.find(db, p, r.resourceId))));
      }
      if (readable.get(key)) out.push(timerOut(r));
      if (out.length >= q.limit) break;
    }
    return out;
  }

  @Get(':plural/:id')
  async of(
    @CurrentPrincipal() p: Principal,
    @Param('plural') plural: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SlaTimer[]> {
    const def = byPlural(plural);
    if (!def) throw new NotFoundException({ error: 'not_found', message: 'No such records' });
    const db = this.options.db;
    await def.repo.get(db, p, id);
    const rows = await db
      .select()
      .from(slaTimers)
      .where(
        and(
          eq(slaTimers.tenantId, tenantOf(p)),
          eq(slaTimers.resourceType, def.name),
          eq(slaTimers.resourceId, id),
        ),
      )
      .orderBy(asc(slaTimers.startedAt));
    return rows.map(timerOut);
  }
}
