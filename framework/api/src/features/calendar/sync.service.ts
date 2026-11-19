// Records to connected calendars, and changes made there back to the application as events.
// Each record is read as the person whose calendar it goes to, so access and hidden fields hold
// in their calendar exactly as in the app (decisions B17, 10 to 12). Every provider is reached
// through its `CalendarProviderDef` (decisions B21); a person with more than one connection has
// records written to one of them, their target.
import type { CalendarEventChange } from '@hykr/contracts';
import { recordEvents, settingsIn, systemPrincipal, tenantZone, toJson } from '@hykr/core';
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
import { CalendarLocks, recordLock } from './lock.js';
import { CalendarEvent } from './ops.js';
import { memberPrincipal } from './principal.js';
import {
  type CalendarProviderDef,
  enabledProviders,
  type ProviderChange,
  providerOf,
} from './providers/index.js';
import {
  checkSchedulables,
  contentOf,
  googleEventId,
  hashOf,
  namesPerson,
  peopleOf,
  type Schedulable,
  schedulable,
  schedulables,
} from './schedulable.js';
import { syncDays, watchAddress } from './settings.js';
import { forgetOldSignIns } from './sign-in.js';
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
  | { kind: 'retarget'; tenantId: string; userId: string }
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
    @Inject(CalendarLocks) private readonly locks: CalendarLocks,
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

  /** A person's write target changed (chosen, or theirs was disconnected): move their events. */
  queueRetarget(tenantId: string, userId: string, eventId: string) {
    return this.jobs.add<SyncJob>(
      SYNC_QUEUE,
      { kind: 'retarget', tenantId, userId },
      { name: 'retarget', jobId: `calendar-retarget--${eventId}` },
    );
  }

  run(job: SyncJob): Promise<string> {
    if (job.kind === 'record') return this.syncRecord(job.tenantId, job.entity, job.id);
    if (job.kind === 'connected') return this.afterConnect(job.connectionId);
    if (job.kind === 'retarget') return this.retarget(job.tenantId, job.userId);
    return this.maintain();
  }

  /* ── Targets ──────────────────────────────────────────────────────────── */

  /**
   * Which of a person's connections their records are written to: the one they chose
   * (`writeTo`), else the first connected, among the active ones of providers turned on here.
   */
  private targetOf(
    connections: readonly ConnectionRow[],
    userId: string,
  ): ConnectionRow | undefined {
    const mine = connections
      .filter((c) => c.userId === userId && c.status === 'active' && providerOf(c.provider))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return mine.find((c) => c.writeTo) ?? mine[0];
  }

  /** The person's active connections in a business. */
  private activeOf(tenantId: string, userId: string): Promise<ConnectionRow[]> {
    return this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenantId),
          eq(calendarConnections.userId, userId),
          eq(calendarConnections.status, 'active'),
        ),
      );
  }

  /** The person's target, read now. */
  private async targetFor(tenantId: string, userId: string): Promise<ConnectionRow | undefined> {
    return this.targetOf(await this.activeOf(tenantId, userId), userId);
  }

  /**
   * After the person's target changed: their records out of every other calendar, and into
   * the target.
   */
  async retarget(tenantId: string, userId: string): Promise<string> {
    const rows = await this.activeOf(tenantId, userId);
    const target = this.targetOf(rows, userId);
    let moved = 0;
    for (const conn of rows) {
      if (conn.id === target?.id) continue;
      const provider = providerOf(conn.provider);
      if (!provider) continue;
      const links = await this.db
        .select()
        .from(calendarEventLinks)
        .where(eq(calendarEventLinks.connectionId, conn.id));
      for (const l of links) {
        const s = schedulable(l.resourceType);
        if (!s) continue;
        const done = await this.locks.run(
          recordLock(l.tenantId, s.def.name, l.resourceId),
          async () => {
            const [link] = await this.db
              .select()
              .from(calendarEventLinks)
              .where(eq(calendarEventLinks.id, l.id));
            return link ? this.syncOne(provider, s, conn, l.resourceId, false, link) : false;
          },
        );
        if (done) moved++;
      }
    }
    const provider = target ? providerOf(target.provider) : null;
    const filled = target && provider ? await this.backfill(provider, target) : 0;
    return `${moved} taken out, ${filled} written`;
  }

  /* ── Records → calendars ──────────────────────────────────────────────── */

  /**
   * One record, in every calendar it belongs in or is in now: upserted where it belongs and the
   * person may read it, deleted elsewhere. One job at a time per record: each reads the record as
   * it is when its turn comes, so the last change's job leaves every calendar as the record is.
   */
  syncRecord(tenantId: string, entity: string, id: string): Promise<string> {
    const s = schedulable(entity);
    if (!s || !this.anyProvider()) return Promise.resolve('nothing to do');
    return this.locks.run(recordLock(tenantId, s.def.name, id), () =>
      this.syncLocked(s, tenantId, id),
    );
  }

  /** Is any provider offered here? */
  private anyProvider(): boolean {
    return enabledProviders().some((name) => providerOf(name) !== null);
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

  private async syncLocked(s: Schedulable, tenantId: string, id: string): Promise<string> {
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
    let looked = 0;
    for (const conn of connections) {
      const provider = providerOf(conn.provider);
      if (!provider) continue;
      looked++;
      const link = links.find((l) => l.connectionId === conn.id);
      // Each person's record goes to one calendar of theirs: their target.
      const belongs =
        !!row &&
        people.includes(conn.userId) &&
        this.targetOf(connections, conn.userId)?.id === conn.id;
      if (await this.syncOne(provider, s, conn, id, belongs, link)) done++;
    }
    return `${done} of ${looked} calendars changed`;
  }

  /** What a person's calendar should show of a record now, or null for nothing. */
  private async contentFor(s: Schedulable, conn: ConnectionRow, id: string) {
    const p = await memberPrincipal(this.ctx.get, { userId: conn.userId, tenantId: conn.tenantId });
    if (!p) return null;
    const found = await s.def.repo.find(this.db, p, id);
    if (!found) return null;
    return contentOf(s.trait, toJson(s.def.toRead(found, p)) as Values);
  }

  /** The zone a business's events are written in. */
  private async zoneOf(tenantId: string): Promise<string> {
    return tenantZone(await settingsIn(this.db, tenantId));
  }

  /** One record in one calendar. True when something was sent. */
  private async syncOne(
    provider: CalendarProviderDef,
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
      const token = await this.token(provider, conn);
      if (!token) return false;
      let externalId: string;
      try {
        ({ providerId: externalId } = await provider.upsertEvent(token, conn.calendarId, {
          key: googleEventId(conn.tenantId, s.def.name, id),
          ...(link?.externalId ? { providerId: link.externalId } : {}),
          title: content.title,
          ...(content.description ? { description: content.description } : {}),
          ...(content.location ? { location: content.location } : {}),
          startsAt: content.startsAt,
          endsAt: content.endsAt,
          timeZone: await this.zoneOf(conn.tenantId),
          mark: { tenant: conn.tenantId, entity: s.def.name, record: id },
        }));
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
        // Disconnected while the provider answered: take the event back out, as the disconnect does.
        await provider
          .deleteEvent(token, conn.calendarId, externalId)
          .catch((err) => log.warn(`removing event ${externalId}: ${messageOf(err)}`));
        return false;
      }
      await this.synced(conn);
      return true;
    }
    if (!link) return false;
    if (link.status === 'synced') {
      const token = await this.token(provider, conn);
      if (!token) return false;
      try {
        await provider.deleteEvent(token, conn.calendarId, link.externalId);
      } catch (e) {
        await this.failed(conn, e);
        throw e;
      }
    }
    await this.db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, link.id));
    await this.synced(conn);
    return true;
  }

  /** A working access token, or null when the grant is gone (the connection is marked). */
  private async token(provider: CalendarProviderDef, conn: ConnectionRow): Promise<string | null> {
    try {
      return await accessTokenFor(this.db, provider, conn);
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

  /**
   * Open its push channel, fill it with the person's coming records (when it is the calendar
   * their records go to), and read where it stands.
   */
  async afterConnect(connectionId: string): Promise<string> {
    const conn = await this.connection(connectionId);
    const provider = conn ? providerOf(conn.provider) : null;
    if (!provider || conn?.status !== 'active') return 'not active';
    await this.openChannel(provider, conn);
    const target = await this.targetFor(conn.tenantId, conn.userId);
    const filled = target?.id === conn.id ? await this.backfill(provider, conn) : 0;
    await this.pullChanges(conn.id);
    return `${filled} records`;
  }

  /** The person's records from yesterday to `CALENDAR_SYNC_DAYS` ahead, into their calendar. */
  private async backfill(provider: CalendarProviderDef, conn: ConnectionRow): Promise<number> {
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
        const sent = await this.locks.run(recordLock(conn.tenantId, s.def.name, id), async () => {
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
          return this.syncOne(provider, s, conn, id, belongs, link);
        });
        if (sent) n++;
      }
    }
    return n;
  }

  /* ── Push channels ────────────────────────────────────────────────────── */

  /**
   * A new channel (the old one closed after), when the server has a public https address: a
   * Google push channel or a Graph subscription (whose address Graph checks first).
   */
  private async openChannel(provider: CalendarProviderDef, conn: ConnectionRow): Promise<boolean> {
    if (!conn.inboundConnectionId || !provider.watch) return false;
    const address = watchAddress(
      `/webhooks/${provider.inboundConnector}/${conn.inboundConnectionId}`,
      provider.mode,
    );
    if (!address) return false;
    const inbound = await openConnection<unknown>(this.db, conn.tenantId, conn.inboundConnectionId);
    if (!inbound) return false;
    const secret = provider.watchSecret(inbound.credentials);
    if (!secret) return false;
    const token = await this.token(provider, conn);
    if (!token) return false;
    const channel = await provider.watch(token, {
      calendarId: conn.calendarId,
      address,
      secret,
      ttlSeconds: CHANNEL_TTL_S,
    });
    await this.db
      .update(calendarConnections)
      .set({
        channelId: channel.channelId,
        channelResourceId: channel.resourceId,
        channelExpiresAt: channel.expiresAt,
      })
      .where(eq(calendarConnections.id, conn.id));
    if (conn.channelId && provider.stopWatch)
      await provider
        .stopWatch(token, { channelId: conn.channelId, resourceId: conn.channelResourceId })
        .catch((e) => log.warn(`closing channel ${conn.channelId}: ${messageOf(e)}`));
    return true;
  }

  /**
   * Every few minutes, for this process's connections: renew channels that end within a day,
   * and look for changes where no channel tells us. Sign-ins too old to finish are forgotten.
   */
  async maintain(): Promise<string> {
    await forgetOldSignIns(this.db);
    if (!this.anyProvider()) return 'no provider';
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
      const provider = providerOf(conn.provider);
      if (!provider) continue;
      try {
        const live = await this.openChannel(provider, conn);
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
    const conn = await this.connection(connectionId);
    const provider = conn ? providerOf(conn.provider) : null;
    if (!provider || !conn || conn.status !== 'active') return 'not active';
    if (from?.tenantId && from.tenantId !== conn.tenantId) return 'not this business';
    // A notification from a channel we replaced says nothing new.
    if (from?.channelId && conn.channelId && from.channelId !== conn.channelId)
      return 'old channel';
    const token = await this.token(provider, conn);
    if (!token) return 'needs reauth';
    let changes: Awaited<ReturnType<CalendarProviderDef['changes']>>;
    try {
      changes = await provider.changes(token, {
        calendarId: conn.calendarId,
        cursor: conn.syncToken,
        tenantId: conn.tenantId,
      });
    } catch (e) {
      await this.failed(conn, e);
      throw e;
    }
    let noted = 0;
    // A first look, or a cursor the provider dropped, lists everything: our events in it changed
    // nothing we know of.
    if (conn.syncToken && !changes.reset)
      for (const item of changes.items) if (await this.noteChange(provider, conn, item)) noted++;
    await this.db
      .update(calendarConnections)
      .set({ syncToken: changes.cursor, lastSyncedAt: new Date(), lastError: null })
      .where(eq(calendarConnections.id, conn.id));
    return `${noted} changes noted`;
  }

  /**
   * One changed event: ours, moved or deleted by the person? Stored as an event if so. In turn
   * with the record's sync jobs, so our own change that the provider reports is never taken for
   * theirs.
   */
  private async noteChange(
    provider: CalendarProviderDef,
    conn: ConnectionRow,
    item: ProviderChange,
  ): Promise<boolean> {
    const linkOf = async () => {
      const [found] = await this.db
        .select()
        .from(calendarEventLinks)
        .where(
          and(
            eq(calendarEventLinks.connectionId, conn.id),
            eq(calendarEventLinks.externalId, item.providerId),
          ),
        );
      return found;
    };
    const first = await linkOf();
    if (first?.status !== 'synced') return false;
    return this.locks.run(
      recordLock(first.tenantId, first.resourceType, first.resourceId),
      async () => {
        const link = await linkOf();
        return link?.status === 'synced' ? this.noteLinked(provider, conn, item, link) : false;
      },
    );
  }

  private async noteLinked(
    provider: CalendarProviderDef,
    conn: ConnectionRow,
    item: ProviderChange,
    link: LinkRow,
  ): Promise<boolean> {
    const change = (extra: Partial<CalendarEventChange>): CalendarEventChange => ({
      id: link.id,
      tenantId: link.tenantId,
      entity: link.resourceType,
      recordId: link.resourceId,
      userId: conn.userId,
      provider: provider.name,
      sentStartsAt: link.sentStartsAt?.toISOString() ?? null,
      sentEndsAt: link.sentEndsAt?.toISOString() ?? null,
      ...extra,
    });
    const principal = systemPrincipal({ tenantId: conn.tenantId, job: provider.jobName });
    if (item.removed) {
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
    const { startsAt, endsAt } = item;
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
   * revoked where the provider can (Microsoft cannot: its tokens are only deleted). Best effort:
   * what fails is logged.
   */
  async cleanUp(left: Leftovers): Promise<void> {
    const provider = providerOf(left.row.provider);
    if (!provider || !left.tokens) return;
    const quietly = (what: string) => (e: unknown) => log.warn(`${what}: ${messageOf(e)}`);
    let accessToken = left.tokens.accessToken;
    // The row is gone, so a token that has run out is refreshed here, not stored.
    if (left.tokens.expiresAt <= Date.now() + 60_000)
      accessToken = await provider.oauth
        .refresh(left.tokens.refreshToken)
        .then((t) => t.accessToken)
        .catch((e) => {
          quietly('refreshing to clean up')(e);
          return accessToken;
        });
    for (const link of left.links)
      if (link.status === 'synced')
        // After any sync of the record still running: it may have just sent the event again.
        await this.locks
          .run(recordLock(link.tenantId, link.resourceType, link.resourceId), () =>
            provider.deleteEvent(accessToken, left.row.calendarId, link.externalId),
          )
          .catch(quietly(`removing event ${link.externalId}`));
    if (left.row.channelId && provider.stopWatch)
      await provider
        .stopWatch(accessToken, {
          channelId: left.row.channelId,
          resourceId: left.row.channelResourceId,
        })
        .catch(quietly('closing the channel'));
    if (provider.oauth.revoke)
      await provider.oauth.revoke(left.tokens.refreshToken).catch(quietly('revoking the grant'));
  }
}

/** Postgres refused a row whose parent is gone (23503). */
const isForeignKeyViolation = (e: unknown) => {
  const cause = (e as { cause?: { code?: string }; code?: string }) ?? {};
  return cause.code === '23503' || cause.cause?.code === '23503';
};
