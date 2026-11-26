// Connectors that sign in (B24): a business connects a service by signing in (start, the
// provider's consent, the anonymous callback, complete under the person's session), its tokens
// sealed, refreshed before they end, revoked when it is removed, and marked for signing in again
// (its managers told) when the provider stops taking them. A provider's one webhook URL routes
// each event to the connection holding the account it names, and meta-leads fetches each lead
// once. The fake provider stands in for the provider and for Meta; the fixture's features/oauth
// declares both connectors.
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOAuthSettings } from '../../dist/features/integrations/oauth/settings.js';
import { connectorRequest } from '../../dist/features/integrations/oauth/tokens.js';
import { DB } from '../../dist/infra/db.module.js';
import {
  addMember,
  asAssistant,
  boot,
  connectOAuth,
  eventually,
  type FakeOAuthProvider,
  fakeOAuthProvider,
  type Json,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { leads, oauthApp } from '../fixture/dist/features/oauth/index.js';

process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.INTEGRATIONS_ALLOWED_HOSTS = '127.0.0.1';

const ana = new Person('Ana Oauth'); // owner: integrations.manage
const ada = new Person('Ada Oauth'); // admin in Ana's business: integrations.manage
const sam = new Person('Sam Oauth'); // staff in Ana's business: neither
const ravi = new Person('Ravi Oauth'); // owner of another business; Ana is an admin there too
let anaTenant = '';
let raviTenant = '';
const inAna = () => ({ 'x-tenant-id': anaTenant });
const inRavi = () => ({ 'x-tenant-id': raviTenant });

let fake: FakeOAuthProvider;
const saved = { ...process.env };
// biome-ignore lint/suspicious/noExplicitAny: the API's database, from the booted app
let db: any;

/** What the console printed while the tests ran: no token may be in it. */
const printed: string[] = [];
const write = { out: process.stdout.write, err: process.stderr.write };

/** The provider's account for the next sign-in: each sign-in its own unless a test says. */
const freshAccount = (name = 'Studio account') => {
  fake.account = { id: `acct-${randomUUID().slice(0, 8)}`, name };
  return fake.account;
};

/** Start, consent and callback by hand: the code and state the app is sent back with. */
async function signIn(person: Person, connector: string, headers: Record<string, string>) {
  const start = await person.call(
    'POST',
    '/api/integrations/connections/oauth/start',
    { connector },
    headers,
  );
  expect(start.status).toBe(200);
  const consent = await fetch(start.body.url, { redirect: 'manual' });
  const back = await fetch(consent.headers.get('location') ?? '', { redirect: 'manual' });
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.get('location') ?? '');
  return {
    landing,
    code: landing.searchParams.get('code') ?? '',
    state: landing.searchParams.get('state') ?? '',
  };
}

const complete = (person: Person, body: object, headers: Record<string, string>) =>
  person.call('POST', '/api/integrations/connections/oauth/complete', body, headers);

const connectionRow = async (id: string) =>
  (await pool.query('select * from app.integration_connections where id = $1', [id])).rows[0];

const refreshes = () =>
  fake.requests.filter((r) => r.path === '/token' && r.form.grant_type === 'refresh_token').length;

beforeAll(async () => {
  for (const s of ['out', 'err'] as const) {
    const original = write[s];
    // biome-ignore lint/suspicious/noExplicitAny: a pass-through spy
    (process[s === 'out' ? 'stdout' : 'stderr'] as any).write = (chunk: any, ...rest: any[]) => {
      printed.push(String(chunk));
      return original.call(process[s === 'out' ? 'stdout' : 'stderr'], chunk, ...rest);
    };
  }
  fake = await fakeOAuthProvider();
  Object.assign(process.env, fake.env('FIXTURE_OAUTH'), fake.env('META_APP', { meta: true }));
  await boot(oauthApp);
  process.env.INTEGRATIONS_OAUTH_REDIRECT_URL = `${server.base}/api/integrations/oauth/callback`;
  db = server.app?.get(DB);
  for (const p of [ana, ada, sam, ravi]) await p.signUp();
  anaTenant = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  await addMember(ada, anaTenant, ['admin']);
  await addMember(sam, anaTenant, ['staff']);
  await addMember(ana, raviTenant, ['admin']);
});

afterAll(async () => {
  process.stdout.write = write.out;
  process.stderr.write = write.err;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  await shutdown();
  await fake.close();
});

