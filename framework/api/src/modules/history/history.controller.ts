import {
  FrameworkCapabilities,
  HistoryEntry,
  isFrozen,
  type Principal,
  RecordVersion,
  revisionFields,
  statesOf,
  versionedOf,
  versionField,
} from '@hykr/contracts';
import {
  CurrentPrincipal,
  entityDef,
  HumanOnlyGuard,
  PrincipalGuard,
  projectRead,
  seriesIds,
} from '@hykr/core';
import { type Database, events } from '@hykr/db';
import { can } from '@hykr/policy';
import { Controller, Get, Inject, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DB } from '../../infra/db.module.js';
import { runtime } from '../../runtime.js';

const { entityNames } = runtime().catalog;

class HistoryQuery extends createZodDto(
  z
    .object({
      // One record: any entity in the catalog (the application's and the framework's).
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

class VersionsQuery extends createZodDto(
  z.object({ resourceType: z.enum(entityNames), resourceId: z.uuid() }),
) {}

/** A line that moved a record's state: the state field before and after. */
function moved(
  resourceType: string,
  before: unknown,
  after: unknown,
): { from: string | null; to: string } | null {
  const def = entityDef(resourceType);
  const trait = def ? statesOf(def.spec) : undefined;
  if (!trait || !after || typeof after !== 'object') return null;
  const to = (after as Record<string, unknown>)[trait.field];
  const from =
    before && typeof before === 'object'
      ? (before as Record<string, unknown>)[trait.field]
      : undefined;
  if (typeof to !== 'string' || from === to) return null;
  return { from: typeof from === 'string' ? from : null, to };
}

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

/** A stored row as this person may see it: a hidden field never names a line in the feed. */
function seenBy(p: Principal, resourceType: string, row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const values = row as Record<string, unknown>;
  return entityDef(resourceType)?.project(values, p) ?? projectRead(resourceType, values, p);
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

  /**
   * The revisions of a versioned record's series, oldest first: each one the person may read,
   * as the entity reads it for them (another business's record, or one they cannot read, is a
   * 404, and so are revisions they cannot read left out).
   */
  @Get('versions')
  async versions(
    @CurrentPrincipal() p: Principal,
    @Query() q: VersionsQuery,
  ): Promise<RecordVersion[]> {
    const def = entityDef(q.resourceType);
    const trait = def ? versionedOf(def.spec) : undefined;
    if (!def || !trait)
      throw new NotFoundException({ error: 'not_found', message: 'No versions of that' });
    const row = (await def.repo.get(this.db, p, q.resourceId)) as Record<string, unknown>;
    const rev = revisionFields(trait);
    const states = statesOf(def.spec);
    const out: RecordVersion[] = [];
    for (const id of await seriesIds(this.db, def, row)) {
      const r = (await def.repo.find(this.db, p, id)) as Record<string, unknown> | undefined;
      if (!r) continue;
      out.push(
        RecordVersion.parse({
          id,
          revision: rev ? Number(r[rev.number] ?? 1) : 1,
          version: Number(r[versionField(trait)] ?? 1),
          frozen: isFrozen(trait, r),
          state: states ? String(r[states.field] ?? '') || null : null,
          current: id === q.resourceId,
          record: def.toRead(r as never, p),
        }),
      );
    }
    return out;
  }

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: HistoryQuery): Promise<HistoryEntry[]> {
    const me = p.actor.id;
    // In this business: what you (or the assistant for you) did; `history.all` (ops and admins
    // by default) sees the whole business's.
    const everyone = can(p, FrameworkCapabilities.wholeHistory);
    const one = q.resourceType && q.resourceId;
    const scope = and(
      eq(events.tenantId, p.tenantId ?? ''),
      everyone ? undefined : or(eq(events.actorId, me), eq(events.actingFor, me)),
    );
    const found = await this.db
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
    const rows = found.map((r) => ({
      ...r,
      before: seenBy(p, r.resourceType, r.before),
      after: seenBy(p, r.resourceType, r.after),
    }));
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
        .select({
          id: events.resourceId,
          type: events.resourceType,
          before: events.before,
          after: events.after,
        })
        .from(events)
        .where(and(scope, inArray(events.resourceId, unnamed)))
        .orderBy(desc(events.at));
      for (const n of named) {
        const title = titleOf(seenBy(p, n.type, n.before), seenBy(p, n.type, n.after));
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
        transition: moved(r.resourceType, r.before, r.after),
      }),
    );
  }
}
