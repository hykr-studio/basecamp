// A fake OAuth provider for end-to-end tests (decisions B21): an HTTP server on 127.0.0.1 that
// plays both a standard OAuth 2.0 provider (authorize, token, refresh, RFC 7009 revoke, a small
// API) and Meta's Graph API as the meta-leads connector uses it (the long-lived exchange,
// permissions, pages, page subscriptions, leads). It agrees at once at the consent screen, and a
// test can make it refuse, grant fewer scopes, refuse refreshes or stop taking a token. It counts
// every request. Point a connector at it with `env(prefix)` (and INTEGRATIONS_ALLOWED_HOSTS=127.0.0.1).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOAuthRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  authorization: string | null;
}

export interface FakePage {
  id: string;
  name: string;
}

export interface FakeLead {
  id: string;
  pageId: string;
  formId: string;
  adId?: string;
  createdTime: string;
  fields: { name: string; values: string[] }[];
}

export interface FakeOAuthProvider {
  /** http://127.0.0.1:<port> */
  base: string;
  /** Every request, in order. */
  requests: FakeOAuthRequest[];
  /** How many requests reached a path (and method). */
  count(path: string, method?: string): number;
  /**
   * The environment that points a connector (by its `clientFrom`) at this fake: its client and
   * its endpoints. `meta`: Meta's dialog, token and Graph URLs instead of the standard ones.
   */
  env(prefix: string, options?: { meta?: boolean }): Record<string, string>;
  /** The consent screen says no (`error=access_denied`). */
  deny: boolean;
  /** The scopes the consent screen grants; null: what was asked for. */
  grant: string[] | null;
  /** Leave `scope` out of token answers (as Meta does). */
  omitScope: boolean;
  /** Seconds an access token lasts. Default 3600. */
  expiresIn: number;
  /** Refreshes are refused with `invalid_grant`. */
  refuseRefresh: boolean;
  /** Stop taking a token (it answers 401, or Meta's error 190). */
  invalidate(token: string): void;
  /** Stop taking every token issued so far. */
  invalidateAll(): void;
  /** The account the standard API's /me names. */
  account: { id: string; name: string };
  /** The pages Meta's /me/accounts lists (each gets its own page token). */
  pages: FakePage[];
  /** The leads Graph answers, by id. */
  leads: Map<string, FakeLead>;
  /** Every token the fake has issued (to check none of them leaks). */
  issued(): string[];
  /** The scopes of the last code exchanged (what Meta's /me/permissions lists). */
  lastGrantedScopes?: string[];
  close(): Promise<void>;
}

