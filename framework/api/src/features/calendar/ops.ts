// Every change to the calendar feature's own records goes through runWrite as one of these ops:
// connecting and disconnecting a calendar, making and revoking a feed. Each is the person's own
// (another person's is a 404), audited before and after, never with a token in it.
import type { Principal } from '@hykr/contracts';
import { allow, deny, type NamedEvent, registerOp, type Tx, type WriteOp } from '@hykr/core';
import {
  calendarConnections,
  calendarEventLinks,
  calendarFeeds,
  integrationConnections,
} from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';

export type ConnectionRow = typeof calendarConnections.$inferSelect;
export type FeedRow = typeof calendarFeeds.$inferSelect;

/** A stored event of the calendar feature (connections, links): ids and states only. */
export class CalendarEvent implements NamedEvent {
  constructor(
    readonly eventName: string,
    readonly row: Record<string, unknown>,
    readonly resourceType: string,
  ) {}
  get resourceId() {
    return typeof this.row.id === 'string' ? this.row.id : null;
  }
}

/** What leaves the API (and the audit trail) of a connection: never its tokens. */
export const connectionView = (r: ConnectionRow) => ({
  id: r.id,
  provider: r.provider as 'google',
  account: r.account,
  status: r.status as 'active' | 'needs_reauth' | 'stopped',
  push: !!r.channelId && !!r.channelExpiresAt && r.channelExpiresAt > new Date(),
  lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
  lastError: r.lastError,
  createdAt: r.createdAt.toISOString(),
});

export const feedView = (r: FeedRow) => ({
  id: r.id,
  label: r.label,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

const CONNECTION = 'calendarConnection';
const FEED = 'calendarFeed';
const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

/** The person themself, signed in: the assistant never manages calendars. Null when so. */
function notPerson(p: Principal) {
  const s = subjectOf(p);
  return s?.kind !== 'user' || p.actor.kind !== 'user'
    ? deny('people_only', 'Only the person manages their own calendars and feeds')
    : null;
}

const userOf = (p: Principal) => {
  const s = subjectOf(p);
  return s?.kind === 'user' ? s.userId : '';
};

const Sealed = z.string().min(1).max(20_000);

const ConnectInput = z.strictObject({
  id: z.uuid(),
  provider: z.literal('google'),
  account: z.string().min(1).max(320),
  scopes: z.array(z.string().max(200)).max(20),
  sealed: Sealed,
  /** The inbound connection for the provider's push notifications (B10), made with it. */
  inbound: z.strictObject({ id: z.uuid(), sealed: Sealed }),
});

/**
 * calendar.connection.connect: the person's calendar account, its tokens sealed. Connecting
 * again replaces them. Its push inbox (a B10 connection of `google-calendar`) is made with it.
 */
export function connectOp(): WriteOp<
  z.infer<typeof ConnectInput>,
  ConnectionRow | undefined,
  ConnectionRow
> {
  return {
    name: 'calendar.connection.connect',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: (input) => input.id,
    input: ConnectInput,
    load: async (tx, p, input) => {
      const [row] = await tx
        .select()
        .from(calendarConnections)
        .where(
          and(
            eq(calendarConnections.id, input.id),
            eq(calendarConnections.tenantId, p.tenantId ?? ''),
          ),
        );
      // An id of another person's connection is not theirs to replace.
      if (row && row.userId !== userOf(p)) throw notFound('calendar connection');
      return row;
    },
    authorize: (p) => notPerson(p) ?? allow('own_calendar', 'A person connects their own calendar'),
    summarize: (input) => `Connect the ${input.provider} calendar ${input.account}`,
    run: async ({ tx, principal: p, input, loaded }) => {
      const tenantId = p.tenantId as string;
      const userId = userOf(p);
      let inboundId = loaded?.inboundConnectionId ?? null;
      const touched = [];
      if (!inboundId) {
        const [inbound] = await tx
          .insert(integrationConnections)
          .values({
            id: input.inbound.id,
            tenantId,
            connector: 'google-calendar',
            label: `Google Calendar: ${input.account}`,
            credentialsSealed: input.inbound.sealed,
            public: { calendarConnectionId: input.id, userId, account: input.account },
            createdBy: userId,
          })
          .returning();
        inboundId = inbound.id;
        touched.push({
          type: 'integration_connection',
          id: inbound.id,
          change: 'created' as const,
          after: { connector: inbound.connector, label: inbound.label },
        });
      }
      const values = {
        provider: input.provider,
        account: input.account,
        scopes: input.scopes,
        tokensSealed: input.sealed,
        status: 'active',
        lastError: null,
        inboundConnectionId: inboundId,
        queues: config.queuePrefix,
        updatedAt: new Date(),
      };
      // Another account than before: what was read of the old one, and the events put there,
      // no longer apply (the caller takes those events out of the old account).
      const moved = loaded && loaded.account !== input.account;
      if (moved)
        await tx.delete(calendarEventLinks).where(eq(calendarEventLinks.connectionId, loaded.id));
      const [row] = loaded
        ? await tx
            .update(calendarConnections)
            .set({ ...values, ...(moved ? { syncToken: null } : {}) })
            .where(eq(calendarConnections.id, loaded.id))
            .returning()
        : await tx
            .insert(calendarConnections)
            .values({ id: input.id, tenantId, userId, ...values })
            .returning();
      touched.push({
        type: CONNECTION,
        id: row.id,
        change: loaded ? ('updated' as const) : ('created' as const),
        ...(loaded ? { before: connectionView(loaded) } : {}),
        after: connectionView(row),
      });
      return {
        value: row,
        touched,
        events: [
          new CalendarEvent(
            'calendar.connected',
            { id: row.id, tenantId, userId, provider: row.provider, account: row.account },
            CONNECTION,
          ),
        ],
      };
    },
    present: (row) => connectionView(row),
  };
}

const loadOwn = (id: string) => async (tx: Tx, p: Principal) => {
  const [row] = await tx
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.id, id),
        eq(calendarConnections.tenantId, p.tenantId ?? ''),
        eq(calendarConnections.userId, userOf(p)),
      ),
    );
  if (!row) throw notFound('calendar connection');
  return row;
};

