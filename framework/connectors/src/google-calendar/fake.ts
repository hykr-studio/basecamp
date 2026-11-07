// An in-memory Google for tests and offline development: the consent screen, the token and
// revocation endpoints, and the Calendar API's events (with sync tokens and deleted events kept,
// as Google does), free/busy and push channels. It answers the same requests the client sends,
// so the server runs unchanged on it. One per process (`fakeGoogle()`), shared through
// globalThis so a test and the server it booted see the same calendars.
import { randomBytes } from 'node:crypto';
import type { GoogleEvent } from './client.js';
import { notificationHeaders } from './connector.js';
import { pkceChallenge } from './oauth.js';
import {
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type GoogleRequest,
  type GoogleResponse,
  type GoogleTransport,
} from './transport.js';

interface StoredEvent extends GoogleEvent {
  /** The change number of its last change: listed by sync tokens after it. */
  seq: number;
}

interface Calendar {
  events: Map<string, StoredEvent>;
  seq: number;
  /** Sync tokens before this number answer 410. */
  oldestToken: number;
}

export interface FakeChannel {
  id: string;
  token: string;
  address: string;
  resourceId: string;
  email: string;
  calendarId: string;
  expiration: number;
  messages: number;
}

export interface FakeGoogle {
  transport: GoogleTransport;
  endpoints: GoogleEndpoints;
  /**
   * The consent screen: the person (`email`) agrees, and the browser is sent back to the
   * authorization URL's redirect_uri with a code and its state.
   */
  consent(authorizationUrl: string, email: string): string;
  /** Every event of an account's calendar, deleted ones included. */
  events(email: string, calendarId?: string): GoogleEvent[];
  event(email: string, id: string, calendarId?: string): GoogleEvent | undefined;
  /** As the person in Google: move or rename one of the calendar's events. */
  edit(
    email: string,
    id: string,
    patch: Partial<Pick<GoogleEvent, 'start' | 'end' | 'summary'>>,
  ): void;
  /** As the person in Google: delete one. */
  remove(email: string, id: string): void;
  /** An event of the person's own (not ours): it makes them busy. */
  addOwnEvent(email: string, a: { start: string; end: string; summary?: string }): string;
  /** Open channels (all, or one account's). */
  channels(email?: string): FakeChannel[];
  /** Post a change notification to each open channel of the account, as Google does. */
  push(email: string, calendarId?: string): Promise<number[]>;
  /** Tokens that were revoked. */
  revoked(): string[];
  /** Every request, in order. */
  requests: GoogleRequest[];
  /** The next request that matches answers this instead. */
  failNext(match: (req: GoogleRequest) => boolean, status: number, body?: unknown): void;
  /** Every access token expires now: the next call needs a refresh. */
  expireAccessTokens(): void;
  /** Sync tokens issued so far stop working (410), as when Google drops them. */
  expireSyncTokens(email: string, calendarId?: string): void;
  /** Forget everything. */
  reset(): void;
}

const json = (status: number, body: unknown): GoogleResponse => ({ status, body });
const apiError = (status: number, reason: string, message: string) =>
  json(status, { error: { code: status, message, errors: [{ reason, message }] } });

/** A JWT-shaped ID token naming the account (unsigned: the fake's own). */
const idTokenFor = (email: string) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url'),
    '',
  ].join('.');