describe('the declaration', () => {
  it('boots with the connectors offered, and refuses endpoints off their hosts', async () => {
    const list = await ana.call('GET', '/api/integrations/connectors', undefined, inAna());
    const byName = Object.fromEntries(list.body.map((c: Json) => [c.name, c]));
    expect(byName['fixture-oauth'].oauth).toEqual({
      scopes: ['read', 'write'],
      available: true,
      pick: false,
    });
    expect(byName['meta-leads']).toMatchObject({
      oauth: { pick: true, available: true },
      sharedInbound: '/webhooks/meta-leads',
    });
    expect(() =>
      checkOAuthSettings({
        ...process.env,
        FIXTURE_OAUTH_TOKEN_URL: 'https://elsewhere.example/token',
      }),
    ).toThrow('not on a listed host');
    expect(() =>
      checkOAuthSettings({
        ...process.env,
        FIXTURE_OAUTH_TOKEN_URL: 'http://oauth.fixture.example/t',
      }),
    ).toThrow('not https');
    expect(() => checkOAuthSettings()).not.toThrow();
  });

  it('takes no pasted credentials for a connector that signs in', async () => {
    const res = await ana.call(
      'POST',
      '/api/integrations/connections',
      { connector: 'fixture-oauth', credentials: { accessToken: 'pasted' } },
      inAna(),
    );
    expect(res.status).toBe(400);
    expect(res.body.rule).toBe('oauth_connector');
  });
});

