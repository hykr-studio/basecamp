// A person's calendars: connecting one (OAuth with PKCE, finished only under the session of the
// person who started it), the list, the disconnect; busy and free time; private feeds. Writes go
// through runWrite (ops.ts).
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
  CompleteCalendarInput,
  ConnectCalendarInput,
  CreateFeedInput,
  FreeTimeQuery,
  type FreeTimes,
  freeSlots,
  openHoursOf,
  type Principal,
  parseTenantSettings,
} from '@hykr/contracts';
import {
  findRepeat,
  runWrite,
  tenantZone,
  toJson,
  type WriteCtx,
  type WriteOp,
  type WriteOutcome,
} from '@hykr/core';
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
  appReturnUrl,
  checkCalendarSettings,
  feedUrl,
  googleSettings,
  requireGoogle,
  returnUrl,
} from './settings.js';
import { beginSignIn, findSignIn, takeSignIn, verifierOf } from './sign-in.js';
import { CalendarSyncService } from './sync.service.js';
import { accessTokenFor, GrantRevoked, sealTokens } from './tokens.js';

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

/** Who asks, and how to recognise their retry: the request's id and idempotency-key. */
export type CalendarWriteMeta = { requestId: string; idempotencyKey?: string };

const writeCtx = (p: Principal, meta: CalendarWriteMeta, requestBody?: unknown): WriteCtx => ({
  principal: p,
  requestId: meta.requestId,
  ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
  ...(requestBody !== undefined ? { requestBody } : {}),
});

/** Where the browser lands after Google, with what it brought back. */
const landing = (to: string, outcome: Record<string, string>) => {
  const url = new URL(to);
  for (const [k, v] of Object.entries(outcome)) url.searchParams.set(k, v);
  return url.toString();
};

