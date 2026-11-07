// Records to connected calendars, and changes made there back to the application as events.
// Each record is read as the person whose calendar it goes to, so access and hidden fields hold
// in Google exactly as in the app (decisions B17, 10 to 12).
import { randomUUID } from 'node:crypto';
import {
  type GoogleCalendarClient,
  type GoogleEvent,
  googleCalendarClient,
  revokeToken,
} from '@hykr/connectors/google-calendar';
import type { CalendarEventChange } from '@hykr/contracts';
import { recordEvents, systemPrincipal, toJson } from '@hykr/core';
import { calendarConnections, calendarEventLinks, type Database } from '@hykr/db';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { config } from '../../config.js';
import type { Jobs, ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { JOBS } from '../../queues/define.js';
import { serverContext } from '../../queues/jobs.service.js';
import { openConnection } from '../integrations/credentials.js';
import { recordLock, withLock } from './lock.js';
import { CalendarEvent } from './ops.js';
import { memberPrincipal } from './principal.js';
import {
  checkSchedulables,
  contentOf,
  type EventContent,
  googleEventId,
  hashOf,
  namesPerson,
  peopleOf,
  type Schedulable,
  schedulable,
  schedulables,
} from './schedulable.js';
import { type GoogleSettings, googleSettings, syncDays, watchAddress } from './settings.js';
import {
  accessTokenFor,
  type ConnectionRow,
  GrantRevoked,
  openTokens,
  type StoredTokens,
} from './tokens.js';

const log = new Logger('Calendar');

export const SYNC_QUEUE = 'calendar.sync';
export type SyncJob =
  | { kind: 'record'; tenantId: string; entity: string; id: string }
  | { kind: 'connected'; connectionId: string }
  | { kind: 'maintain' };

type LinkRow = typeof calendarEventLinks.$inferSelect;
type Values = Record<string, unknown>;

const DAY = 86_400_000;
/** A channel lives a week; it is renewed when less than a day is left. */
const CHANNEL_TTL_S = 7 * 24 * 3600;
const RENEW_BEFORE_MS = DAY;
/** Most records a new connection is filled with, per entity. */
const BACKFILL_MAX = 500;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** What a connection's tokens and links were, before it was deleted: to clean up after. */
export interface Leftovers {
  row: ConnectionRow;
  tokens: StoredTokens | null;
  links: LinkRow[];
}

@Injectable()
export class CalendarSyncService implements OnApplicationBootstrap {
  private readonly ctx: ServerContext;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(JOBS) private readonly jobs: Jobs,
    @Inject(ModuleRef) ref: ModuleRef,
  ) {
    this.ctx = serverContext(ref);
  }

  /** Every schedulable entity names fields and columns it has: a mistake stops the start. */
  onApplicationBootstrap() {
    checkSchedulables();
  }

  /* ── Queueing ─────────────────────────────────────────────────────────── */

  /** A stored event about a schedulable record: sync it (one job per event). */
  queueRecord(tenantId: string, entity: string, id: string, eventId: string) {
    return this.jobs.add<SyncJob>(
      SYNC_QUEUE,
      { kind: 'record', tenantId, entity, id },
      { name: 'record', jobId: `calendar-sync--${eventId}` },
    );
  }

  queueConnected(connectionId: string, eventId: string) {
    return this.jobs.add<SyncJob>(
      SYNC_QUEUE,
      { kind: 'connected', connectionId },
      { name: 'connected', jobId: `calendar-connected--${eventId}` },
    );
  }

  run(job: SyncJob): Promise<string> {
    if (job.kind === 'record') return this.syncRecord(job.tenantId, job.entity, job.id);
    if (job.kind === 'connected') return this.afterConnect(job.connectionId);
    return this.maintain();
  }

  /* ── Records → calendars ──────────────────────────────────────────────── */

  /**
   * One record, in every calendar it belongs in or is in now: upserted where it belongs and the
   * person may read it, deleted elsewhere. One job at a time per record: each reads the record as
   * it is when its turn comes, so the last change's job leaves every calendar as the record is.
   */
  syncRecord(tenantId: string, entity: string, id: string): Promise<string> {
    const s = schedulable(entity);
    const google = googleSettings();
    if (!s || !google) return Promise.resolve('nothing to do');
    return withLock(this.db, recordLock(tenantId, s.def.name, id), () =>
      this.syncLocked(google, s, tenantId, id),
    );
  }

  /** The record's row in its business, or undefined when it is gone. */
  private async rowOf(s: Schedulable, tenantId: string, id: string) {
    const columns = getTableColumns(s.def.table) as Record<string, PgColumn>;
    const [row] = (await this.db
      .select()
      .from(s.def.table)
      .where(and(eq(columns.id, id), eq(columns.tenantId, tenantId)))) as Values[];
    return row;
  }

  private async syncLocked(
    google: GoogleSettings,
    s: Schedulable,
    tenantId: string,
    id: string,
  ): Promise<string> {
    const entity = s.def.name;
    const row = await this.rowOf(s, tenantId, id);
    const people = row ? peopleOf(s, row) : [];
    const links = await this.db
      .select()
      .from(calendarEventLinks)
      .where(
        and(
          eq(calendarEventLinks.tenantId, tenantId),
          eq(calendarEventLinks.resourceType, entity),
          eq(calendarEventLinks.resourceId, id),
        ),
      );
    const linked = links.map((l) => l.connectionId);
    if (!people.length && !linked.length) return 'in no calendar';
    const connections = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenantId),
          eq(calendarConnections.status, 'active'),
          or(
            people.length ? inArray(calendarConnections.userId, people) : sql`false`,
            linked.length ? inArray(calendarConnections.id, linked) : sql`false`,
          ),
        ),
      );
    let done = 0;
    for (const conn of connections) {
      const link = links.find((l) => l.connectionId === conn.id);
      const belongs = !!row && people.includes(conn.userId);
      if (await this.syncOne(google, s, conn, id, belongs, link)) done++;
    }
    return `${done} of ${connections.length} calendars changed`;
  }

  /** What a person's calendar should show of a record now, or null for nothing. */
  private async contentFor(s: Schedulable, conn: ConnectionRow, id: string) {
    const p = await memberPrincipal(this.ctx.get, { userId: conn.userId, tenantId: conn.tenantId });
    if (!p) return null;
    const found = await s.def.repo.find(this.db, p, id);
    if (!found) return null;
    return contentOf(s.trait, toJson(s.def.toRead(found, p)) as Values);
  }

  /** One record in one calendar. True when something was sent. */
  private async syncOne(
    google: GoogleSettings,
    s: Schedulable,
    conn: ConnectionRow,
    id: string,
    belongs: boolean,
    link: LinkRow | undefined,
  ): Promise<boolean> {
    const content = belongs ? await this.contentFor(s, conn, id) : null;
    if (content) {
      const hash = hashOf(content);
      // Unchanged: nothing to send. A person who deleted it in their calendar keeps it deleted
      // until the record changes.
      if (link?.hash === hash) return false;
      const api = await this.client(google, conn);
      if (!api) return false;
      const externalId = googleEventId(conn.tenantId, s.def.name, id);
      try {
        await api.upsertEvent(
          conn.calendarId,
          googleEventOf(content, conn.tenantId, s, id, externalId),
        );
      } catch (e) {
        await this.failed(conn, e);
        throw e;
      }
      const values = {
        externalId,
        status: 'synced',
        hash,
        sentStartsAt: new Date(content.startsAt),
        sentEndsAt: new Date(content.endsAt),
        externalStartsAt: null,
        externalEndsAt: null,
        syncedAt: new Date(),
        updatedAt: new Date(),
      };
      try {
        await this.db
          .insert(calendarEventLinks)
          .values({
            tenantId: conn.tenantId,
            connectionId: conn.id,
            resourceType: s.def.name,
            resourceId: id,
            ...values,
          })
          .onConflictDoUpdate({
            target: [
              calendarEventLinks.connectionId,
              calendarEventLinks.resourceType,
              calendarEventLinks.resourceId,
            ],
            set: values,
          });
      } catch (e) {
        if (!isForeignKeyViolation(e)) throw e;
        // Disconnected while Google answered: take the event back out, as the disconnect does.
        await api
          .deleteEvent(conn.calendarId, externalId)
          .catch((err) => log.warn(`removing event ${externalId}: ${messageOf(err)}`));
        return false;
      }
      await this.synced(conn);
      return true;
    }
    if (!link) return false;
    if (link.status === 'synced') {
      const api = await this.client(google, conn);
      if (!api) return false;
      try {
        await api.deleteEvent(conn.calendarId, link.externalId);
      } catch (e) {
        await this.failed(conn, e);
        throw e;
      }
    }
    await this.db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, link.id));
    await this.synced(conn);
    return true;
  }

  /** A client with a working token, or null when the grant is gone (the connection is marked). */
  private async client(
    google: GoogleSettings,
    conn: ConnectionRow,
  ): Promise<GoogleCalendarClient | null> {
    try {
      const accessToken = await accessTokenFor(this.db, google, conn);
      return googleCalendarClient(google.transport, { accessToken, endpoints: google.endpoints });
    } catch (e) {
      if (e instanceof GrantRevoked) return null;
      await this.failed(conn, e);
      throw e;
    }
  }

  private async synced(conn: ConnectionRow) {
    await this.db
      .update(calendarConnections)
      .set({ lastSyncedAt: new Date(), lastError: null })
      .where(eq(calendarConnections.id, conn.id));
  }

  private async failed(conn: ConnectionRow, e: unknown) {
    log.warn(`calendar ${conn.id}: ${messageOf(e)}`);
    await this.db
      .update(calendarConnections)
      .set({ lastError: messageOf(e) })
      .where(eq(calendarConnections.id, conn.id));
  }

  private async connection(id: string): Promise<ConnectionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(calendarConnections)
      .where(eq(calendarConnections.id, id));
    return row;
  }

  /* ── A new connection ─────────────────────────────────────────────────── */

  /** Open its push channel, fill it with the person's coming records, and read where it stands. */
  async afterConnect(connectionId: string): Promise<string> {
    const google = googleSettings();
    const conn = await this.connection(connectionId);
    if (!google || conn?.status !== 'active') return 'not active';
    await this.openChannel(google, conn);
    const filled = await this.backfill(google, conn);
    await this.pullChanges(conn.id);
    return `${filled} records`;
  }

  /** The person's records from yesterday to `CALENDAR_SYNC_DAYS` ahead, into their calendar. */
  private async backfill(google: GoogleSettings, conn: ConnectionRow): Promise<number> {
    const from = new Date(Date.now() - DAY);
    const to = new Date(Date.now() + syncDays() * DAY);
    let n = 0;
    for (const s of schedulables()) {
      const columns = getTableColumns(s.def.table) as Record<string, PgColumn>;
      const starts = columns[s.trait.startsAt];
      const ids = (await this.db
        .select({ id: columns.id })
        .from(s.def.table)
        .where(
          and(
            eq(columns.tenantId, conn.tenantId),
            namesPerson(s, conn.userId),
            ...(starts ? [gte(starts, from), lte(starts, to)] : []),
          ),
        )
        .orderBy(starts ? starts : desc(columns.id))
        .limit(BACKFILL_MAX)) as { id: string }[];
      for (const { id } of ids) {
        // In turn with the record's own jobs, and as the record is by then.
        const sent = await withLock(
          this.db,
          recordLock(conn.tenantId, s.def.name, id),
          async () => {
            const row = await this.rowOf(s, conn.tenantId, id);
            const [link] = await this.db
              .select()
              .from(calendarEventLinks)
              .where(
                and(
                  eq(calendarEventLinks.connectionId, conn.id),
                  eq(calendarEventLinks.resourceType, s.def.name),
                  eq(calendarEventLinks.resourceId, id),
                ),
              );
            const belongs = !!row && peopleOf(s, row).includes(conn.userId);
            return this.syncOne(google, s, conn, id, belongs, link);
          },
        );
        if (sent) n++;
      }
    }
    return n;
  }

  /* ── Push channels ────────────────────────────────────────────────────── */

  /** A new channel (the old one closed after), when the server has a public https address. */
  private async openChannel(google: GoogleSettings, conn: ConnectionRow): Promise<boolean> {
    if (!conn.inboundConnectionId) return false;
    const address = watchAddress(
      `/webhooks/google-calendar/${conn.inboundConnectionId}`,
      google.mode,
    );
    if (!address) return false;
    const inbound = await openConnection<{ channelToken: string }>(
      this.db,
      conn.tenantId,
      conn.inboundConnectionId,
    );
    if (!inbound) return false;
    const api = await this.client(google, conn);
    if (!api) return false;
    const channel = await api.watch(conn.calendarId, {
      id: randomUUID(),
      token: inbound.credentials.channelToken,
      address,
      ttlSeconds: CHANNEL_TTL_S,
    });
    await this.db
      .update(calendarConnections)
      .set({
        channelId: channel.id,
        channelResourceId: channel.resourceId,
        channelExpiresAt: new Date(channel.expiration),
      })
      .where(eq(calendarConnections.id, conn.id));
    if (conn.channelId && conn.channelResourceId)
      await api
        .stopChannel({ id: conn.channelId, resourceId: conn.channelResourceId })
        .catch((e) => log.warn(`closing channel ${conn.channelId}: ${messageOf(e)}`));
    return true;
  }

  /**
   * Every few minutes, for this process's connections: renew channels that end within a day,
   * and look for changes where no channel tells us.
   */
  async maintain(): Promise<string> {
    const google = googleSettings();
    if (!google) return 'no provider';
    const soon = new Date(Date.now() + RENEW_BEFORE_MS);
    const due = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.queues, config.queuePrefix),
          eq(calendarConnections.status, 'active'),
          or(
            isNull(calendarConnections.channelExpiresAt),
            lt(calendarConnections.channelExpiresAt, soon),
          ),
        ),
      )
      .limit(200);
    let pulled = 0;
    for (const conn of due) {
      try {
        const live = await this.openChannel(google, conn);
        if (!live) {
          await this.pullChanges(conn.id);
          pulled++;
        }
      } catch (e) {
        log.warn(`maintaining calendar ${conn.id}: ${messageOf(e)}`);
      }
    }
    return `${due.length} looked after, ${pulled} pulled`;
  }

  /* ── Calendars → events ───────────────────────────────────────────────── */

  /**
   * What changed in the person's calendar since last time. Our events that they moved or deleted
   * there become `calendar.event_moved` / `calendar.event_removed`, stored as the business's
   * system principal; the application decides what they mean.
   */
  async pullChanges(connectionId: string, from?: { tenantId?: string; channelId?: string }) {
    const google = googleSettings();
    const conn = await this.connection(connectionId);
    if (!google || !conn || conn.status !== 'active') return 'not active';
    if (from?.tenantId && from.tenantId !== conn.tenantId) return 'not this business';
    // A notification from a channel we replaced says nothing new.
    if (from?.channelId && conn.channelId && from.channelId !== conn.channelId)
      return 'old channel';
    const api = await this.client(google, conn);
    if (!api) return 'needs reauth';
    let changes: Awaited<ReturnType<GoogleCalendarClient['changes']>>;
    try {
      changes = await api.changes(conn.calendarId, conn.syncToken);
    } catch (e) {
      await this.failed(conn, e);
      throw e;
    }
    let noted = 0;
    // A first look, or a token Google dropped, lists everything: our events in it changed
    // nothing we know of.
    if (conn.syncToken && !changes.reset)
      for (const item of changes.items) if (await this.noteChange(conn, item)) noted++;
    await this.db
      .update(calendarConnections)
      .set({ syncToken: changes.nextSyncToken, lastSyncedAt: new Date(), lastError: null })
      .where(eq(calendarConnections.id, conn.id));
    return `${noted} changes noted`;
  }

  /**
   * One changed event: ours, moved or deleted by the person? Stored as an event if so. In turn
   * with the record's sync jobs, so our own change that Google reports is never taken for theirs.
   */
  private async noteChange(conn: ConnectionRow, item: GoogleEvent): Promise<boolean> {
    const mark = item.extendedProperties?.private;
    if (mark?.basecamp !== '1' || mark.tenant !== conn.tenantId) return false;
    const linkOf = async () => {
      const [found] = await this.db
        .select()
        .from(calendarEventLinks)
        .where(
          and(
            eq(calendarEventLinks.connectionId, conn.id),
            eq(calendarEventLinks.externalId, item.id),
          ),
        );
      return found;
    };
    const first = await linkOf();
    if (first?.status !== 'synced') return false;
    return withLock(
      this.db,
      recordLock(first.tenantId, first.resourceType, first.resourceId),
      async () => {
        const link = await linkOf();
        return link?.status === 'synced' ? this.noteLinked(conn, item, link) : false;
      },
    );
  }

  private async noteLinked(
    conn: ConnectionRow,
    item: GoogleEvent,
    link: LinkRow,
  ): Promise<boolean> {
    const change = (extra: Partial<CalendarEventChange>): CalendarEventChange => ({
      id: link.id,
      tenantId: link.tenantId,
      entity: link.resourceType,
      recordId: link.resourceId,
      userId: conn.userId,
      provider: 'google',
      sentStartsAt: link.sentStartsAt?.toISOString() ?? null,
      sentEndsAt: link.sentEndsAt?.toISOString() ?? null,
      ...extra,
    });
    const principal = systemPrincipal({ tenantId: conn.tenantId, job: 'calendar.google' });
    if (item.status === 'cancelled') {
      await this.db.transaction(async (tx) => {
        await tx
          .update(calendarEventLinks)
          .set({ status: 'removed', updatedAt: new Date() })
          .where(eq(calendarEventLinks.id, link.id));
        await recordEvents(tx, {
          principal,
          events: [new CalendarEvent('calendar.event_removed', change({}), 'calendarEvent')],
        });
      });
      return true;
    }
    const startsAt = timeOf(item.start);
    const endsAt = timeOf(item.end);
    if (!startsAt || !endsAt) return false;
    const same = (a: Date | null, b: string) => !!a && a.getTime() === Date.parse(b);
    // Where we put it, or where it already was: nothing new.
    if (same(link.sentStartsAt, startsAt) && same(link.sentEndsAt, endsAt)) {
      if (link.externalStartsAt)
        await this.db
          .update(calendarEventLinks)
          .set({ externalStartsAt: null, externalEndsAt: null, updatedAt: new Date() })
          .where(eq(calendarEventLinks.id, link.id));
      return false;
    }
    if (same(link.externalStartsAt, startsAt) && same(link.externalEndsAt, endsAt)) return false;
    await this.db.transaction(async (tx) => {
      await tx
        .update(calendarEventLinks)
        .set({
          externalStartsAt: new Date(startsAt),
          externalEndsAt: new Date(endsAt),
          updatedAt: new Date(),
        })
        .where(eq(calendarEventLinks.id, link.id));
      await recordEvents(tx, {
        principal,
        events: [
          new CalendarEvent('calendar.event_moved', change({ startsAt, endsAt }), 'calendarEvent'),
        ],
      });
    });
    return true;
  }

  /* ── Disconnecting ────────────────────────────────────────────────────── */

  /** What a connection holds, read before it is deleted. */
  async leftovers(connectionId: string): Promise<Leftovers | null> {
    const row = await this.connection(connectionId);
    if (!row) return null;
    const links = await this.db
      .select()
      .from(calendarEventLinks)
      .where(eq(calendarEventLinks.connectionId, row.id));
    return { row, tokens: openTokens(row), links };
  }

  /**
   * After a disconnect: our events out of the person's calendar, the channel closed, the grant
   * revoked. Best effort: what fails is logged.
   */
  async cleanUp(left: Leftovers): Promise<void> {
    const google = googleSettings();
    if (!google || !left.tokens) return;
    const api = googleCalendarClient(google.transport, {
      accessToken: left.tokens.accessToken,
      endpoints: google.endpoints,
    });
    const quietly = (what: string) => (e: unknown) => log.warn(`${what}: ${messageOf(e)}`);
    for (const link of left.links)
      if (link.status === 'synced')
        // After any sync of the record still running: it may have just sent the event again.
        await withLock(this.db, recordLock(link.tenantId, link.resourceType, link.resourceId), () =>
          api.deleteEvent(left.row.calendarId, link.externalId),
        ).catch(quietly(`removing event ${link.externalId}`));
    if (left.row.channelId && left.row.channelResourceId)
      await api
        .stopChannel({ id: left.row.channelId, resourceId: left.row.channelResourceId })
        .catch(quietly('closing the channel'));
    await revokeToken(google.transport, {
      token: left.tokens.refreshToken,
      endpoints: google.endpoints,
    }).catch(quietly('revoking the grant'));
  }
}

/** Postgres refused a row whose parent is gone (23503). */
const isForeignKeyViolation = (e: unknown) => {
  const cause = (e as { cause?: { code?: string }; code?: string }) ?? {};
  return cause.code === '23503' || cause.cause?.code === '23503';
};

/** A Google time as an ISO instant, or null for an all-day date. */
function timeOf(t: GoogleEvent['start']): string | null {
  if (!t?.dateTime) return null;
  const ms = Date.parse(t.dateTime);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The event Google keeps for a record. */
function googleEventOf(
  content: EventContent,
  tenantId: string,
  s: Schedulable,
  id: string,
  externalId: string,
): GoogleEvent {
  return {
    id: externalId,
    status: 'confirmed',
    summary: content.title,
    ...(content.description ? { description: content.description } : {}),
    ...(content.location ? { location: content.location } : {}),
    start: { dateTime: content.startsAt },
    end: { dateTime: content.endsAt },
    extendedProperties: {
      private: { basecamp: '1', tenant: tenantId, entity: s.def.name, record: id },
    },
  };
}
