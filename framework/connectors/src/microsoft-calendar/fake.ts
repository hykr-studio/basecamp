// An in-memory Microsoft for tests and offline development: the consent screen, the token
// endpoint, and the Graph calls a calendar connection makes (events with their extended
// property, calendarView delta queries with deleted events kept, getSchedule, subscriptions
// with Graph's validation handshake). It answers the same requests the client sends, so the
// server runs unchanged on it. One per process (`fakeMicrosoft()`), shared through globalThis
// so a test and the server it booted see the same calendars.
import { randomBytes, randomUUID } from 'node:crypto';
import { pkceChallenge } from '../google-calendar/oauth.js';
import { BASECAMP_KEY_PROPERTY } from './client.js';
import {
  MICROSOFT_ENDPOINTS,
  type MicrosoftEndpoints,
  type MicrosoftRequest,
  type MicrosoftResponse,
  type MicrosoftTransport,
} from './transport.js';

/** An event as the fake keeps it: times are instants. */
export interface FakeMicrosoftEvent {
  id: string;
  subject: string;
  body?: string;
  location?: string;
  start: string;
  end: string;
  /** The zone it was written in. */
  timeZone: string;
  showAs: string;
  /** Our key, when it is ours. */
  key?: string;
  deleted: boolean;
}

interface Stored extends FakeMicrosoftEvent {
  seq: number;
}

interface Mailbox {
  events: Map<string, Stored>;
  seq: number;
  /** Delta tokens before this number answer 410. */
  oldestToken: number;
}

export interface FakeSubscription {
  id: string;
  email: string;
  notificationUrl: string;
  clientState: string;
  expiresAt: number;
}

export interface FakeMicrosoft {
  transport: MicrosoftTransport;
  endpoints: MicrosoftEndpoints;
  /**
   * The consent screen: the person (`email`) agrees, and the browser is sent back to the
   * authorization URL's redirect_uri with a code and its state (or with the organisation's
   * refusal, for an account that needs an admin's consent).
   */
  consent(authorizationUrl: string, email: string): string;
  /** Every event of an account's calendar, deleted ones included. */
  events(email: string): FakeMicrosoftEvent[];
  event(email: string, id: string): FakeMicrosoftEvent | undefined;
  /** As the person in Outlook: move or rename one of the calendar's events. */
  edit(
    email: string,
    id: string,
    patch: Partial<Pick<FakeMicrosoftEvent, 'start' | 'end' | 'subject'>>,
  ): void;
  /** As the person in Outlook: delete one. */
  remove(email: string, id: string): void;
  /** An event of the person's own (not ours): it makes them busy. */
  addOwnEvent(
    email: string,
    a: { start: string; end: string; subject?: string; showAs?: string },
  ): string;
  /** Open subscriptions (all, or one account's). */
  subscriptions(email?: string): FakeSubscription[];
  /** Post a change notification to each subscription of the account, as Graph does. */
  push(email: string, a?: { clientState?: string }): Promise<number[]>;
  /** Every request, in order. */
  requests: MicrosoftRequest[];
  /** The next request that matches answers this instead. */
  failNext(match: (req: MicrosoftRequest) => boolean, status: number, body?: unknown): void;
  /** The next request that matches is carried out, but its answer is lost (a 504). */
  loseNextAnswer(match: (req: MicrosoftRequest) => boolean): void;
  /** Every access token expires now: the next call needs a refresh. */
  expireAccessTokens(): void;
  /** Delta tokens issued so far stop working (410), as when Graph drops them. */
  expireDelta(email: string): void;
  /** The account's refresh tokens stop working (the person removed the app). */
  refuseRefresh(email: string): void;
  /**
   * The account's organisation requires an admin's consent: refused on the consent screen
   * (default) or when the code is exchanged.
   */
  requireAdminConsent(email: string, at?: 'consent' | 'exchange'): void;
  /** Forget everything. */
  reset(): void;
}

const json = (status: number, body: unknown): MicrosoftResponse => ({ status, body });
const graphError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/** A JWT-shaped ID token naming the account (unsigned: the fake's own). */
const idTokenFor = (email: string, oid: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ preferred_username: email, oid, tid: 'fake-tenant' })).toString(
      'base64url',
    ),
    '',
  ].join('.');