const refused = (rule: string, message: string) =>
  new BadRequestException({ error: 'invalid', rule, message });

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

  /**
   * One write, honouring the caller's idempotency-key. `requestBody` is what the caller sent,
   * when the input also holds what this request made (an id, sealed tokens, a token's hash).
   */
  private async run(
    p: Principal,
    meta: CalendarWriteMeta,
    // biome-ignore lint/suspicious/noExplicitAny: any of the feature's ops
    op: WriteOp<any, any, any>,
    input: unknown,
    requestBody?: unknown,
  ): Promise<WriteOutcome> {
    const out = await runWrite(this.db, writeCtx(p, meta, requestBody), op, input);
    for (const event of out.events) this.events.publish(event);
    return out;
  }

  /* ── Connections ──────────────────────────────────────────────────────── */

  providers(): CalendarProviderInfo[] {
    return [{ name: 'google', available: googleSettings() !== null }];
  }

  /** The consent screen's URL for this person, in this business. */
  async start(p: Principal, body: unknown): Promise<{ url: string }> {
    const input = parse(ConnectCalendarInput, body);
    const userId = userOf(p);
    if (!p.tenantId)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'no_business',
        reason: 'Connect a calendar from within a business',
      });
    const google = requireGoogle();
    requireSecretBox();
    const pkce = pkcePair();
    // The verifier stays here, under a random state: the URL carries nothing it could be read from.
    const state = await beginSignIn(this.db, {
      tenantId: p.tenantId,
      userId,
      provider: 'google',
      verifier: pkce.verifier,
      returnTo: input.returnTo === 'app' ? appReturnUrl() : returnUrl(),
    });
    const [me] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    const url = authorizationUrl({
      clientId: google.clientId,
      redirectUri: google.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      endpoints: google.endpoints,
      ...(me?.email ? { loginHint: me.email } : {}),
    });
    // Offline: the fake's consent screen agrees at once, as the person's own address.
    if (google.mode === 'fake') return { url: fakeGoogle().consent(url, me?.email ?? userId) };
    return { url };
  }

  /**
   * Google sends the browser back here, with no session to trust. Nothing is exchanged: the
   * browser goes on to the app, with the code and the state, and the app finishes the sign-in
   * under its own session (`complete`). Returns where the browser goes next.
   */
  async callback(query: Record<string, unknown>): Promise<string> {
    const signIn = await findSignIn(this.db, query.state);
    if (!signIn) return landing(returnUrl(), { error: 'sign_in_expired' });
    if (typeof query.error === 'string') {
      // The person said no (or Google could not ask): this sign-in is over.
      await takeSignIn(this.db, query.state);
      return landing(signIn.returnTo, { error: query.error.slice(0, 100) });
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 2048) return landing(signIn.returnTo, { error: 'no_code' });
    return landing(signIn.returnTo, { code, state: query.state as string });
  }

  /**
   * The app finishes a sign-in under the session of the person who started it, in the business
   * they started it in. The sign-in is taken first, so a refused try also ends it: a code that
   * reached someone else's browser can never be exchanged, by them or by the one who started it.
   * Only then is the code exchanged, with the verifier kept here, and the connection written as
   * this person.
   */
  async complete(p: Principal, meta: CalendarWriteMeta, body: unknown) {
    const input = parse(CompleteCalendarInput, body);
    const userId = userOf(p);
    // A retry with the same key answers the first answer: the sign-in and Google's code were
    // used up by it, so look before taking them.
    const op = connectOp();
    const repeat = await findRepeat(this.db, writeCtx(p, meta), op, input);
    if (repeat) return repeat.result;
    const google = requireGoogle();
    const box = requireSecretBox();
    const signIn = await takeSignIn(this.db, input.state);
    if (!signIn)
      throw refused(
        'calendar_sign_in_invalid',
        'This calendar sign-in is old or was used already: start again',
      );
    if (signIn.userId !== userId) {
      log.warn(`calendar sign-in of ${signIn.userId} refused to ${userId}: not theirs`);
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'calendar_sign_in_not_yours',
        reason:
          'Someone else started this calendar sign-in, so nothing was connected. Start one yourself.',
      });
    }
    if (signIn.tenantId !== p.tenantId)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'calendar_sign_in_other_business',
        reason:
          'This calendar sign-in was started in another business, so nothing was connected. Start again here.',
      });
    const tenantId = signIn.tenantId;
    let codeVerifier: string;
    try {
      codeVerifier = verifierOf(signIn);
    } catch {
      // Sealed with a key this server no longer has.
      throw refused(
        'calendar_sign_in_invalid',
        'This calendar sign-in cannot be finished: start again',
      );
    }
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(google.transport, {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        endpoints: google.endpoints,
        redirectUri: google.redirectUri,
        code: input.code,
        codeVerifier,
      });
    } catch (e) {
      log.warn(`Google refused the code: ${e instanceof Error ? e.message : e}`);
      throw refused('google_refused', 'Google did not accept this sign-in: start again');
    }
    if (!tokens.refreshToken)
      throw refused(
        'no_offline_access',
        'Google gave no lasting access to the calendar: remove the app in your Google account and connect again',
      );
    const account = tokens.email ?? 'Google account';
    const [existing] = await this.db
      .select()
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenantId),
          eq(calendarConnections.userId, userId),
          eq(calendarConnections.provider, 'google'),
        ),
      );
    // Another Google account than before: take our events out of the old one first.
    const old =
      existing && existing.account !== account ? await this.sync.leftovers(existing.id) : null;
    const id = existing?.id ?? randomUUID();
    const inboundId = randomUUID();
    const { result, repeat: again } = await this.run(
      p,
      meta,
      op,
      {
        id,
        provider: 'google',
        account,
        scopes: (tokens.scope ?? '').split(' ').filter(Boolean).slice(0, 20),
        sealed: sealTokens(tenantId, id, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        }),
        inbound: {
          id: inboundId,
          sealed: box.seal(
            JSON.stringify(googleCalendarConnector.generate?.()),
            connectionAad(tenantId, inboundId),
          ),
        },
      },
      input,
    );
    if (result.status === 'done' && old && !again) await this.sync.cleanUp(old);
    return result;
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
  async disconnect(p: Principal, meta: CalendarWriteMeta, id: string) {
    userOf(p);
    const left = await this.sync.leftovers(id);
    const { result, repeat } = await this.run(p, meta, disconnectOp({ id }), {});
    if (result.status === 'done' && left && !repeat) await this.sync.cleanUp(left);
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
    const settings = parseTenantSettings(t?.settings ?? {});
    const timeZone = tenantZone(settings);
    // Hours asked for are the answer's; otherwise the business's own open hours and holidays
    // (none set: every hour). The framework assumes no working day of its own.
    const asked = !!(q.hoursFrom || q.hoursTo);
    return {
      connected: busy.connected,
      timeZone,
      slots: freeSlots(busy.busy, {
        ...window,
        minutes: q.minutes,
        stepMinutes: q.step,
        timeZone,
        limit: q.limit ?? 20,
        ...(asked
          ? { hours: { from: q.hoursFrom ?? '00:00', to: q.hoursTo ?? '23:59' } }
          : { open: openHoursOf(settings.businessHours) }),
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

  /**
   * A new feed; its URL (the token in it) is returned this once. A retry with the same key is
   * the same feed, without its URL: only the token's hash is kept.
   */
  async createFeed(p: Principal, meta: CalendarWriteMeta, body: unknown) {
    const input = parse(CreateFeedInput, body);
    userOf(p);
    const token = `cf${randomBytes(32).toString('base64url')}`;
    const { result, repeat } = await this.run(
      p,
      meta,
      createFeedOp(),
      {
        id: randomUUID(),
        ...(input.label ? { label: input.label } : {}),
        tokenHash: feedTokenHash(token),
      },
      input,
    );
    return result.status === 'done' && !repeat ? { ...result, url: feedUrl(token) } : result;
  }

  async revokeFeed(p: Principal, meta: CalendarWriteMeta, id: string) {
    userOf(p);
    return (await this.run(p, meta, revokeFeedOp({ id }), {})).result;
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
