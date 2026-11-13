// Better Auth's routes (`/api/auth/*`) answer before any Nest guard (V9). The API's channel rules
// hold there too: a session names only its own channels, and the read-only `webmcp` channel
// reaches nothing. No credential but the session cookie reaches them (an MCP token, the agent
// key, a run's headers). The session cookie is never sent from another site, so a verified
// business domain trusted for CORS reads nobody else's data. Better Auth's own rate limits follow
// THROTTLE, counted in Redis (the last test: it limits sign-ins for a while).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetDomains } from '../../dist/features/settings/domains.js';
import {
  boot,
  connectMcp,
  type Json,
  MCP_TEST_REDIRECT,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { mcpServer } from '../fixture/dist/features/mcp/index.js';

const ana = new Person('Ana Auth');
const bo = new Person('Bo Auth');
const PASSWORD = 'password123';

beforeAll(async () => {
  await boot(mcpServer);
  for (const p of [ana, bo]) await p.signUp();
});

afterAll(async () => {
  await shutdown();
});

const nameOf = async (p: Person) =>
  (await pool.query('select name from public."user" where id = $1', [p.id])).rows[0]?.name;

/** A request to authorize a new client, as the consent screen gets it: its signed query. */
async function signedConsentQuery(person: Person, scope = 'tasks:read') {
  const client = (await (
    await fetch(`${server.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Auth routes',
        redirect_uris: [MCP_TEST_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
  ).json()) as Json;
  const resource = (
    (await (await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`)).json()) as Json
  ).resource;
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: MCP_TEST_REDIRECT,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope,
    state: 's',
    resource,
  });
  const asked = await person.call('GET', `/api/auth/oauth2/authorize?${query}`, undefined, {
    accept: 'application/json',
  });
  const url = new URL(asked.body.url);
  expect(url.pathname).toBe('/oauth/consent');
  return { clientId: client.client_id as string, query, oauthQuery: url.search.slice(1) };
}

