// A person's calendars: connecting one (OAuth with PKCE, the state sealed), the list, the
// disconnect; busy and free time; private feeds. Writes go through runWrite (ops.ts).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type IcsEvent, icsCalendar } from '@hykr/connectors';
import {
  authorizationUrl,
  exchangeCode,
  fakeGoogle,
  googleCalendarClient,
  googleCalendarConnector,
  pkcePair,
} from '@hykr/connectors/google-calendar';
import {
  type BusyTimes,
  CalendarCapabilities,
  type CalendarConnectionInfo,
  type CalendarFeedInfo,
  type CalendarProviderInfo,
  ConnectCalendarInput,
  CreateFeedInput,
  FreeTimeQuery,
  type FreeTimes,
  freeSlots,
  type Principal,
  parseTenantSettings,
} from '@hykr/contracts';
import { runWrite, toJson, type WriteOp } from '@hykr/core';
import { calendarConnections, calendarFeeds, type Database, tenants, user } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq, getTableColumns, gte, isNull, lt, lte, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { serverContext } from '../../queues/jobs.service.js';
import { connectionAad, requireSecretBox } from '../integrations/settings.js';
import {
  connectionView,
  connectOp,
  createFeedOp,
  disconnectOp,
  feedView,
  registerCalendarOps,
  revokeFeedOp,
} from './ops.js';
import { memberPrincipal } from './principal.js';
import { contentOf, namesPerson, schedulables, uidOf } from './schedulable.js';
import {
  checkCalendarSettings,
  feedUrl,
  googleSettings,
  requireGoogle,
  returnUrl,
} from './settings.js';
import { CalendarSyncService } from './sync.service.js';
import { accessTokenFor, GrantRevoked, STATE_AAD, sealTokens } from './tokens.js';

const log = new Logger('Calendar');

/** What a request sends, checked, or 400 with the problems. */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success)
    throw new BadRequestException({
      error: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return parsed.data;
}

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

/** The sealed OAuth state: who, where, the PKCE verifier, until when. */
interface OAuthState {
  t: string;
  u: string;
  v: string;
  e: number;
}

const STATE_TTL_MS = 10 * 60_000;
const DAY = 86_400_000;
/** A feed lists this far back and ahead, at most this many events. */
const FEED_BACK_MS = 90 * DAY;
const FEED_AHEAD_MS = 365 * DAY;
const FEED_MAX = 1000;
/** Availability is asked for at most this window. */
const MAX_WINDOW_MS = 31 * DAY;

const userOf = (p: Principal) => {
  const s = subjectOf(p);
  if (s?.kind !== 'user')
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'members_only',
      reason: 'Only members of the business have calendars here',
    });
  return s.userId;
};

const feedTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Where the browser lands after Google, with what happened. */
const landing = (outcome: Record<string, string>) => {
  const url = new URL(returnUrl());
  for (const [k, v] of Object.entries(outcome)) url.searchParams.set(k, v);
  return url.toString();
};

