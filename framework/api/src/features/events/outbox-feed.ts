import { toEnvelope } from '@hykr/core';
import { domainEvents } from '@hykr/db';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { EventFeed } from '../../hooks.js';

/**
 * The durable outbox (`app.domain_events`, written in each write's transaction) as an event feed:
 * this queue prefix's committed events that are due, not withdrawn and not yet relayed, oldest
 * first. A row with a future `available_at` (an undo window) waits; one with `cancelled_at`
 * (an undone write) is never returned. Once on its subscribers' queues, a row gets `relayed_at`.
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
        ),
      )
      .orderBy(asc(domainEvents.seq))
      .limit(limit);
    return rows.map(toEnvelope);
  },
  relayed: async (ids, { prefix }, ctx) => {
    if (!ids.length) return;
    await ctx.db
      .update(domainEvents)
      .set({ relayedAt: sql`now()` })
      .where(and(inArray(domainEvents.id, [...ids]), eq(domainEvents.queues, prefix)));
  },
};