/** Better Auth's routes that change an account or grant something, with a body each takes. */
const changes = (oauthQuery: string): [string, Record<string, unknown>][] => [
  ['/api/auth/update-user', { name: 'Hijacked' }],
  ['/api/auth/change-email', { newEmail: `hijacked-${stamp}@test.local` }],
  ['/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'hijacked123' }],
  ['/api/auth/revoke-sessions', {}],
  ['/api/auth/delete-user', {}],
  ['/api/auth/oauth2/consent', { accept: true, scope: 'tasks:read', oauth_query: oauthQuery }],
];

const consents = async (clientId: string) =>
  (await pool.query('select 1 from oauth_consent where client_id = $1', [clientId])).rows.length;

describe('channels on Better Auth’s routes', () => {
  it('refuses a channel a session may not name, as every other route does', async () => {
    const elsewhere = await ana.call(
      'POST',
      '/api/tasks',
      { title: 'x' },
      { 'x-channel': 'share' },
    );
    const here = await ana.call(
      'POST',
      '/api/auth/update-user',
      { name: 'Renamed by WhatsApp' },
      { 'x-channel': 'whatsapp' },
    );
    expect(here.status).toBe(400);
    expect(here.body).toEqual({
      error: 'bad_channel',
      reason: 'A signed-in caller cannot name the channel "whatsapp"',
    });
    expect(elsewhere).toMatchObject({ status: 400, body: { error: 'bad_channel' } });
    expect(await nameOf(ana)).toBe('Ana Auth');
  });

  it('lets the webmcp channel change, grant or sign in nothing, GET included', async () => {
    const { clientId, query, oauthQuery } = await signedConsentQuery(ana);
    const webmcp = { 'x-channel': 'webmcp' };
    for (const [path, body] of changes(oauthQuery)) {
      const res = await ana.call('POST', path, body, webmcp);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toEqual({
        error: 'forbidden',
        rule: 'read_only_channel',
        reason: 'Calls on the webmcp channel can only read',
      });
    }
    // A GET to authorize hands out a code under a remembered consent; and signing out.
    for (const [method, path] of [
      ['GET', `/api/auth/oauth2/authorize?${query}`],
      ['GET', '/api/auth/get-session'],
      ['POST', '/api/auth/sign-out'],
    ]) {
      const res = await ana.call(method, path, method === 'POST' ? {} : undefined, webmcp);
      expect(res.body?.rule, path).toBe('read_only_channel');
    }
    expect(await nameOf(ana)).toBe('Ana Auth');
    expect(await consents(clientId)).toBe(0);
    expect((await ana.call('GET', '/api/me')).status).toBe(200);
    // The same person, without the header, may.
    expect((await ana.call('POST', '/api/auth/update-user', { name: 'Ana Auth' })).status).toBe(
      200,
    );
  });
});

describe('credentials on Better Auth’s routes', () => {
  it('takes no credential but the session cookie: a token, the agent key or a run’s headers', async () => {
    const { clientId, oauthQuery } = await signedConsentQuery(ana);
    const token = (await connectMcp(ana, 'tasks:write')).accessToken;
    const credentials: Record<string, Record<string, string>> = {
      'an MCP token': { authorization: `Bearer ${token}` },
      'the agent key': {
        'x-agent-key': process.env.AGENT_API_KEY ?? '',
        'x-agent-id': 'assistant',
        'x-acting-for': `user:${ana.id}`,
        'x-run-id': `r${stamp}`,
      },
      'a run’s headers': { 'x-agent-run': `run-${stamp}`, 'x-run-id': `r${stamp}` },
    };
    for (const [who, headers] of Object.entries(credentials)) {
      for (const [path, body] of changes(oauthQuery)) {
        const res = await fetch(`${server.base}${path}`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        expect(res.status, `${who} ${path}`).toBe(401);
      }
      const info = await fetch(`${server.base}/api/auth/oauth2/userinfo`, { headers });
      expect(info.status, `${who} userinfo`).toBeGreaterThanOrEqual(400);
      expect(await info.text(), `${who} userinfo`).not.toContain(ana.email);
    }
    expect(await nameOf(ana)).toBe('Ana Auth');
    expect(await consents(clientId)).toBe(0);
    const again = new Person('Ana Auth', ana.email);
    expect(
      (
        await again.call('POST', '/api/auth/sign-in/email', {
          email: ana.email,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
  });
});

describe('a verified business domain', () => {
  const domain = `https://v9-${stamp}.example.com`;

  it('is trusted for CORS, but the session cookie never leaves its own site', async () => {
    const signedIn = await fetch(`${server.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: bo.email, password: PASSWORD }),
    });
    const cookie = signedIn.headers.getSetCookie().find((c) => c.includes('session_token='));
    // HttpOnly, and SameSite=Lax: a browser sends it on no fetch from another site, whatever
    // CORS allows. A change to SameSite=None would let a verified domain read anyone's data.
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    const tenantId = (await me(ana)).tenantId;
    await pool.query(
      `insert into app.tenant_domains (tenant_id, origin, token, verified_at, created_by)
       values ($1, $2, 'token', now(), $3)`,
      [tenantId, domain, ana.id],
    );
    forgetDomains();
    // Ana's domain is trusted for CORS with credentials, for anyone's request (by design: A11).
    const res = await fetch(`${server.base}/api/tasks`, {
      headers: { origin: domain, cookie: bo.cookie },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(domain);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    // A sign-in's callbackURL on that domain is trusted only on a request from it (the plugin's
    // trustedOrigins, settings.e2e); Better Auth skips that check under test, so not here.
  });
});

describe('Better Auth’s own rate limits', () => {
  const wrong = () =>
    fetch(`${server.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: bo.email, password: 'not-the-password' }),
    });

  it('limit failed sign-ins while THROTTLE is on, and never while it is off', async () => {
    const off: number[] = [];
    for (let i = 0; i < 5; i++) off.push((await wrong()).status);
    expect(off).toEqual([401, 401, 401, 401, 401]);
    process.env.THROTTLE = 'on';
    try {
      const on: number[] = [];
      for (let i = 0; i < 5; i++) on.push((await wrong()).status);
      // Three a 10 s window per address and route (Better Auth's rule for sign-in).
      expect(on).toEqual([401, 401, 401, 429, 429]);
    } finally {
      process.env.THROTTLE = 'off';
    }
    expect((await wrong()).status).toBe(401);
  });
});
