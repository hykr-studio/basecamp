import type { DomainEventEnvelope } from '@hykr/contracts';
import { toEnvelope } from '@hykr/core';
import { domainEvents } from '@hykr/db';
import { Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { EventFeed, ServerContext } from '../../hooks.js';
import { failureOf } from './relay.service.js';

const log = new Logger('Events');

/** Rows that can never be relayed: kept with why, and left out of every later batch. */
async function markFailed(
  ctx: ServerContext,
  items: readonly { id: string; error: string }[],
  prefix: string,
) {
  for (const f of items)
    await ctx.db
      .update(domainEvents)
      .set({ failedAt: sql`now()`, error: f.error })
      .where(
        and(
          eq(domainEvents.id, f.id),
          eq(domainEvents.queues, prefix),
          isNull(domainEvents.relayedAt),
        ),
      );
}

/**
 * The durable outbox (`app.domain_events`, written in each write's transaction) as an event feed:
 * this queue prefix's committed events that are due, not withdrawn, not failed and not yet
 * relayed, oldest first. A row with a future `available_at` (an undo window) waits; one with
 * `cancelled_at` (an undone write) is never returned. Once on its subscribers' queues, a row gets
 * `relayed_at`. A row that is not an event (the envelope refuses it) gets `failed_at` and
 * `error` instead, and the rest of the batch goes on.
 */
export const outboxFeed: EventFeed = {
  name: 'outbox',
  pending: async ({ limit, prefix }, ctx) => {
    const rows = await ctx.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.queues, prefix),
          lte(domainEvents.availableAt, sql`now()`),
          isNull(domainEvents.relayedAt),
          isNull(domainEvents.cancelledAt),
          isNull(domainEvents.failedAt),
        ),
      )
      .orderBy(asc(domainEvents.seq))
      .limit(limit);
    const events: DomainEventEnvelope[] = [];
    const refused: { id: string; error: string }[] = [];
    for (const row of rows) {
      try {
        events.push(toEnvelope(row));
      } catch (e) {
        refused.push({ id: row.id, error: failureOf(e) });
      }
    }
    if (refused.length) {
      for (const f of refused) log.error(`feed outbox: event ${f.id}: ${f.error}`);
      await markFailed(ctx, refused, prefix);
    }
    return events;
  },
  relayed: async (ids, { prefix }, ctx) => {
    if (!ids.length) return;
    await ctx.db
      .update(domainEvents)
      .set({ relayedAt: sql`now()` })
      .where(and(inArray(domainEvents.id, [...ids]), eq(domainEvents.queues, prefix)));
  },
  failed: (items, { prefix }, ctx) => markFailed(ctx, items, prefix),
};
