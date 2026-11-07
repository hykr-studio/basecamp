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
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';

class SlaListQuery extends createZodDto(SlaQuery) {}

const byPlural = (plural: string): AnyEntityDef | undefined =>
  entityDefs().find((d) => d.plural === plural);

/** Timers read at a time while looking for ones on records the caller reads. */
const PAGE = 100;

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
    // Ended or not is decided here, before any limit: a client that dropped ended breaches
    // itself would get none once the earliest `limit` had all ended.
    const where = and(
      eq(slaTimers.tenantId, tenantOf(p)),
      eq(slaTimers.status, q.status),
      q.resourceType ? eq(slaTimers.resourceType, q.resourceType) : undefined,
      q.open === undefined
        ? undefined
        : q.open
          ? isNull(slaTimers.endedAt)
          : isNotNull(slaTimers.endedAt),
    );
    // Each record through its entity's scoped read: a timer on a record they can't read is not
    // theirs to see, and an unknown type is never shown. Page on until `limit` readable ones are
    // found or the timers run out, so others' earlier clocks never hide the caller's own.
    const readable = new Map<string, boolean>();
    const seen = new Set<string>();
    const out: SlaTimer[] = [];
    for (let page = 0; ; page++) {
      const rows = await db
        .select()
        .from(slaTimers)
        .where(where)
        .orderBy(asc(slaTimers.dueAt), asc(slaTimers.id))
        .limit(PAGE)
        .offset(page * PAGE);
      for (const r of rows) {
        // A timer that changed between pages can shift by one: never list it twice.
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const key = `${r.resourceType}:${r.resourceId}`;
        if (!readable.has(key)) {
          const def = entityDef(r.resourceType);
          readable.set(key, Boolean(def && (await def.repo.find(db, p, r.resourceId))));
        }
        if (readable.get(key)) out.push(timerOut(r));
        if (out.length >= q.limit) return out;
      }
      if (rows.length < PAGE) return out;
    }
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