export function createFakeGoogle(endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS): FakeGoogle {
  let n = 0;
  const next = (prefix: string) => `${prefix}${++n}${randomBytes(4).toString('hex')}`;
  const calendars = new Map<string, Calendar>();
  const codes = new Map<string, { email: string; challenge: string; redirectUri: string }>();
  const access = new Map<string, { email: string; expiresAt: number }>();
  const refresh = new Map<string, string>();
  const revoked: string[] = [];
  const channels = new Map<string, FakeChannel>();
  const failures: { match: (r: GoogleRequest) => boolean; status: number; body: unknown }[] = [];
  const requests: GoogleRequest[] = [];

  const calendarOf = (email: string, calendarId = 'primary') => {
    const key = `${email}|${calendarId === email ? 'primary' : calendarId}`;
    let c = calendars.get(key);
    if (!c) {
      c = { events: new Map(), seq: 0, oldestToken: 0 };
      calendars.set(key, c);
    }
    return c;
  };
  const touch = (c: Calendar, e: StoredEvent) => {
    c.seq += 1;
    e.seq = c.seq;
    e.updated = new Date().toISOString();
    c.events.set(e.id, e);
  };
  const plain = ({ seq: _seq, ...e }: StoredEvent): GoogleEvent => structuredClone(e);

  const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ''));

  function tokenEndpoint(req: GoogleRequest): GoogleResponse {
    const f = form(req.body);
    const issue = (email: string, withRefresh: boolean) => {
      const at = next('fake-at-');
      access.set(at, { email, expiresAt: Date.now() + 3600_000 });
      const out: Record<string, unknown> = {
        access_token: at,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/calendar.events',
        id_token: idTokenFor(email),
      };
      if (withRefresh) {
        const rt = next('fake-rt-');
        refresh.set(rt, email);
        out.refresh_token = rt;
      }
      return json(200, out);
    };
    if (f.grant_type === 'authorization_code') {
      const grant = codes.get(f.code ?? '');
      codes.delete(f.code ?? '');
      if (!grant) return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
      if (pkceChallenge(f.code_verifier ?? '') !== grant.challenge)
        return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      if (f.redirect_uri !== grant.redirectUri)
        return json(400, { error: 'redirect_uri_mismatch' });
      return issue(grant.email, true);
    }
    if (f.grant_type === 'refresh_token') {
      const email = refresh.get(f.refresh_token ?? '');
      if (!email)
        return json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' });
      return issue(email, false);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function api(req: GoogleRequest, email: string): GoogleResponse {
    const url = new URL(req.url);
    const path = url.pathname.slice(new URL(endpoints.api).pathname.length);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    if (req.method === 'POST' && path === '/freeBusy') {
      const from = Date.parse(String(body.timeMin));
      const to = Date.parse(String(body.timeMax));
      const out: Record<string, { busy: { start: string; end: string }[] }> = {};
      for (const { id } of (body.items as { id: string }[]) ?? []) {
        const c = calendarOf(email, id);
        out[id] = {
          busy: [...c.events.values()]
            .filter((e) => e.status !== 'cancelled' && e.start?.dateTime && e.end?.dateTime)
            .map((e) => ({ start: String(e.start?.dateTime), end: String(e.end?.dateTime) }))
            .filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to)
            .map((b) => ({
              start: new Date(Math.max(from, Date.parse(b.start))).toISOString(),
              end: new Date(Math.min(to, Date.parse(b.end))).toISOString(),
            })),
        };
      }
      return json(200, { kind: 'calendar#freeBusy', calendars: out });
    }
    if (req.method === 'POST' && path === '/channels/stop') {
      const ch = channels.get(String(body.id));
      if (!ch || ch.resourceId !== body.resourceId)
        return apiError(404, 'notFound', 'Channel not found');
      channels.delete(ch.id);
      return json(204, null);
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/(watch|[^/]+))?$/.exec(path);
    if (!m) return apiError(404, 'notFound', `No route ${req.method} ${path}`);
    const calendarId = decodeURIComponent(m[1]);
    const c = calendarOf(email, calendarId);
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (id === 'watch' && req.method === 'POST') {
      const resourceId = next('res-');
      const ttl = Number((body.params as { ttl?: string } | undefined)?.ttl ?? 604_800);
      const ch: FakeChannel = {
        id: String(body.id),
        token: String(body.token ?? ''),
        address: String(body.address),
        resourceId,
        email,
        calendarId: calendarId === email ? 'primary' : calendarId,
        expiration: Date.now() + ttl * 1000,
        messages: 0,
      };
      channels.set(ch.id, ch);
      return json(200, {
        kind: 'api#channel',
        id: ch.id,
        resourceId,
        resourceUri: req.url,
        expiration: String(ch.expiration),
      });
    }
    if (!id && req.method === 'GET') {
      const token = url.searchParams.get('syncToken');
      let after = 0;
      if (token) {
        const at = Number(token.replace(/^st-/, ''));
        if (!Number.isFinite(at) || at < c.oldestToken)
          return apiError(410, 'fullSyncRequired', 'Sync token is no longer valid');
        after = at;
      }
      const items = [...c.events.values()]
        .filter((e) => (token ? e.seq > after : e.status !== 'cancelled'))
        .sort((x, y) => x.seq - y.seq)
        .map(plain);
      return json(200, { kind: 'calendar#events', items, nextSyncToken: `st-${c.seq}` });
    }
    if (!id && req.method === 'POST') {
      const eventId = String(body.id ?? next('ev'));
      if (c.events.has(eventId))
        return apiError(409, 'duplicate', 'The requested identifier already exists.');
      const e = { ...(body as unknown as GoogleEvent), id: eventId, seq: 0 } as StoredEvent;
      e.status = e.status ?? 'confirmed';
      touch(c, e);
      return json(200, plain(e));
    }
    if (id && req.method === 'PUT') {
      if (!c.events.has(id)) return apiError(404, 'notFound', 'Not Found');
      const e = { ...(body as unknown as GoogleEvent), id, seq: 0 } as StoredEvent;
      e.status = e.status ?? 'confirmed';
      touch(c, e);
      return json(200, plain(e));
    }
    if (id && req.method === 'GET') {
      const e = c.events.get(id);
      return e ? json(200, plain(e)) : apiError(404, 'notFound', 'Not Found');
    }
    if (id && req.method === 'DELETE') {
      const e = c.events.get(id);
      if (!e) return apiError(404, 'notFound', 'Not Found');
      if (e.status === 'cancelled') return apiError(410, 'deleted', 'Resource has been deleted');
      touch(c, { ...e, status: 'cancelled' });
      return json(204, null);
    }
    return apiError(405, 'methodNotAllowed', `${req.method} ${path}`);
  }

  const transport: GoogleTransport = async (req) => {
    requests.push(structuredClone(req));
    const failing = failures.findIndex((f) => f.match(req));
    if (failing >= 0) {
      const [f] = failures.splice(failing, 1);
      return json(f.status, f.body ?? { error: { code: f.status, message: 'Injected failure' } });
    }
    if (req.url === endpoints.token) return tokenEndpoint(req);
    if (req.url === endpoints.revoke) {
      const token = form(req.body).token ?? '';
      revoked.push(token);
      refresh.delete(token);
      access.delete(token);
      return json(200, {});
    }
    if (!req.url.startsWith(endpoints.api)) return json(404, { error: 'unknown endpoint' });
    const bearer = /^Bearer (.+)$/.exec(req.headers?.authorization ?? '')?.[1] ?? '';
    const grant = access.get(bearer);
    if (!grant || grant.expiresAt <= Date.now())
      return apiError(401, 'authError', 'Invalid Credentials');
    return api(req, grant.email);
  };

  const fake: FakeGoogle = {
    transport,
    endpoints,
    requests,
    consent(authorizationUrl, email) {
      const url = new URL(authorizationUrl);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const code = next('fake-code-');
      codes.set(code, {
        email,
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return back.toString();
    },
    events: (email, calendarId) => [...calendarOf(email, calendarId).events.values()].map(plain),
    event: (email, id, calendarId) => {
      const e = calendarOf(email, calendarId).events.get(id);
      return e ? plain(e) : undefined;
    },
    edit(email, id, patch) {
      const c = calendarOf(email);
      const e = c.events.get(id);
      if (!e) throw new Error(`No event ${id} in ${email}'s calendar`);
      touch(c, { ...e, ...structuredClone(patch) });
    },
    remove(email, id) {
      const c = calendarOf(email);
      const e = c.events.get(id);
      if (!e) throw new Error(`No event ${id} in ${email}'s calendar`);
      touch(c, { ...e, status: 'cancelled' });
    },
    addOwnEvent(email, a) {
      const c = calendarOf(email);
      const id = next('own');
      touch(c, {
        id,
        seq: 0,
        status: 'confirmed',
        summary: a.summary ?? 'Busy',
        start: { dateTime: a.start },
        end: { dateTime: a.end },
      });
      return id;
    },
    channels: (email) => [...channels.values()].filter((c) => !email || c.email === email),
    async push(email, calendarId = 'primary') {
      const statuses: number[] = [];
      for (const ch of channels.values()) {
        if (ch.email !== email || ch.calendarId !== calendarId) continue;
        ch.messages += 1;
        const res = await fetch(ch.address, {
          method: 'POST',
          headers: notificationHeaders({
            channelId: ch.id,
            token: ch.token,
            resourceId: ch.resourceId,
            state: 'exists',
            messageNumber: ch.messages,
            expiration: ch.expiration,
          }),
        });
        statuses.push(res.status);
      }
      return statuses;
    },
    revoked: () => [...revoked],
    failNext(match, status, body) {
      failures.push({ match, status, body });
    },
    expireAccessTokens() {
      for (const grant of access.values()) grant.expiresAt = 0;
    },
    expireSyncTokens(email, calendarId) {
      const c = calendarOf(email, calendarId);
      c.oldestToken = c.seq + 1;
    },
    reset() {
      calendars.clear();
      codes.clear();
      access.clear();
      refresh.clear();
      revoked.length = 0;
      channels.clear();
      failures.length = 0;
      requests.length = 0;
    },
  };
  return fake;
}

const KEY = Symbol.for('@hykr/connectors/google-calendar/fake');

/** This process's fake Google: the server's transport in fake mode, and what tests inspect. */
export function fakeGoogle(): FakeGoogle {
  const g = globalThis as { [KEY]?: FakeGoogle };
  g[KEY] ??= createFakeGoogle();
  return g[KEY];
}