@Injectable()
export class CalendarService implements OnModuleInit {
  private readonly ctx: ServerContext;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModuleRef) ref: ModuleRef,
    private readonly sync: CalendarSyncService,
  ) {
    this.ctx = serverContext(ref);
  }

  onModuleInit() {
    checkCalendarSettings();
    registerCalendarOps();
  }

  // biome-ignore lint/suspicious/noExplicitAny: any of the feature's ops
  private async write(p: Principal, requestId: string, op: WriteOp<any, any, any>, input: unknown) {
    const out = await runWrite(this.db, { principal: p, requestId }, op, input);
    for (const event of out.events) this.events.publish(event);
    return out.result;
  }

  /* ── Connections ──────────────────────────────────────────────────────── */

  providers(): CalendarProviderInfo[] {
    return [{ name: 'google', available: googleSettings() !== null }];
  }

  /** The consent screen's URL for this person, in this business. */
  async start(p: Principal, body: unknown): Promise<{ url: string }> {
    parse(ConnectCalendarInput, body);
    const userId = userOf(p);
    const google = requireGoogle();
    const box = requireSecretBox();
    const pkce = pkcePair();
    const state: OAuthState = {
      t: p.tenantId as string,
      u: userId,
      v: pkce.verifier,
      e: Date.now() + STATE_TTL_MS,
    };
    const [me] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    const url = authorizationUrl({
      clientId: google.clientId,
      redirectUri: google.redirectUri,
      state: box.seal(JSON.stringify(state), STATE_AAD),
      codeChallenge: pkce.challenge,
      endpoints: google.endpoints,
      ...(me?.email ? { loginHint: me.email } : {}),
    });
    // Offline: the fake's consent screen agrees at once, as the person's own address.
    if (google.mode === 'fake') return { url: fakeGoogle().consent(url, me?.email ?? userId) };
    return { url };
  }

  /**
   * Google sends the browser back here. The sealed state names the person and business; the
   * code becomes tokens, sealed; the connection is written as the person. Returns where the
   * browser goes next.
   */
  async callback(query: Record<string, unknown>, requestId: string): Promise<string> {
    if (typeof query.error === 'string') return landing({ error: query.error.slice(0, 100) });
    const state = this.openState(query.state);
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code) throw new BadRequestException({ error: 'invalid', message: 'No code' });
    const google = requireGoogle();
    const p = await memberPrincipal(this.ctx.get, {
      userId: state.u,
      tenantId: state.t,
      channel: 'app',
    });
    if (!p)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'not_a_member',
        reason: 'You are no longer a member of this business',
      });
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(google.transport, {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        endpoints: google.endpoints,
        redirectUri: google.redirectUri,
        code,
        codeVerifier: state.v,
      });
    } catch (e) {
      log.warn(`Google refused the code: ${e instanceof Error ? e.message : e}`);
      return landing({ error: 'google_refused' });
    }
    if (!tokens.refreshToken) return landing({ error: 'no_offline_access' });
    const account = tokens.email ?? 'Google account';
    const [existing] = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, state.t),
          eq(calendarConnections.userId, state.u),
          eq(calendarConnections.provider, 'google'),
        ),
      );
    // Another Google account than before: take our events out of the old one first.
    const old =
      existing && existing.account !== account ? await this.sync.leftovers(existing.id) : null;
    const id = existing?.id ?? randomUUID();
    const inboundId = randomUUID();
    const box = requireSecretBox();
    const result = await this.write(p, requestId, connectOp(), {
      id,
      provider: 'google',
      account,
      scopes: (tokens.scope ?? '').split(' ').filter(Boolean).slice(0, 20),
      sealed: sealTokens(state.t, id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      }),
      inbound: {
        id: inboundId,
        sealed: box.seal(
          JSON.stringify(googleCalendarConnector.generate?.()),
          connectionAad(state.t, inboundId),
        ),
      },
    });
    if (result.status !== 'done') return landing({ pending: 'google' });
    if (old) await this.sync.cleanUp(old);
    return landing({ connected: 'google' });
  }

  private openState(raw: unknown): OAuthState {
    const bad = () => new BadRequestException({ error: 'invalid', message: 'Bad or old state' });
    if (typeof raw !== 'string' || raw.length > 4000) throw bad();
    let state: OAuthState;
    try {
      state = JSON.parse(requireSecretBox().open(raw, STATE_AAD)) as OAuthState;
    } catch {
      throw bad();
    }
    if (!state?.t || !state.u || !state.v || !(state.e > Date.now())) throw bad();
    return state;
  }

  async list(p: Principal): Promise<CalendarConnectionInfo[]> {
    const rows = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, p.tenantId ?? ''),
          eq(calendarConnections.userId, userOf(p)),
        ),
      )
      .orderBy(asc(calendarConnections.createdAt));
    return rows.map(connectionView);
  }

  /** Disconnect: the write first (another person's is a 404), then Google cleaned up. */
  async disconnect(p: Principal, requestId: string, id: string) {
    userOf(p);
    const left = await this.sync.leftovers(id);
    const result = await this.write(p, requestId, disconnectOp({ id }), {});
    if (result.status === 'done' && left) await this.sync.cleanUp(left);
    return result;
  }

  /* ── Busy and free ────────────────────────────────────────────────────── */

  /** Whose time: yours, or (with the capability) another member's of this business. */
  private async whose(p: Principal, userId: string | undefined): Promise<string> {
    const me = userOf(p);
    if (!userId || userId === me) return me;
    if (!can(p, CalendarCapabilities.availability))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'availability_not_allowed',
        reason: "Only people who plan others' time see their free time",
      });
    const member = await memberPrincipal(this.ctx.get, {
      userId,
      tenantId: p.tenantId as string,
    });
    if (!member) throw notFound('member');
    return userId;
  }

  private window(from: string, to: string) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > MAX_WINDOW_MS)
      throw new BadRequestException({
        error: 'invalid',
        message: 'from must be before to, at most 31 days apart',
      });
    return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
  }

  async busy(p: Principal, query: Record<string, unknown>): Promise<BusyTimes> {
    const from = String(query.from ?? '');
    const to = String(query.to ?? '');
    const window = this.window(from, to);
    const userId = await this.whose(p, typeof query.userId === 'string' ? query.userId : undefined);
    return this.busyOf(p.tenantId as string, userId, window);
  }

  private async busyOf(
    tenantId: string,
    userId: string,
    window: { from: string; to: string },
  ): Promise<BusyTimes> {
    const google = googleSettings();
    const [conn] = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenantId),
          eq(calendarConnections.userId, userId),
          eq(calendarConnections.status, 'active'),
        ),
      );
    if (!google || !conn) return { connected: false, busy: [] };
    try {
      const accessToken = await accessTokenFor(this.db, google, conn);
      const api = googleCalendarClient(google.transport, {
        accessToken,
        endpoints: google.endpoints,
      });
      return {
        connected: true,
        busy: await api.freeBusy({ ...window, calendars: [conn.calendarId] }),
      };
    } catch (e) {
      if (e instanceof GrantRevoked) return { connected: false, busy: [] };
      throw e;
    }
  }

  async free(p: Principal, query: Record<string, unknown>): Promise<FreeTimes> {
    const q = parse(FreeTimeQuery, query);
    const window = this.window(q.from, q.to);
    const userId = await this.whose(p, q.userId);
    const busy = await this.busyOf(p.tenantId as string, userId, window);
    const [t] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, p.tenantId ?? ''));
    const timeZone = parseTenantSettings(t?.settings ?? {}).timeZone;
    return {
      connected: busy.connected,
      timeZone,
      slots: freeSlots(busy.busy, {
        ...window,
        minutes: q.minutes,
        stepMinutes: q.step,
        timeZone,
        limit: q.limit ?? 20,
        ...(q.hoursFrom || q.hoursTo
          ? { hours: { from: q.hoursFrom ?? '00:00', to: q.hoursTo ?? '23:59' } }
          : {}),
      }),
    };
  }

  /* ── Feeds ────────────────────────────────────────────────────────────── */

  async feeds(p: Principal): Promise<CalendarFeedInfo[]> {
    const rows = await this.db
      .select()
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.tenantId, p.tenantId ?? ''), eq(calendarFeeds.userId, userOf(p))))
      .orderBy(asc(calendarFeeds.createdAt));
    return rows.map(feedView);
  }

  /** A new feed; its URL (the token in it) is returned this once. */
  async createFeed(p: Principal, requestId: string, body: unknown) {
    const input = parse(CreateFeedInput, body);
    userOf(p);
    const token = `cf${randomBytes(32).toString('base64url')}`;
    const result = await this.write(p, requestId, createFeedOp(), {
      id: randomUUID(),
      ...(input.label ? { label: input.label } : {}),
      tokenHash: feedTokenHash(token),
    });
    return result.status === 'done' ? { ...result, url: feedUrl(token) } : result;
  }

  revokeFeed(p: Principal, requestId: string, id: string) {
    userOf(p);
    return this.write(p, requestId, revokeFeedOp({ id }), {});
  }

  /**
   * A feed's calendar: the person's own schedulable records, each read as them now. An unknown
   * or revoked token, or a person who left the business, is a 404.
   */
  async renderFeed(rawToken: string): Promise<string> {
    const token = rawToken.replace(/\.ics$/i, '');
    if (!/^cf[A-Za-z0-9_-]{43}$/.test(token)) throw notFound('feed');
    const [feed] = await this.db
      .select()
      .from(calendarFeeds)
      .where(eq(calendarFeeds.tokenHash, feedTokenHash(token)));
    if (!feed) throw notFound('feed');
    const p = await memberPrincipal(this.ctx.get, {
      userId: feed.userId,
      tenantId: feed.tenantId,
    });
    if (!p) throw notFound('feed');
    const from = new Date(Date.now() - FEED_BACK_MS);
    const to = new Date(Date.now() + FEED_AHEAD_MS);
    const events: IcsEvent[] = [];
    for (const s of schedulables()) {
      if (events.length >= FEED_MAX) break;
      const columns = getTableColumns(s.def.table) as Record<string, PgColumn>;
      const starts = columns[s.trait.startsAt];
      const ids = (await this.db
        .select({ id: columns.id })
        .from(s.def.table)
        .where(
          and(
            eq(columns.tenantId, feed.tenantId),
            namesPerson(s, feed.userId),
            ...(starts ? [gte(starts, from), lte(starts, to)] : []),
          ),
        )
        .limit(FEED_MAX - events.length)) as { id: string }[];
      for (const { id } of ids) {
        const row = await s.def.repo.find(this.db, p, id);
        if (!row) continue;
        const c = contentOf(s.trait, toJson(s.def.toRead(row, p)) as Record<string, unknown>);
        if (!c) continue;
        events.push({
          uid: uidOf(s.def.name, id),
          start: c.startsAt,
          end: c.endsAt,
          title: c.title,
          ...(c.description ? { description: c.description } : {}),
          ...(c.location ? { location: c.location } : {}),
        });
      }
    }
    const [business] = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, feed.tenantId));
    // Seen at most once a minute: a calendar app polls often.
    await this.db
      .update(calendarFeeds)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(calendarFeeds.id, feed.id),
          or(
            isNull(calendarFeeds.lastUsedAt),
            lt(calendarFeeds.lastUsedAt, new Date(Date.now() - 60_000)),
          ),
        ),
      );
    return icsCalendar({
      prodId: '-//Basecamp//Calendar feed//EN',
      ...(business?.name ? { name: feed.label ?? business.name } : {}),
      events,
    });
  }
}