/** Graph's way of writing a UTC instant, with Prefer: outlook.timezone="UTC". */
const graphUtc = (iso: string) => `${new Date(iso).toISOString().slice(0, 19)}.0000000`;

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** A wall time in a zone, as an instant (as Graph reads an event's start). */
function instantOfWall(t: { dateTime?: string; timeZone?: string } | undefined): string | null {
  if (!t?.dateTime) return null;
  const wall = Date.parse(`${t.dateTime.replace(/(\.\d{3})\d+/, '$1').replace(/Z$/, '')}Z`);
  if (!Number.isFinite(wall)) return null;
  const zone = t.timeZone ?? 'UTC';
  let guess = wall - offsetMinutes(wall, zone) * 60_000;
  guess = wall - offsetMinutes(guess, zone) * 60_000;
  return new Date(guess).toISOString();
}

export function createFakeMicrosoft(
  endpoints: MicrosoftEndpoints = MICROSOFT_ENDPOINTS,
): FakeMicrosoft {
  let n = 0;
  const next = (prefix: string) => `${prefix}${++n}${randomBytes(6).toString('hex')}`;
  const mailboxes = new Map<string, Mailbox>();
  const codes = new Map<string, { email: string; challenge: string; redirectUri: string }>();
  const access = new Map<string, { email: string; expiresAt: number }>();
  const refresh = new Map<string, string>();
  const oids = new Map<string, string>();
  const consentRequired = new Map<string, 'consent' | 'exchange'>();
  const subscriptions = new Map<string, FakeSubscription>();
  const failures: { match: (r: MicrosoftRequest) => boolean; status: number; body: unknown }[] = [];
  const lost: ((r: MicrosoftRequest) => boolean)[] = [];
  const requests: MicrosoftRequest[] = [];

  const mailboxOf = (email: string) => {
    let m = mailboxes.get(email);
    if (!m) {
      m = { events: new Map(), seq: 0, oldestToken: 0 };
      mailboxes.set(email, m);
    }
    return m;
  };
  const touch = (m: Mailbox, e: Stored) => {
    m.seq += 1;
    e.seq = m.seq;
    m.events.set(e.id, e);
  };
  const plain = ({ seq: _seq, ...e }: Stored): FakeMicrosoftEvent => structuredClone(e);
  const oidOf = (email: string) => {
    let oid = oids.get(email);
    if (!oid) {
      oid = next('oid-');
      oids.set(email, oid);
    }
    return oid;
  };

  /** What Graph shows of an event (a delta or a read): ids, times and — as Graph does — its subject. */
  const shown = (e: Stored) => ({
    id: e.id,
    subject: e.subject,
    showAs: e.showAs,
    isAllDay: false,
    isCancelled: false,
    start: { dateTime: graphUtc(e.start), timeZone: 'UTC' },
    end: { dateTime: graphUtc(e.end), timeZone: 'UTC' },
  });

  function tokenEndpoint(req: MicrosoftRequest): MicrosoftResponse {
    const f = Object.fromEntries(new URLSearchParams(req.body ?? ''));
    const issue = (email: string) => {
      const at = next('fake-ms-at-');
      access.set(at, { email, expiresAt: Date.now() + 3600_000 });
      // Microsoft rotates refresh tokens: a new one with every answer.
      const rt = next('fake-ms-rt-');
      refresh.set(rt, email);
      return json(200, {
        token_type: 'Bearer',
        access_token: at,
        refresh_token: rt,
        expires_in: 3600,
        scope: 'openid email profile offline_access Calendars.ReadWrite',
        id_token: idTokenFor(email, oidOf(email)),
      });
    };
    if (f.grant_type === 'authorization_code') {
      const grant = codes.get(f.code ?? '');
      codes.delete(f.code ?? '');
      if (!grant)
        return json(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS70000: The provided authorization code is invalid.',
        });
      if (pkceChallenge(f.code_verifier ?? '') !== grant.challenge)
        return json(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge.',
        });
      if (f.redirect_uri !== grant.redirectUri)
        return json(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS50011: The redirect URI does not match.',
        });
      if (consentRequired.get(grant.email) === 'exchange')
        return json(400, {
          error: 'invalid_grant',
          error_description:
            'AADSTS65001: The user or administrator has not consented to use the application.',
          error_codes: [65001],
        });
      return issue(grant.email);
    }
    if (f.grant_type === 'refresh_token') {
      const email = refresh.get(f.refresh_token ?? '');
      if (!email)
        return json(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS70008: The refresh token has expired or been revoked.',
        });
      return issue(email);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  async function graph(req: MicrosoftRequest, email: string): Promise<MicrosoftResponse> {
    const url = new URL(req.url);
    const path = url.pathname.slice(new URL(endpoints.graph).pathname.length);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const m = mailboxOf(email);

    if (req.method === 'POST' && path === '/me/calendar/getSchedule') {
      const from = Date.parse(instantOfWall(body.startTime as never) ?? '');
      const to = Date.parse(instantOfWall(body.endTime as never) ?? '');
      const schedules = (body.schedules as string[]) ?? [];
      return json(200, {
        value: schedules.map((scheduleId) => ({
          scheduleId,
          ...(scheduleId.toLowerCase() !== email.toLowerCase()
            ? { error: { message: 'Not this mailbox', responseCode: 'ErrorMailboxNotFound' } }
            : {
                scheduleItems: [...m.events.values()]
                  .filter((e) => !e.deleted && e.showAs !== 'free')
                  .filter((e) => Date.parse(e.end) > from && Date.parse(e.start) < to)
                  .map((e) => ({
                    status: e.showAs,
                    subject: e.subject,
                    location: e.location ?? '',
                    start: { dateTime: graphUtc(e.start), timeZone: 'UTC' },
                    end: { dateTime: graphUtc(e.end), timeZone: 'UTC' },
                  })),
              }),
        })),
      });
    }

    if (req.method === 'GET' && path === '/me/calendarView/delta') {
      const pageSize = Number(
        /odata\.maxpagesize=(\d+)/.exec(req.headers?.prefer ?? '')?.[1] ?? 100,
      );
      const token = url.searchParams.get('$deltatoken');
      const skip = url.searchParams.get('$skiptoken');
      let after = 0;
      let windowFrom: number;
      let windowTo: number;
      if (token) {
        const [seq, wf, wt] = token.split('_').map(Number);
        if (!Number.isFinite(seq) || seq < m.oldestToken)
          return graphError(410, 'syncStateNotFound', 'The sync state generation is not found.');
        after = seq;
        windowFrom = wf;
        windowTo = wt;
      } else if (skip) {
        const [, wf, wt, , a] = skip.split('_').map(Number);
        windowFrom = wf;
        windowTo = wt;
        after = a;
      } else {
        windowFrom = Date.parse(url.searchParams.get('startDateTime') ?? '');
        windowTo = Date.parse(url.searchParams.get('endDateTime') ?? '');
        if (!Number.isFinite(windowFrom) || !Number.isFinite(windowTo))
          return graphError(400, 'ErrorInvalidParameter', 'startDateTime and endDateTime');
      }
      const inWindow = (e: Stored) =>
        Date.parse(e.end) > windowFrom && Date.parse(e.start) < windowTo;
      const all = [...m.events.values()]
        .filter((e) => (token || (skip && after) ? e.seq > after : !e.deleted && inWindow(e)))
        .sort((x, y) => x.seq - y.seq)
        .map((e) =>
          e.deleted || !inWindow(e)
            ? { id: e.id, '@removed': { reason: e.deleted ? 'deleted' : 'changed' } }
            : shown(e),
        );
      const offset = skip ? Number(skip.split('_')[3]) : 0;
      const page = all.slice(offset, offset + pageSize);
      const base = `${endpoints.graph}/me/calendarView/delta`;
      const more = offset + pageSize < all.length;
      const link = more
        ? {
            '@odata.nextLink': `${base}?$skiptoken=${m.seq}_${windowFrom}_${windowTo}_${offset + pageSize}_${after}`,
          }
        : { '@odata.deltaLink': `${base}?$deltatoken=${m.seq}_${windowFrom}_${windowTo}` };
      return json(200, { value: page, ...link });
    }

    if (path === '/subscriptions' && req.method === 'POST') {
      const expiresAt = Date.parse(String(body.expirationDateTime));
      if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 4230 * 60_000)
        return graphError(
          400,
          'ExtensionError',
          'Subscription expiration can only be 4230 minutes in the future.',
        );
      if (body.resource !== '/me/events')
        return graphError(400, 'InvalidRequest', `Unknown resource ${String(body.resource)}`);
      const notificationUrl = String(body.notificationUrl);
      // Graph checks the address first: it must echo the token, as text, in ten seconds.
      const validationToken = `Validation: Testing client application reachability ${next('vt-')}`;
      let ok = false;
      try {
        const res = await fetch(
          `${notificationUrl}${notificationUrl.includes('?') ? '&' : '?'}validationToken=${encodeURIComponent(validationToken)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            signal: AbortSignal.timeout(10_000),
          },
        );
        ok =
          res.status === 200 &&
          (res.headers.get('content-type') ?? '').startsWith('text/plain') &&
          (await res.text()) === validationToken;
      } catch {
        ok = false;
      }
      if (!ok)
        return graphError(
          400,
          'ValidationError',
          'Subscription validation request failed. Response must exactly match validationToken query parameter.',
        );
      const sub: FakeSubscription = {
        id: randomUUID(),
        email,
        notificationUrl,
        clientState: String(body.clientState ?? ''),
        expiresAt,
      };
      subscriptions.set(sub.id, sub);
      return json(201, {
        id: sub.id,
        resource: '/me/events',
        changeType: body.changeType,
        notificationUrl,
        expirationDateTime: new Date(expiresAt).toISOString(),
      });
    }
    const sub = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (sub && req.method === 'DELETE') {
      const s = subscriptions.get(decodeURIComponent(sub[1]));
      if (!s || s.email !== email) return graphError(404, 'ResourceNotFound', 'No subscription');
      subscriptions.delete(s.id);
      return json(204, null);
    }

    if (path === '/me/events' && req.method === 'GET') {
      const filter = url.searchParams.get('$filter') ?? '';
      const f = /ep\/id eq '([^']+)' and ep\/value eq '([^']+)'/.exec(filter);
      if (!f || f[1] !== BASECAMP_KEY_PROPERTY)
        return graphError(400, 'ErrorInvalidProperty', 'Only our key is filtered on here');
      const found = [...m.events.values()].filter((e) => !e.deleted && e.key === f[2]);
      return json(200, { value: found.map((e) => ({ id: e.id })) });
    }
    const fromBody = (prev?: Stored): Stored | string => {
      const start = body.start ? instantOfWall(body.start as never) : (prev?.start ?? null);
      const end = body.end ? instantOfWall(body.end as never) : (prev?.end ?? null);
      if (!start || !end) return 'start and end are required';
      const ext = (
        body.singleValueExtendedProperties as { id: string; value: string }[] | undefined
      )?.find((p) => p.id === BASECAMP_KEY_PROPERTY);
      return {
        id: prev?.id ?? `AAMkAD${next('')}`,
        subject: body.subject !== undefined ? String(body.subject) : (prev?.subject ?? ''),
        ...((body.body as { content?: string })?.content
          ? { body: (body.body as { content: string }).content }
          : {}),
        ...((body.location as { displayName?: string })?.displayName
          ? { location: (body.location as { displayName: string }).displayName }
          : {}),
        start,
        end,
        timeZone: (body.start as { timeZone?: string })?.timeZone ?? prev?.timeZone ?? 'UTC',
        showAs: String(body.showAs ?? prev?.showAs ?? 'busy'),
        ...(ext ? { key: ext.value } : prev?.key ? { key: prev.key } : {}),
        deleted: false,
        seq: 0,
      };
    };
    if (path === '/me/events' && req.method === 'POST') {
      const e = fromBody();
      if (typeof e === 'string') return graphError(400, 'ErrorInvalidRequest', e);
      touch(m, e);
      return json(201, { ...shown(e) });
    }
    const one = /^\/me\/events\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const e = m.events.get(id);
      if (!e || e.deleted)
        return graphError(
          404,
          'ErrorItemNotFound',
          'The specified object was not found in the store.',
        );
      if (req.method === 'PATCH') {
        const updated = fromBody(e);
        if (typeof updated === 'string') return graphError(400, 'ErrorInvalidRequest', updated);
        touch(m, updated);
        return json(200, shown(updated));
      }
      if (req.method === 'DELETE') {
        touch(m, { ...e, deleted: true });
        return json(204, null);
      }
      if (req.method === 'GET') return json(200, shown(e));
    }
    return graphError(404, 'UnknownRoute', `No route ${req.method} ${path}`);
  }

  const run = async (req: MicrosoftRequest): Promise<MicrosoftResponse> => {
    if (
      /\/oauth2\/v2\.0\/token$/.test(new URL(req.url).pathname) &&
      req.url.startsWith(endpoints.login)
    )
      return tokenEndpoint(req);
    if (!req.url.startsWith(endpoints.graph)) return json(404, { error: 'unknown endpoint' });
    const bearer = /^Bearer (.+)$/.exec(req.headers?.authorization ?? '')?.[1] ?? '';
    const grant = access.get(bearer);
    if (!grant || grant.expiresAt <= Date.now())
      return graphError(
        401,
        'InvalidAuthenticationToken',
        'Access token has expired or is not yet valid.',
      );
    return graph(req, grant.email);
  };

  const transport: MicrosoftTransport = async (req) => {
    requests.push(structuredClone(req));
    const failing = failures.findIndex((f) => f.match(req));
    if (failing >= 0) {
      const [f] = failures.splice(failing, 1);
      return json(
        f.status,
        f.body ?? { error: { code: 'InjectedFailure', message: 'Injected failure' } },
      );
    }
    const losing = lost.findIndex((match) => match(req));
    const res = await run(req);
    if (losing >= 0) {
      lost.splice(losing, 1);
      return graphError(504, 'GatewayTimeout', 'The answer was lost');
    }
    return res;
  };

  const own = (email: string, id: string) => {
    const m = mailboxOf(email);
    const e = m.events.get(id);
    if (!e || e.deleted) throw new Error(`No event ${id} in ${email}'s calendar`);
    return { m, e };
  };

  return {
    transport,
    endpoints,
    requests,
    consent(authorizationUrl, email) {
      const url = new URL(authorizationUrl);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const back = new URL(redirectUri);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (consentRequired.get(email) === 'consent') {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set(
          'error_description',
          'AADSTS90094: Admin consent is required for the permissions requested by this application.',
        );
        return back.toString();
      }
      const code = next('fake-ms-code-');
      codes.set(code, {
        email,
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
      });
      back.searchParams.set('code', code);
      return back.toString();
    },
    events: (email) => [...mailboxOf(email).events.values()].map(plain),
    event: (email, id) => {
      const e = mailboxOf(email).events.get(id);
      return e ? plain(e) : undefined;
    },
    edit(email, id, patch) {
      const { m, e } = own(email, id);
      touch(m, { ...e, ...structuredClone(patch) });
    },
    remove(email, id) {
      const { m, e } = own(email, id);
      touch(m, { ...e, deleted: true });
    },
    addOwnEvent(email, a) {
      const m = mailboxOf(email);
      const id = `AAMkAD${next('own')}`;
      touch(m, {
        id,
        subject: a.subject ?? 'Busy',
        start: new Date(a.start).toISOString(),
        end: new Date(a.end).toISOString(),
        timeZone: 'UTC',
        showAs: a.showAs ?? 'busy',
        deleted: false,
        seq: 0,
      });
      return id;
    },
    subscriptions: (email) =>
      [...subscriptions.values()].filter((s) => !email || s.email === email),
    async push(email, a = {}) {
      const statuses: number[] = [];
      for (const s of subscriptions.values()) {
        if (s.email !== email) continue;
        const res = await fetch(s.notificationUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            value: [
              {
                subscriptionId: s.id,
                subscriptionExpirationDateTime: new Date(s.expiresAt).toISOString(),
                changeType: 'updated',
                resource: `Users/${oidOf(email)}/Events/${next('ev')}`,
                clientState: a.clientState ?? s.clientState,
                tenantId: 'fake-tenant',
              },
            ],
          }),
        });
        statuses.push(res.status);
      }
      return statuses;
    },
    failNext(match, status, body) {
      failures.push({ match, status, body });
    },
    loseNextAnswer(match) {
      lost.push(match);
    },
    expireAccessTokens() {
      for (const grant of access.values()) grant.expiresAt = 0;
    },
    expireDelta(email) {
      const m = mailboxOf(email);
      m.oldestToken = m.seq + 1;
    },
    refuseRefresh(email) {
      for (const [rt, e] of refresh) if (e === email) refresh.delete(rt);
    },
    requireAdminConsent(email, at = 'consent') {
      consentRequired.set(email, at);
    },
    reset() {
      mailboxes.clear();
      codes.clear();
      access.clear();
      refresh.clear();
      oids.clear();
      consentRequired.clear();
      subscriptions.clear();
      failures.length = 0;
      lost.length = 0;
      requests.length = 0;
    },
  };
}

const KEY = Symbol.for('@hykr/connectors/microsoft-calendar/fake');

/** This process's fake Microsoft: the server's transport in fake mode, and what tests inspect. */
export function fakeMicrosoft(): FakeMicrosoft {
  const g = globalThis as { [KEY]?: FakeMicrosoft };
  g[KEY] ??= createFakeMicrosoft();
  return g[KEY];
}