type Id = { id?: string } | null;
const idOf = (args: Id) => {
  if (!args?.id) throw new Error('The operation needs the record id');
  return args.id;
};

/** calendar.connection.disconnect: the connection, its links and its push inbox, gone. */
export function disconnectOp(args: Id): WriteOp<Record<string, never>, ConnectionRow, null> {
  const id = idOf(args);
  return {
    name: 'calendar.connection.disconnect',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: () => id,
    input: z.strictObject({}),
    args: { id },
    load: loadOwn(id),
    authorize: (p) =>
      notPerson(p) ?? allow('own_calendar', 'A person disconnects their own calendar'),
    summarize: (_input, row) => `Disconnect the ${row.provider} calendar ${row.account}`,
    run: async ({ tx, loaded }) => {
      await tx.delete(calendarConnections).where(eq(calendarConnections.id, loaded.id));
      if (loaded.inboundConnectionId)
        await tx
          .delete(integrationConnections)
          .where(
            and(
              eq(integrationConnections.id, loaded.inboundConnectionId),
              eq(integrationConnections.tenantId, loaded.tenantId),
            ),
          );
      return {
        value: null,
        touched: [
          { type: CONNECTION, id: loaded.id, change: 'deleted', before: connectionView(loaded) },
        ],
        events: [
          new CalendarEvent(
            'calendar.disconnected',
            { id: loaded.id, tenantId: loaded.tenantId, userId: loaded.userId },
            CONNECTION,
          ),
        ],
      };
    },
    present: () => null,
  };
}

const FeedInput = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(100).optional(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/** calendar.feed.create: a private feed; only its token's hash is stored. */
export function createFeedOp(): WriteOp<z.infer<typeof FeedInput>, undefined, FeedRow> {
  return {
    name: 'calendar.feed.create',
    kind: 'command',
    resourceType: FEED,
    resourceId: (input) => input.id,
    input: FeedInput,
    authorize: (p) => notPerson(p) ?? allow('own_feed', 'A person makes their own calendar feed'),
    summarize: (input) => `Make a calendar feed${input.label ? ` (${input.label})` : ''}`,
    run: async ({ tx, principal: p, input }) => {
      const [row] = await tx
        .insert(calendarFeeds)
        .values({
          id: input.id,
          tenantId: p.tenantId as string,
          userId: userOf(p),
          label: input.label ?? null,
          tokenHash: input.tokenHash,
        })
        .returning();
      return {
        value: row,
        touched: [{ type: FEED, id: row.id, change: 'created', after: feedView(row) }],
      };
    },
    present: (row) => feedView(row),
  };
}

/** calendar.feed.revoke: the feed's URL stops working. */
export function revokeFeedOp(args: Id): WriteOp<Record<string, never>, FeedRow, null> {
  const id = idOf(args);
  return {
    name: 'calendar.feed.revoke',
    kind: 'command',
    resourceType: FEED,
    resourceId: () => id,
    input: z.strictObject({}),
    args: { id },
    load: async (tx, p) => {
      const [row] = await tx
        .select()
        .from(calendarFeeds)
        .where(
          and(
            eq(calendarFeeds.id, id),
            eq(calendarFeeds.tenantId, p.tenantId ?? ''),
            eq(calendarFeeds.userId, userOf(p)),
          ),
        );
      if (!row) throw notFound('calendar feed');
      return row;
    },
    authorize: (p) => notPerson(p) ?? allow('own_feed', 'A person revokes their own calendar feed'),
    summarize: (_input, row) => `Revoke the calendar feed${row.label ? ` ${row.label}` : ''}`,
    run: async ({ tx, loaded }) => {
      await tx.delete(calendarFeeds).where(eq(calendarFeeds.id, loaded.id));
      return {
        value: null,
        touched: [{ type: FEED, id: loaded.id, change: 'deleted', before: feedView(loaded) }],
      };
    },
    present: () => null,
  };
}

const OWNER = {};
const asArgs = (a: Record<string, unknown> | null) => a as Id;

/** Each op once per process, so a parked one replays after its approval. */
export function registerCalendarOps() {
  registerOp('calendar.connection.connect', () => connectOp(), OWNER);
  registerOp('calendar.connection.disconnect', (a) => disconnectOp(asArgs(a)), OWNER);
  registerOp('calendar.feed.create', () => createFeedOp(), OWNER);
  registerOp('calendar.feed.revoke', (a) => revokeFeedOp(asArgs(a)), OWNER);
}