describe('signing in', () => {
  let connectionId = '';

  it('start, callback and complete connect the business, sealed and audited', async () => {
    const account = freshAccount('Ana Studio');
    const out = await connectOAuth(ana, 'fixture-oauth', inAna());
    expect(out.status).toBe(201);
    expect(out.landing.pathname).toBe('/integrations');
    const value = out.body.value;
    connectionId = value.id;
    expect(value).toMatchObject({
      connector: 'fixture-oauth',
      auth: 'oauth',
      status: 'active',
      scopes: ['read', 'write'],
      public: { account: 'Ana Studio' },
      accounts: [{ id: account.id, name: 'Ana Studio', held: true }],
    });
    expect(value.credentials).toBeUndefined();
    // PKCE went with the code.
    const exchange = fake.requests.find(
      (r) => r.path === '/token' && r.form.grant_type === 'authorization_code',
    );
    expect(exchange?.form.code_verifier).toBeTruthy();
    const row = await connectionRow(connectionId);
    expect(row.credentials_sealed.startsWith('v1.')).toBe(true);
    const audit = await pool.query(
      `select action, actor_id, after from audit.events where resource_id = $1 order by at`,
      [connectionId],
    );
    expect(audit.rows.map((r) => r.action)).toContain('integrations.connection.oauth_connect');
    expect(audit.rows[0].actor_id).toBe(ana.id);
    const events = await pool.query(
      `select row from app.domain_events where name = 'connection.oauth_connected' and resource_id = $1`,
      [connectionId],
    );
    expect(events.rows[0].row).toMatchObject({
      connector: 'fixture-oauth',
      userId: ana.id,
      scopes: ['read', 'write'],
      public: { account: 'Ana Studio' },
    });
  });

  it('a state works once: a retry with its key is the same answer, without it a refusal', async () => {
    freshAccount();
    const { code, state } = await signIn(ana, 'fixture-oauth', inAna());
    const key = { ...inAna(), 'idempotency-key': `oauth-${randomUUID()}` };
    const first = await complete(ana, { code, state }, key);
    expect(first.status).toBe(201);
    const again = await complete(ana, { code, state }, key);
    expect(again.body.value.id).toBe(first.body.value.id);
    const bare = await complete(ana, { code, state }, inAna());
    expect(bare.status).toBe(400);
    expect(bare.body.rule).toBe('oauth_sign_in_invalid');
    const { rows } = await pool.query(
      `select count(*)::int as n from app.integration_accounts where account_id = $1`,
      [fake.account.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('only the person who started, in that business, finishes it', async () => {
    freshAccount();
    const one = await signIn(ana, 'fixture-oauth', inAna());
    const byAda = await complete(ada, { code: one.code, state: one.state }, inAna());
    expect(byAda.status).toBe(403);
    expect(byAda.body.rule).toBe('oauth_not_yours');
    // The state is used up by the refused try: not even Ana can finish it now.
    expect((await complete(ana, { code: one.code, state: one.state }, inAna())).status).toBe(400);

    const two = await signIn(ana, 'fixture-oauth', inAna());
    const elsewhere = await complete(ana, { code: two.code, state: two.state }, inRavi());
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.rule).toBe('oauth_other_business');
  });

  it('only people who manage integrations start one, and never the assistant', async () => {
    const bySam = await sam.call(
      'POST',
      '/api/integrations/connections/oauth/start',
      { connector: 'fixture-oauth' },
      inAna(),
    );
    expect(bySam.status).toBe(403);
    expect(bySam.body.rule).toBe('integrations_manage_needed');
    const byAssistant = await asAssistant(`user:${ana.id}`, inAna())(
      'POST',
      '/api/integrations/connections/oauth/start',
      { connector: 'fixture-oauth' },
    );
    expect(byAssistant.status).toBe(403);
  });

  it('fewer scopes than declared is refused with their names', async () => {
    freshAccount();
    fake.grant = ['read'];
    try {
      const out = await connectOAuth(ana, 'fixture-oauth', inAna());
      expect(out.status).toBe(400);
      expect(out.body).toMatchObject({ rule: 'oauth_scopes_missing', missing: ['write'] });
    } finally {
      fake.grant = null;
    }
  });

  it('saying no at the provider lands with oauth_refused', async () => {
    fake.deny = true;
    try {
      const out = await connectOAuth(ana, 'fixture-oauth', inAna());
      expect(out.landing.searchParams.get('error')).toBe('oauth_refused');
      expect(out.code).toBe('');
    } finally {
      fake.deny = false;
    }
  });
});

describe('using and keeping the tokens', () => {
  let id = '';
  const call = (init: object = { url: '/me' }) =>
    connectorRequest(db, { tenantId: anaTenant, connectionId: id }, init);

  beforeAll(async () => {
    freshAccount('Refresh account');
    fake.expiresIn = 30;
    const out = await connectOAuth(ana, 'fixture-oauth', inAna());
    fake.expiresIn = 3600;
    id = out.body.value.id;
  });

  it('a token within 60 seconds of its end is refreshed before the call, and sealed again', async () => {
    const before = (await connectionRow(id)).credentials_sealed;
    const n = refreshes();
    const res = await call();
    expect(res.status).toBe(200);
    expect(refreshes()).toBe(n + 1);
    const row = await connectionRow(id);
    expect(row.credentials_sealed).not.toBe(before);
    expect(row.token_expires_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    // Good for an hour now: the next call does not refresh.
    await call();
    expect(refreshes()).toBe(n + 1);
  });

  it('a token the provider stops taking is refreshed once and the call tried again', async () => {
    fake.invalidateAll();
    const n = refreshes();
    expect((await call()).status).toBe(200);
    expect(refreshes()).toBe(n + 1);
  });

  it('calls go through the egress guard, to the connector’s hosts only', async () => {
    await expect(call({ url: 'https://elsewhere.example/steal' })).rejects.toMatchObject({
      name: 'EgressBlocked',
    });
  });

  it('a refresh refused with invalid_grant marks needs_reauth and tells its managers', async () => {
    fake.refuseRefresh = true;
    fake.invalidateAll();
    try {
      await expect(call()).rejects.toMatchObject({
        response: { rule: 'connection_needs_reauth' },
      });
    } finally {
      fake.refuseRefresh = false;
    }
    const row = await connectionRow(id);
    expect(row.status).toBe('needs_reauth');
    const audit = await pool.query(
      `select actor_kind from audit.events where resource_id = $1 and action = 'integrations.connection.needs_reauth'`,
      [id],
    );
    expect(audit.rows).toEqual([{ actor_kind: 'system' }]);
    // Its managers (owner and admin) find it in their inbox; staff do not.
    const inbox = (p: Person) => p.call('GET', '/api/inbox', undefined, inAna());
    const titled = (body: Json) =>
      (body.items ?? []).filter((i: Json) => String(i.title).includes('needs signing in again'));
    await eventually(async () => (titled((await inbox(ada)).body).length ? true : undefined));
    expect(titled((await inbox(ana)).body)).toHaveLength(1);
    expect(titled((await inbox(sam)).body)).toHaveLength(0);
    // Its calls stop until it is signed in again; it cannot just be switched back on.
    await expect(call()).rejects.toMatchObject({ response: { rule: 'connection_needs_reauth' } });
    const on = await ana.call(
      'PATCH',
      `/api/integrations/connections/${id}`,
      { status: 'active' },
      inAna(),
    );
    expect(on.status).toBe(403);
    expect(on.body.rule).toBe('oauth_sign_in_needed');
  });

  it('signing in again brings it back, the same connection', async () => {
    const again = await connectOAuth(ana, 'fixture-oauth', inAna(), { connectionId: id });
    expect(again.status).toBe(201);
    expect(again.body.value).toMatchObject({ id, status: 'active', lastError: null });
    expect((await call()).status).toBe(200);
  });

  it('disconnect revokes at the provider once and deletes the tokens', async () => {
    const revokes = fake.count('/revoke');
    const key = { ...inAna(), 'idempotency-key': `del-${randomUUID()}` };
    const gone = await ana.call('DELETE', `/api/integrations/connections/${id}`, undefined, key);
    expect(gone.status).toBe(200);
    await ana.call('DELETE', `/api/integrations/connections/${id}`, undefined, key);
    expect(fake.count('/revoke')).toBe(revokes + 1);
    expect(await connectionRow(id)).toBeUndefined();
    const { rows } = await pool.query(
      'select count(*)::int as n from app.integration_accounts where connection_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('one webhook URL for the provider: meta-leads', () => {
  // Pages and leads are this run's own: the database outlives a run.
  const run = randomUUID().slice(0, 8);
  const A = `page-A-${run}`;
  const B = `page-B-${run}`;
  const C = `page-C-${run}`;
  const Z = `page-Z-${run}`;
  const L1 = `lead-1-${run}`;
  let anaLeads = '';
  const body = (pageId: string, leadId: string) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 1,
        changes: [
          {
            field: 'leadgen',
            value: { leadgen_id: leadId, page_id: pageId, form_id: 'form-1', created_time: 1 },
          },
        ],
      },
    ],
  });
  const post = (payload: object, secret = 'fake-meta-app-secret') => {
    const raw = JSON.stringify(payload);
    return fetch(`${server.base}/webhooks/meta-leads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
  };

  it('signs in, offers the pages, and subscribes the ones picked', async () => {
    fake.pages = [
      { id: A, name: 'Studio A' },
      { id: B, name: 'Studio B' },
    ];
    const out = await connectOAuth(ana, 'meta-leads', inAna());
    expect(out.status).toBe(201);
    anaLeads = out.body.value.id;
    expect(out.body.value).toMatchObject({
      scopes: expect.arrayContaining([
        'leads_retrieval',
        'pages_show_list',
        'pages_manage_metadata',
      ]),
      inboundPath: '/webhooks/meta-leads',
      accounts: [
        { id: A, name: 'Studio A', held: false },
        { id: B, name: 'Studio B', held: false },
      ],
    });
    // The short-lived token was swapped for a long-lived one.
    expect(fake.requests.some((r) => r.query.grant_type === 'fb_exchange_token')).toBe(true);
    const picked = await ana.call(
      'POST',
      `/api/integrations/connections/${anaLeads}/oauth/pick`,
      { accountIds: [A] },
      inAna(),
    );
    expect(picked.status).toBe(200);
    expect(picked.body.subscribed).toEqual([{ id: A, ok: true }]);
    expect(fake.count(`/graph/${A}/subscribed_apps`, 'POST')).toBe(1);
    expect(picked.body.value.accounts).toEqual([
      { id: A, name: 'Studio A', held: true },
      { id: B, name: 'Studio B', held: false },
    ]);
  });

  it('a page another business holds is refused account_connected_elsewhere', async () => {
    fake.pages = [
      { id: A, name: 'Studio A' },
      { id: C, name: 'Ravi C' },
    ];
    const out = await connectOAuth(ravi, 'meta-leads', inRavi());
    const id = out.body.value.id;
    const taken = await ravi.call(
      'POST',
      `/api/integrations/connections/${id}/oauth/pick`,
      { accountIds: [A] },
      inRavi(),
    );
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ rule: 'account_connected_elsewhere', accounts: [A] });
    const own = await ravi.call(
      'POST',
      `/api/integrations/connections/${id}/oauth/pick`,
      { accountIds: [C] },
      inRavi(),
    );
    expect(own.status).toBe(200);
  });

  it('a lead for page A reaches only the connection holding page A, fetched once', async () => {
    fake.leads.set(L1, {
      id: L1,
      pageId: A,
      formId: 'form-1',
      adId: 'ad-9',
      createdTime: '2026-11-18T10:00:00+0000',
      fields: [
        { name: 'full_name', values: ['Asha Rao'] },
        { name: 'phone_number', values: ['+919800000001'] },
      ],
    });
    const payload = body(A, L1);
    expect((await post(payload)).status).toBe(200);
    await eventually(() => (leads.length ? true : undefined));
    expect(leads).toEqual([
      {
        connectionId: anaLeads,
        tenantId: anaTenant,
        lead: {
          leadId: L1,
          pageId: A,
          form: 'form-1',
          ad: 'ad-9',
          fields: [
            { name: 'full_name', values: ['Asha Rao'] },
            { name: 'phone_number', values: ['+919800000001'] },
          ],
          createdAt: '2026-11-18T10:00:00.000Z',
        },
      },
    ]);
    // Redelivered: stored once, fetched once, handled once.
    expect((await post(payload)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.count(`/graph/${L1}`, 'GET')).toBe(1);
    expect(leads).toHaveLength(1);
    const { rows } = await pool.query(
      `select tenant_id, type, status from app.integration_inbound
       where connector = 'meta-leads' and external_id = $1`,
      [L1],
    );
    expect(rows).toEqual([{ tenant_id: anaTenant, type: 'lead', status: 'processed' }]);
  });

  it('an event for a page nobody holds is kept unrouted, without its content', async () => {
    expect((await post(body(Z, `lead-z-${run}`))).status).toBe(200);
    const unrouted = await pool.query(
      `select account_id, type from app.integration_unrouted where external_id = $1`,
      [`lead-z-${run}`],
    );
    expect(unrouted.rows).toEqual([{ account_id: Z, type: 'leadgen' }]);
    const inbound = await pool.query(
      `select count(*)::int as n from app.integration_inbound where external_id = $1`,
      [`lead-z-${run}`],
    );
    expect(inbound.rows[0].n).toBe(0);
    // Offered but not picked is not held either.
    await post(body(B, `lead-b-${run}`));
    const b = await pool.query(
      `select count(*)::int as n from app.integration_unrouted where external_id = $1`,
      [`lead-b-${run}`],
    );
    expect(b.rows[0].n).toBe(1);
  });

  it('is verified with the app secret, and answers Meta’s subscription check', async () => {
    expect((await post(body(A, 'lead-2'), 'not-the-secret')).status).toBe(401);
    const check = (token: string) =>
      fetch(
        `${server.base}/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=4242`,
      );
    const ok = await check('fake-verify-token');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('4242');
    expect((await check('wrong')).status).toBe(403);
    // A name that is not a shared connector is not ours to answer.
    expect((await fetch(`${server.base}/webhooks/no-such`, { method: 'POST' })).status).toBe(404);
  });
});

describe('what never shows a token', () => {
  it('answers, audit, events, stored rows and the log', async () => {
    const tokens = fake.issued();
    expect(tokens.length).toBeGreaterThan(5);
    const seen: string[] = [];
    for (const [who, headers] of [
      [ana, inAna()],
      [ravi, inRavi()],
    ] as const) {
      seen.push(
        JSON.stringify(
          (await who.call('GET', '/api/integrations/connections', undefined, headers)).body,
        ),
      );
    }
    const tables = [
      `select row_to_json(e)::text as t from audit.events e where tenant_id = any($1)`,
      `select row_to_json(e)::text as t from app.domain_events e where tenant_id = any($1)`,
      `select row_to_json(o)::text as t from app.outbox o where tenant_id = any($1)`,
      `select row_to_json(i)::text as t from app.integration_inbound i where tenant_id = any($1)`,
      `select row_to_json(c)::text as t from app.integration_connections c where tenant_id = any($1)`,
      `select row_to_json(a)::text as t from app.integration_accounts a where tenant_id = any($1)`,
      `select row_to_json(k)::text as t from app.idempotency k`,
    ];
    for (const q of tables)
      for (const r of (
        await pool.query(
          q.replace('$1', `array[$1, $2]`),
          q.includes('$1') ? [anaTenant, raviTenant] : [],
        )
      ).rows)
        seen.push(r.t);
    seen.push(printed.join(''));
    const all = seen.join('\n');
    for (const t of tokens) expect(all.includes(t), `token ${t.slice(0, 6)}… leaked`).toBe(false);
  });
});