const token = (kind: string) => `${kind}_${randomBytes(18).toString('base64url')}`;

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Start a fake provider on a free port. Close it after the tests. */
export async function fakeOAuthProvider(): Promise<FakeOAuthProvider> {
  const requests: FakeOAuthRequest[] = [];
  const codes = new Map<string, { challenge?: string; scopes: string[]; redirectUri: string }>();
  const valid = new Set<string>();
  const refreshTokens = new Map<string, string[]>();
  const pageTokens = new Map<string, string>();
  const all: string[] = [];
  const issue = (kind: string) => {
    const t = token(kind);
    valid.add(t);
    all.push(t);
    return t;
  };

  const fake: FakeOAuthProvider = {
    base: '',
    requests,
    count: (path, method) =>
      requests.filter((r) => r.path === path && (!method || r.method === method)).length,
    env: (prefix, options = {}) =>
      options.meta
        ? {
            [`${prefix}_ID`]: 'fake-meta-app',
            [`${prefix}_SECRET`]: 'fake-meta-app-secret',
            [`${prefix}_VERIFY_TOKEN`]: 'fake-verify-token',
            [`${prefix}_AUTHORIZE_URL`]: `${fake.base}/meta/dialog/oauth`,
            [`${prefix}_TOKEN_URL`]: `${fake.base}/meta/oauth/access_token`,
            [`${prefix}_API_URL`]: `${fake.base}/graph`,
          }
        : {
            [`${prefix}_ID`]: 'fake-client',
            [`${prefix}_SECRET`]: 'fake-client-secret',
            [`${prefix}_AUTHORIZE_URL`]: `${fake.base}/authorize`,
            [`${prefix}_TOKEN_URL`]: `${fake.base}/token`,
            [`${prefix}_REVOKE_URL`]: `${fake.base}/revoke`,
            [`${prefix}_API_URL`]: `${fake.base}/api`,
          },
    deny: false,
    grant: null,
    omitScope: false,
    expiresIn: 3600,
    refuseRefresh: false,
    invalidate: (t) => {
      valid.delete(t);
    },
    invalidateAll: () => valid.clear(),
    account: { id: 'acct-1', name: 'Fake account' },
    pages: [],
    leads: new Map(),
    issued: () => [...all],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const bearerOf = (r: FakeOAuthRequest) => r.authorization?.replace(/^Bearer /, '') ?? '';

  function tokens(scopes: string[], withRefresh: boolean) {
    const access = issue('at');
    const answer: Record<string, unknown> = {
      access_token: access,
      token_type: 'bearer',
      expires_in: fake.expiresIn,
      ...(fake.omitScope ? {} : { scope: scopes.join(' ') }),
    };
    if (withRefresh) {
      const refresh = issue('rt');
      refreshTokens.set(refresh, scopes);
      answer.refresh_token = refresh;
    }
    return answer;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const raw = await bodyOf(req);
    const r: FakeOAuthRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form: Object.fromEntries(new URLSearchParams(raw)),
      authorization: (req.headers.authorization as string | undefined) ?? null,
    };
    requests.push(r);
    const p = r.path;

    // The consent screen: agree (or not) at once, back to the redirect URI.
    if ((p === '/authorize' || p === '/meta/dialog/oauth') && r.method === 'GET') {
      const back = new URL(r.query.redirect_uri);
      if (fake.deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = token('code');
        const asked = (r.query.scope ?? '').split(/[\s,]+/).filter(Boolean);
        codes.set(code, {
          challenge: r.query.code_challenge,
          scopes: fake.grant ?? asked,
          redirectUri: r.query.redirect_uri,
        });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', r.query.state ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // The token endpoint: a code, a refresh, or (Meta) the long-lived exchange.
    if (p === '/token' || p === '/meta/oauth/access_token') {
      const meta = p.startsWith('/meta');
      if (r.method === 'GET' && r.query.grant_type === 'fb_exchange_token') {
        if (!valid.has(r.query.fb_exchange_token))
          return send(res, 400, { error: { code: 190, message: 'Invalid token' } });
        return send(res, 200, {
          access_token: issue('long'),
          token_type: 'bearer',
          expires_in: 5_184_000,
        });
      }
      const f = r.form;
      if (!f.client_id || !f.client_secret) return send(res, 401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        const grant = codes.get(f.code);
        codes.delete(f.code);
        if (!grant || grant.redirectUri !== f.redirect_uri)
          return send(res, 400, { error: 'invalid_grant' });
        if (grant.challenge) {
          const ok =
            createHash('sha256')
              .update(f.code_verifier ?? '')
              .digest('base64url') === grant.challenge;
          if (!ok) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        }
        fake.lastGrantedScopes = grant.scopes;
        return send(res, 200, tokens(grant.scopes, !meta));
      }
      if (f.grant_type === 'refresh_token') {
        const scopes = refreshTokens.get(f.refresh_token);
        if (fake.refuseRefresh || !scopes) return send(res, 400, { error: 'invalid_grant' });
        return send(res, 200, tokens(scopes, false));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p === '/revoke' && r.method === 'POST') {
      valid.delete(r.form.token);
      return send(res, 200, {});
    }

    // The standard API: who the token is for.
    if (p === '/api/me') {
      if (!valid.has(bearerOf(r))) return send(res, 401, { error: 'invalid_token' });
      return send(res, 200, fake.account);
    }

    // Meta's Graph API.
    if (p.startsWith('/graph/')) {
      const bearer = bearerOf(r);
      if (!valid.has(bearer))
        return send(res, 400, { error: { code: 190, message: 'Error validating access token' } });
      const rest = p.slice('/graph'.length);
      if (rest === '/me/permissions' && r.method === 'GET')
        return send(res, 200, {
          data: (fake.lastGrantedScopes ?? []).map((permission) => ({
            permission,
            status: 'granted',
          })),
        });
      if (rest === '/me/permissions' && r.method === 'DELETE') {
        valid.delete(bearer);
        return send(res, 200, { success: true });
      }
      if (rest === '/me/accounts')
        return send(res, 200, {
          data: fake.pages.map((page) => {
            const pt = pageTokens.get(page.id) ?? issue('page');
            valid.add(pt);
            pageTokens.set(page.id, pt);
            return { ...page, access_token: pt };
          }),
        });
      const sub = /^\/([^/]+)\/subscribed_apps$/.exec(rest);
      if (sub && r.method === 'POST') {
        if (pageTokens.get(sub[1]) !== bearer)
          return send(res, 400, { error: { code: 200, message: 'Needs the page token' } });
        return send(res, 200, { success: true });
      }
      const lead = /^\/([^/]+)$/.exec(rest);
      if (lead && r.method === 'GET') {
        const l = fake.leads.get(decodeURIComponent(lead[1]));
        if (!l) return send(res, 404, { error: { code: 100, message: 'No such lead' } });
        if (pageTokens.get(l.pageId) !== bearer)
          return send(res, 400, { error: { code: 200, message: 'Needs the page token' } });
        return send(res, 200, {
          id: l.id,
          created_time: l.createdTime,
          form_id: l.formId,
          ...(l.adId ? { ad_id: l.adId } : {}),
          field_data: l.fields,
        });
      }
    }
    send(res, 404, { error: 'not_found' });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: String(e) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
