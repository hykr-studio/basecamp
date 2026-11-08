// Credits and caps (A3): every turn's tokens and tool calls, every WhatsApp message sent, every
// voice second and every embedding (memory recall and indexing, S4) metered and priced
// (CREDITS_CONFIG); the operator's plan, override and grants; the 80% alert and the 100% pause;
// the prepaid wallet with its ledger and purchases through a provider; and who may see and do
// what. H3: the guardrail is metered, an agent's calls stop mid-run at 100% (the run ends with
// the paused sentence), and a purchase is settled by its gateway's signed webhook, for that
// connection's business only.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { agentRunToken, pausedText, reportModelUsage } from '@hykr/agents';
import { TenantConfigService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditsService } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  makeOperator,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import {
  APPROVAL_FROM,
  CHECKOUT_FROM,
  creditsApp,
  GATEWAY,
  started,
} from '../fixture/dist/features/credits/index.js';

// Connections keep their credentials sealed with it; set before the app reads its configuration.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';

const PRICES = {
  tool_calls: 100,
  tokens: 10_000,
  messages: 5,
  'messages.marketing': 7,
  voice_seconds: 60,
};

const ana = new Person('Ana Credits'); // metered by default
const lee = new Person('Lee Credits'); // on credits: the alert, the pause, the wallet
const sam = new Person('Sam Credits'); // staff in Lee's business
const mia = new Person('Mia Credits'); // limits
const ravi = new Person('Ravi Credits'); // another business; overrides
const opal = new Person('Opal Credits'); // a platform operator holding platform.credits
const otto = new Person('Otto Credits'); // an operator without it
const tenant: Record<string, string> = {};
let opalId = '';

const ENV = ['CREDITS_CONFIG', 'WA_GRAPH_URL', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN'];
const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

/** A stand-in for the Cloud API: records what is sent. */
type Sent = { to: string; type?: string; text?: { body: string }; template?: { name: string } };
const sent: Sent[] = [];
let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-credits-${Date.now()}`;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push(JSON.parse(data));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id: `wamid.cr.${Date.now()}.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  process.env.WA_VERIFY_TOKEN = 'test-verify';
  process.env.CREDITS_CONFIG = JSON.stringify({ currency: 'XXX', prices: PRICES });
  await boot(creditsApp);
  for (const person of [ana, lee, sam, mia, ravi]) {
    await person.signUp();
    tenant[person.name] = (await me(person)).tenantId;
  }
  for (const person of [opal, otto]) await person.signUp();
  opalId = await makeOperator(opal, ['platform.credits']);
  await makeOperator(otto, ['platform.usage']);
  await addMember(sam, tenant[lee.name], ['staff']);
  await sam.call('GET', '/api/me', undefined, { 'x-tenant-id': tenant[lee.name] });
});

afterAll(async () => {
  for (const n of ENV)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  stub?.close();
  await shutdown();
});

/** A platform operator's call (B19): Opal holds `platform.credits`. */
const operator = (method: string, path: string, body?: unknown, who: Person = opal) =>
  who.call(method, `/api/credits/operator${path}`, body);

const setPlan = (person: Person, plan: object) =>
  operator('PUT', `/${tenant[person.name]}/settings`, plan);

const inLee = (person: Person) => (method: string, path: string, body?: unknown) =>
  person.call(method, path, body, { 'x-tenant-id': tenant[lee.name] });

async function uses(person: Person) {
  const { rows } = await pool.query(
    `select meter, variant, quantity::int, cost::int, source, ref, subject from app.usage_events
     where tenant_id = $1 order by at, id`,
    [tenant[person.name]],
  );
  return rows;
}

async function ledgerOf(person: Person) {
  const { rows } = await pool.query(
    `select kind, amount::int, balance_after::int as balance from app.credit_ledger
     where tenant_id = $1 order by at, id`,
    [tenant[person.name]],
  );
  return rows;
}

async function alertsOf(person: Person) {
  const { rows } = await pool.query(
    `select cap, level from app.credit_alerts where tenant_id = $1 order by cap, level`,
    [tenant[person.name]],
  );
  return rows.map((r) => `${r.cap}/${r.level}`);
}

async function messagesSaved(person: Person) {
  const { rows } = await pool.query(
    `select count(*)::int as n from app.thread_messages m join app.threads t on t.id = m.thread_id
     where t.tenant_id = $1`,
    [tenant[person.name]],
  );
  return rows[0].n as number;
}

/** Mailpit's messages to one address. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { Subject: string }[] }).messages;
}

let seq = 0;
const addTask = (person: Person) => person.chat(`add credits task ${seq++}`);

describe('metering, by default', () => {
  it('prices a turn’s tokens, its recall’s embedding and its tool calls; nothing is capped', async () => {
    const res = await addTask(ana);
    expect(res.status).toBe(200);
    const all = await uses(ana);
    expect(all).toHaveLength(3);
    const tokens = all.find((u) => u.meter === 'tokens');
    const tools = all.find((u) => u.meter === 'tool_calls');
    // The turn's recall embedded the message: a word a token with the fake embedding, unpriced.
    expect(all.find((u) => u.meter === 'embedding_tokens')).toEqual({
      meter: 'embedding_tokens',
      variant: 'fake/embedding',
      quantity: 4,
      cost: 0,
      source: 'memory.recall',
      // Once per run (H3).
      ref: `memory.recall:${res.body.runId}`,
      subject: `user:${ana.id}`,
    });
    expect(tokens).toMatchObject({ meter: 'tokens', variant: 'fake/scripted', source: 'turn' });
    expect(tokens.quantity).toBeGreaterThan(100);
    expect(tokens.cost).toBe(Math.ceil((tokens.quantity * PRICES.tokens) / 1_000_000));
    expect(tools).toMatchObject({ meter: 'tool_calls', quantity: 1, cost: 100 });
    expect(tokens.subject).toBe(`user:${ana.id}`);
    expect(await ledgerOf(ana)).toEqual([]);

    const status = (await ana.call('GET', '/api/credits')).body;
    expect(status).toMatchObject({
      enforced: false,
      paused: null,
      usedPercent: null,
      alertAt: 80,
      pauseAt: 100,
      currency: 'XXX',
      spent: tokens.cost + 100,
    });
    expect(status.meters.find((m: { meter: string }) => m.meter === 'tool_calls')).toMatchObject({
      quantity: 1,
      cost: 100,
      paused: false,
    });
    expect(status.period.unit).toBe('month');
  });

  it('usage by meter and day, for the people who manage the credits', async () => {
    const usage = (await ana.call('GET', '/api/credits/usage')).body;
    const day = new Date().toISOString().slice(0, 10);
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ meter: 'tool_calls', quantity: 1, cost: 100 }),
        expect.objectContaining({ meter: 'tokens' }),
      ]),
    );
    expect(
      usage.every((u: { day: string }) => Math.abs(Date.parse(u.day) - Date.parse(day)) <= 864e5),
    ).toBe(true);
    expect((await ana.call('GET', '/api/credits/usage?from=nope')).status).toBe(400);
  });

  it('settings that do not parse: the status is 503, and voice is refused', async () => {
    const tenantId = tenant[ana.name];
    await pool.query(
      `update app.tenants set settings = jsonb_set(settings, '{credits}', '{"allowance": -1}') where id = $1`,
      [tenantId],
    );
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    const config = server.app?.get(TenantConfigService) as TenantConfigService;
    config.invalidate(tenantId);
    try {
      const res = await ana.call('GET', '/api/credits');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('credits_unavailable');
      expect(await credits.check({ tenantId, meter: 'voice_seconds' })).toMatchObject({
        rule: 'credits_unavailable',
      });
      // What is never paused still goes: a utility message, a reply.
      expect(await credits.check({ tenantId, meter: 'messages', variant: 'utility' })).toBeNull();
      expect(await credits.check({ tenantId, meter: 'messages' })).toBeNull();
      // A bad purchase body is a 400, before anything runs.
      expect((await ana.call('POST', '/api/credits/purchases', { amount: -5 })).status).toBe(400);
    } finally {
      await pool.query(`update app.tenants set settings = settings - 'credits' where id = $1`, [
        tenantId,
      ]);
      config.invalidate(tenantId);
    }
  });

  it('a turn without a tool counts its tokens and its recall’s embedding only', async () => {
    const before = (await uses(ana)).length;
    expect((await ana.chat('hello')).status).toBe(200);
    const added = (await uses(ana)).slice(before);
    expect(added.map((u) => u.meter)).toEqual(['embedding_tokens', 'tokens']);
  });

  it('the guardrail’s model calls are metered for the turn’s business', async () => {
    await reportModelUsage({
      tenantId: tenant[ana.name],
      model: 'fake/scripted',
      source: 'guardrail',
      inputTokens: 300,
      outputTokens: 20,
      subject: `user:${ana.id}`,
      runId: 'guard-run-1',
      channel: 'app',
    });
    const guarded = (await uses(ana)).filter((u) => u.source === 'guardrail');
    expect(guarded).toEqual([
      expect.objectContaining({
        meter: 'tokens',
        variant: 'fake/scripted',
        quantity: 320,
        cost: Math.ceil((320 * PRICES.tokens) / 1_000_000),
        subject: `user:${ana.id}`,
      }),
    ]);
    // Nothing for a call without a business.
    await reportModelUsage({
      tenantId: '',
      model: 'fake/scripted',
      source: 'guardrail',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect((await uses(ana)).filter((u) => u.source === 'guardrail')).toHaveLength(1);
  });
});

describe('the operator', () => {
  it('needs a signed-in operator holding platform.credits; an unknown business is 404', async () => {
    const anonymous = await fetch(`${server.base}/api/credits/operator/${tenant[lee.name]}`);
    expect(anonymous.status).toBe(401);
    // A business's owner is no operator; an operator without the capability is refused too.
    expect((await operator('GET', `/${tenant[lee.name]}`, undefined, lee)).body).toMatchObject({
      rule: 'not_an_operator',
    });
    expect((await operator('GET', `/${tenant[lee.name]}`, undefined, otto)).body).toMatchObject({
      rule: 'operator_capability',
    });
    expect((await operator('GET', `/${tenant[lee.name]}`)).status).toBe(200);
    expect((await operator('GET', '/no-such-business')).status).toBe(404);
  });

  it('sets a plan, audited in that business; another business is untouched', async () => {
    const res = await setPlan(lee, { enforce: true, allowance: 500, prices: { tokens: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    const { rows } = await pool.query(
      `select action, actor_kind, actor_id, on_behalf_of, before, after from audit.events
       where tenant_id = $1 and action in ('credits.plan.set', 'tenant.update')
       order by at, action desc`,
      [tenant[lee.name]],
    );
    // The operator's system job, on behalf of the operator.
    expect(rows.map((r) => [r.action, r.actor_kind, r.actor_id, r.on_behalf_of])).toEqual([
      ['tenant.update', 'system', 'credits.operator', `operator:${opalId}`],
      ['credits.plan.set', 'system', 'credits.operator', `operator:${opalId}`],
    ]);
    expect(rows[0].after).toEqual({
      credits: { enforce: true, allowance: 500, prices: { tokens: 0 } },
    });
    expect((await lee.call('GET', '/api/credits')).body).toMatchObject({
      enforced: true,
      allowance: 500,
      usedPercent: 0,
      paused: null,
    });
    expect((await ravi.call('GET', '/api/credits')).body.enforced).toBe(false);
  });

  it('refuses a plan for meters nobody registered, or an alert above the pause: 400', async () => {
    const bad = await setPlan(ravi, {
      enforce: true,
      limits: { nothing: 1 },
      prices: { 'nope.x': 1 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toEqual([
      'limits.nothing: no meter is called nothing',
      'prices.nope.x: no meter is called nope',
    ]);
    expect((await setPlan(ravi, { alertAt: 90, pauseAt: 80 })).status).toBe(400);
    expect((await setPlan(ravi, { enforce: true, extra: 1 })).status).toBe(400);
    expect((await ravi.call('GET', '/api/credits')).body.enforced).toBe(false);
  });
});

describe('the 80% alert and the 100% pause', () => {
  it('alerts the people who manage the credits once, at 80%', async () => {
    for (let i = 0; i < 3; i++) expect((await addTask(lee)).status).toBe(200);
    expect((await lee.call('GET', '/api/credits')).body).toMatchObject({
      spent: 300,
      usedPercent: 60,
    });
    expect(await alertsOf(lee)).toEqual([]);

    expect((await addTask(lee)).status).toBe(200);
    expect(await alertsOf(lee)).toEqual(['credits/alert']);
    const { rows } = await pool.query(
      `select name, actor_kind, actor_id, row from app.domain_events
       where tenant_id = $1 and name = 'credits.threshold'`,
      [tenant[lee.name]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'system', actor_id: 'credits.meter' });
    expect(rows[0].row).toMatchObject({
      cap: 'credits',
      level: 'alert',
      usedPercent: 80,
      threshold: 80,
    });
    // It names nobody: the application's notification asks for whoever holds credits.manage.
    expect(rows[0].row).not.toHaveProperty('recipients');
    // The application's notification: an email to Lee, none to the staff member.
    const mail = await eventually(async () => {
      const m = await mailTo(lee.email);
      return m.find((x) => x.Subject === '[credits] credits alert');
    });
    expect(mail).toBeTruthy();
    expect(await mailTo(sam.email)).toEqual([]);
    // Another turn above 80% does not alert again.
    expect((await lee.chat('hello')).status).toBe(200);
    expect(await alertsOf(lee)).toEqual(['credits/alert']);
  });

  it('pauses at 100%: the next turn is refused with 402 and nothing is saved', async () => {
    expect((await addTask(lee)).status).toBe(200);
    expect(await alertsOf(lee)).toEqual(['credits/alert', 'credits/pause']);
    const saved = await messagesSaved(lee);
    const refused = await addTask(lee);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ error: 'turn_refused', rule: 'credits_exhausted' });
    expect(await messagesSaved(lee)).toBe(saved);
    // Streaming turns too.
    expect((await lee.stream('add something')).status).toBe(402);

    const status = (await lee.call('GET', '/api/credits')).body;
    expect(status).toMatchObject({
      usedPercent: 100,
      remaining: 0,
      paused: { rule: 'credits_exhausted', cap: 'credits' },
    });
    // The allowance covered it all: the wallet was never touched.
    expect(await ledgerOf(lee)).toEqual([]);
  });

  it.skipIf(!process.env.VOICE_AGENT_KEY)('refuses a new voice session while paused', async () => {
    const res = await lee.call('POST', '/api/voice/session', {});
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'credits_paused', rule: 'credits_exhausted' });
  });

  it('staff see that it is paused and why, without amounts', async () => {
    const status = (await inLee(sam)('GET', '/api/credits')).body;
    expect(status.paused.rule).toBe('credits_exhausted');
    expect(status.usedPercent).toBe(100);
    for (const key of [
      'spent',
      'balance',
      'allowance',
      'remaining',
      'prices',
      'currency',
      'override',
    ])
      expect(status).not.toHaveProperty(key);
    expect(status.meters.every((m: object) => !('cost' in m))).toBe(true);
    expect((await inLee(sam)('GET', '/api/credits/ledger')).status).toBe(403);
    // A staff member's turn is refused too.
    expect((await inLee(sam)('POST', '/api/chat/once', { message: 'hello' })).status).toBe(402);
  });
});

describe('the wallet', () => {
  it('an instant purchase tops it up; turns run again, debited past the allowance', async () => {
    const bought = await lee.call('POST', '/api/credits/purchases', {
      amount: 5000,
      provider: 'fixture-pay',
    });
    expect(bought.status).toBe(201);
    expect(bought.body.status).toBe('done');
    expect(bought.body.value).toMatchObject({
      amount: 5000,
      currency: 'XXX',
      status: 'paid',
      provider: 'fixture-pay',
    });
    expect(started.at(-1)).toMatchObject({ userId: lee.id, purchase: { amount: 5000 } });
    expect(await ledgerOf(lee)).toEqual([{ kind: 'topup', amount: 5000, balance: 5000 }]);
    const status = (await lee.call('GET', '/api/credits')).body;
    expect(status).toMatchObject({ balance: 5000, remaining: 5000, paused: null });
    expect(status.usedPercent).toBeCloseTo(9.1, 1);
    // Back under both levels: they are announced again next time.
    await eventually(async () => ((await alertsOf(lee)).length === 0 ? true : undefined));

    expect((await addTask(lee)).status).toBe(200);
    const ledger = await ledgerOf(lee);
    expect(ledger.at(-1)).toEqual({ kind: 'debit', amount: -100, balance: 4900 });
    const { rows } = await pool.query(
      `select l.ref = u.id as linked from app.credit_ledger l join app.usage_events u on u.id = l.ref
       where l.tenant_id = $1 and l.kind = 'debit'`,
      [tenant[lee.name]],
    );
    expect(rows).toEqual([{ linked: true }]);
    const listed = (await lee.call('GET', '/api/credits/ledger')).body;
    expect(listed.items.map((e: { kind: string }) => e.kind)).toEqual(['debit', 'topup']);
  });

  it('a checkout opens, and its provider’s confirmation settles it once', async () => {
    const bought = await lee.call('POST', '/api/credits/purchases', {
      amount: CHECKOUT_FROM,
      provider: 'fixture-pay',
    });
    const purchase = bought.body.value;
    expect(purchase).toMatchObject({
      status: 'open',
      checkoutUrl: `https://pay.example.test/${purchase.id}`,
    });
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    const of = { tenantId: tenant[lee.name], provider: 'fixture-pay', purchaseId: purchase.id };
    // Only its own business and provider settle it: anyone else's is not found.
    for (const wrong of [
      { ...of, tenantId: tenant[ravi.name] },
      { ...of, provider: GATEWAY },
    ])
      expect(
        await credits
          .settlePurchase(wrong, { status: 'paid' })
          .catch((e: { getStatus(): number }) => e.getStatus()),
      ).toBe(404);
    const paid = await credits.settlePurchase(of, { status: 'paid', ref: 'pay-1' });
    expect(paid).toMatchObject({ status: 'paid', checkoutUrl: null });
    // Settled twice: nothing moves again.
    await credits.settlePurchase(of, { status: 'paid', ref: 'pay-1' });
    const topups = (await ledgerOf(lee)).filter((e) => e.kind === 'topup');
    expect(topups.map((e) => e.amount)).toEqual([5000, CHECKOUT_FROM]);
    expect((await lee.call('GET', `/api/credits/purchases/${purchase.id}`)).body.status).toBe(
      'paid',
    );
    const { rows } = await pool.query(
      `select actor_kind, actor_id from audit.events where action = 'credits.purchase.settle'
       and resource_id = $1`,
      [purchase.id],
    );
    expect(rows).toEqual([{ actor_kind: 'system', actor_id: 'credits.purchase' }]);
  });

  it('a failed payment moves nothing', async () => {
    const before = await ledgerOf(lee);
    const { id } = (
      await lee.call('POST', '/api/credits/purchases', {
        amount: CHECKOUT_FROM + 1,
        provider: 'fixture-pay',
      })
    ).body.value;
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    expect(
      await credits.settlePurchase(
        { tenantId: tenant[lee.name], provider: 'fixture-pay', purchaseId: id },
        { status: 'failed', reason: 'declined' },
      ),
    ).toMatchObject({
      status: 'failed',
      reason: 'declined',
    });
    expect(await ledgerOf(lee)).toEqual(before);
  });

  it('a large purchase waits for an approval, audited, and starts once approved', async () => {
    const parked = await lee.call('POST', '/api/credits/purchases', {
      amount: APPROVAL_FROM,
      provider: 'fixture-pay',
    });
    expect(parked.body.status).toBe('needs_approval');
    const approvalId = parked.body.approval.id;
    const { rows } = await pool.query(
      `select outcome, rule from audit.events where action = 'credits.purchase' and tenant_id = $1
       and outcome = 'needs_approval'`,
      [tenant[lee.name]],
    );
    expect(rows).toEqual([{ outcome: 'needs_approval', rule: 'fixture_large_purchase' }]);
    const count = async () =>
      (
        await pool.query(
          'select count(*)::int as n from app.credit_purchases where tenant_id = $1 and amount = $2',
          [tenant[lee.name], APPROVAL_FROM],
        )
      ).rows[0].n;
    expect(await count()).toBe(0);
    expect((await lee.call('POST', `/api/approvals/${approvalId}/approve`)).status).toBe(200);
    // The replay records it; its provider starts it.
    await eventually(async () => {
      const { rows: open } = await pool.query(
        `select status from app.credit_purchases where tenant_id = $1 and amount = $2`,
        [tenant[lee.name], APPROVAL_FROM],
      );
      return open[0]?.status === 'open' ? true : undefined;
    });
  });

  it('a grant from the operator, audited, with its note in the ledger', async () => {
    const before = (await lee.call('GET', '/api/credits')).body.balance;
    const res = await operator('POST', `/${tenant[lee.name]}/grants`, {
      amount: 250,
      note: 'goodwill',
    });
    expect(res.status).toBe(201);
    expect(res.body.value).toEqual({ balance: before + 250, currency: 'XXX' });
    const { rows } = await pool.query(
      `select note, actor_kind, actor_id from app.credit_ledger where tenant_id = $1 and kind = 'grant'`,
      [tenant[lee.name]],
    );
    expect(rows).toEqual([
      { note: 'goodwill', actor_kind: 'system', actor_id: 'credits.operator' },
    ]);
    expect(
      (await operator('POST', `/${tenant[lee.name]}/grants`, { amount: -5, note: 'x' })).status,
    ).toBe(400);
  });
});

describe('who may see and do what', () => {
  it('staff cannot buy; the refusal is audited', async () => {
    const res = await inLee(sam)('POST', '/api/credits/purchases', {
      amount: 100,
      provider: 'fixture-pay',
    });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('credits_manage');
    const { rows } = await pool.query(
      `select outcome from audit.events where action = 'credits.purchase' and actor_id = $1`,
      [sam.id],
    );
    expect(rows).toEqual([{ outcome: 'denied' }]);
  });

  it('the assistant and a customer get 403', async () => {
    expect((await asAssistant(`user:${lee.id}`)('GET', '/api/credits')).status).toBe(403);
    const customer = new Person('Cara Credits');
    await customer.signUp();
    await addMember(customer, tenant[lee.name], ['customer']);
    expect(
      (await customer.call('GET', '/api/credits', undefined, { 'x-tenant-id': tenant[lee.name] }))
        .status,
    ).toBe(403);
  });

  it("another business's purchase is not found; its ledger is its own", async () => {
    const { rows } = await pool.query(
      'select id from app.credit_purchases where tenant_id = $1 limit 1',
      [tenant[lee.name]],
    );
    expect((await ravi.call('GET', `/api/credits/purchases/${rows[0].id}`)).status).toBe(404);
    expect((await ravi.call('GET', '/api/credits/ledger')).body.items).toEqual([]);
    expect(
      (await ravi.call('GET', '/api/credits', undefined, { 'x-tenant-id': tenant[lee.name] }))
        .status,
    ).toBe(403);
  });

  it('the business sets its own alert threshold, never above its pause', async () => {
    expect((await lee.call('PUT', '/api/credits/alerts', { alertAt: 120 })).status).toBe(400);
    const res = await lee.call('PUT', '/api/credits/alerts', { alertAt: 70 });
    expect(res.status).toBe(200);
    expect((await lee.call('GET', '/api/credits')).body.alertAt).toBe(70);
    expect((await inLee(sam)('PUT', '/api/credits/alerts', { alertAt: 60 })).status).toBe(403);
    // The operator's next plan keeps it.
    await setPlan(lee, { enforce: true, allowance: 500, prices: { tokens: 0 } });
    expect((await lee.call('GET', '/api/credits')).body.alertAt).toBe(70);
  });
});

describe('limits', () => {
  it('a tool-call limit pauses turns, and only turns', async () => {
    await setPlan(mia, {
      enforce: true,
      allowance: 1_000_000,
      limits: { tool_calls: 2, voice_seconds: 120 },
    });
    expect((await addTask(mia)).status).toBe(200);
    expect((await addTask(mia)).status).toBe(200);
    const refused = await addTask(mia);
    expect(refused.status).toBe(402);
    expect(refused.body.rule).toBe('usage_limit_reached');
    const status = (await mia.call('GET', '/api/credits')).body;
    expect(status.paused).toBeNull();
    expect(status.meters.find((m: { meter: string }) => m.meter === 'tool_calls')).toMatchObject({
      quantity: 2,
      limit: 2,
      usedPercent: 100,
      paused: true,
    });
    expect(await alertsOf(mia)).toEqual(['tool_calls/alert', 'tool_calls/pause']);
  });

  it.skipIf(!process.env.VOICE_AGENT_KEY)(
    'a voice limit cuts a session short; a reported session is metered once for the business',
    async () => {
      const first = await mia.call('POST', '/api/voice/session', {});
      expect(first.status).toBe(201);
      const asWorker = (body: object) =>
        fetch(`${server.base}/api/voice/end`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-agent-key': process.env.VOICE_AGENT_KEY ?? '',
            'x-agent-id': 'voice',
            'x-acting-for': mia.id,
            'x-run-id': `voice-${Date.now()}`,
          },
          body: JSON.stringify(body),
        });
      expect((await asWorker({ room: first.body.room, seconds: 100, turns: 2 })).status).toBe(204);
      expect((await asWorker({ room: first.body.room, seconds: 100, turns: 2 })).status).toBe(204);
      const voice = (await uses(mia)).filter((u) => u.meter === 'voice_seconds');
      expect(voice).toEqual([
        expect.objectContaining({
          quantity: 100,
          cost: 100,
          source: 'voice',
          ref: first.body.room,
        }),
      ]);
      // 20 seconds left of 120: the next session is cut to them.
      const second = await mia.call('POST', '/api/voice/session', {});
      expect(second.status).toBe(201);
      const { rows } = await pool.query(
        `select after->>'maxSeconds' as max, tenant_id from audit.events
         where action = 'voice.session.start' and after->>'room' = $1`,
        [second.body.room],
      );
      expect(rows).toEqual([{ max: '20', tenant_id: tenant[mia.name] }]);
    },
  );
});

describe('alerts a plan makes due', () => {
  it('a lower allowance alerts without new use; the sweep announces nothing twice', async () => {
    const zed = new Person('Zed Credits');
    await zed.signUp();
    tenant[zed.name] = (await me(zed)).tenantId;
    expect((await addTask(zed)).status).toBe(200);
    const spent = (await zed.call('GET', '/api/credits')).body.spent as number;
    expect(spent).toBeGreaterThan(0);
    // On credits with exactly what it spent: used up, though nothing new was used.
    expect((await setPlan(zed, { enforce: true, allowance: spent })).status).toBe(200);
    await eventually(async () => ((await alertsOf(zed)).length === 2 ? true : undefined));
    expect(await alertsOf(zed)).toEqual(['credits/alert', 'credits/pause']);
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    expect(await credits.sweep()).toBeGreaterThan(0);
    const { rows } = await pool.query(
      `select count(*)::int as n from app.domain_events where tenant_id = $1 and name = 'credits.threshold'`,
      [tenant[zed.name]],
    );
    expect(rows[0].n).toBe(2);
    // A bigger allowance re-arms both levels.
    await setPlan(zed, { enforce: true, allowance: spent * 10 });
    await eventually(async () => ((await alertsOf(zed)).length === 0 ? true : undefined));
  });
});

describe('the operator’s override', () => {
  it('run lets a paused business through, still metered; clearing it pauses again', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const set = await operator('PUT', `/${tenant[mia.name]}/override`, {
      override: { mode: 'run', until, reason: 'support case' },
    });
    expect(set.status).toBe(200);
    expect((await addTask(mia)).status).toBe(200);
    const status = (await mia.call('GET', '/api/credits')).body;
    expect(status.override).toMatchObject({ mode: 'run', reason: 'support case' });
    expect(status.meters.find((m: { meter: string }) => m.meter === 'tool_calls').quantity).toBe(3);
    expect(
      (await operator('PUT', `/${tenant[mia.name]}/override`, { override: null })).status,
    ).toBe(200);
    expect((await addTask(mia)).status).toBe(402);
  });

  it('pause stops a business that is not even on credits; an expired one is ignored', async () => {
    await operator('PUT', `/${tenant[ravi.name]}/override`, {
      override: { mode: 'pause', reason: 'unpaid invoice' },
    });
    const refused = await ravi.chat('hello');
    expect(refused.status).toBe(402);
    expect(refused.body.rule).toBe('credits_suspended');
    expect((await ravi.call('GET', '/api/credits')).body.paused.rule).toBe('credits_suspended');
    await operator('PUT', `/${tenant[ravi.name]}/override`, {
      override: { mode: 'pause', until: new Date(Date.now() - 1000).toISOString(), reason: 'old' },
    });
    expect((await ravi.chat('hello')).status).toBe(200);
  });
});

describe('embeddings', () => {
  const eve = new Person('Eve Credits'); // recall and indexing under credits
  /** The fake embedding's tokens are its words: one credit each, by the plan's own price. */
  const EMBEDDING_PRICES = { 'embedding_tokens.fake/embedding': 1_000_000 };

  const recall = (who: Person, q: string) =>
    who.call('GET', `/api/memory/recall?${new URLSearchParams({ q })}`);

  async function embeddingsOf(person: Person, source?: string) {
    const { rows } = await pool.query(
      `select variant, quantity::int, cost::int, source, subject, run_id, channel
       from app.usage_events where tenant_id = $1 and meter = 'embedding_tokens'
       and ($2::text is null or source = $2) order by at, id`,
      [tenant[person.name], source ?? null],
    );
    return rows;
  }

  async function indexRow(id: string) {
    const { rows } = await pool.query(
      `select state, attempts, error, model from app.memory_index
       where source_type = 'memory' and source_id = $1`,
      [id],
    );
    return rows[0];
  }

  const indexed = (id: string, ms?: number) =>
    eventually(async () => ((await indexRow(id))?.state === 'ready' ? true : undefined), ms);

  async function remember(person: Person, text: string) {
    const res = await person.call('POST', '/api/memories', { text });
    expect(res.status).toBe(201);
    return res.body.value.id as string;
  }

  beforeAll(async () => {
    await eve.signUp();
    tenant[eve.name] = (await me(eve)).tenantId;
    expect((await setPlan(eve, { prices: EMBEDDING_PRICES })).status).toBe(200);
  });

  it('recall through the API is metered for the reader, and priced', async () => {
    const res = await recall(eve, 'where are the spare keys');
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fake/embedding');
    expect(await embeddingsOf(eve)).toEqual([
      expect.objectContaining({
        variant: 'fake/embedding',
        quantity: 5,
        cost: 5,
        source: 'memory.recall',
        subject: `user:${eve.id}`,
        run_id: null,
      }),
    ]);
  });

  it('a turn’s recall is metered with the turn', async () => {
    expect((await eve.chat('hello there')).status).toBe(200);
    const turn = (await embeddingsOf(eve)).at(-1);
    expect(turn).toMatchObject({ quantity: 2, cost: 2, source: 'memory.recall' });
    expect(turn.run_id).toEqual(expect.any(String));
  });

  it('a memory written is embedded by the indexer and metered', async () => {
    const id = await remember(eve, 'The spare keys are in the blue box');
    await indexed(id);
    expect(await embeddingsOf(eve, 'memory.index')).toEqual([
      expect.objectContaining({
        variant: 'fake/embedding',
        quantity: 8,
        cost: 8,
        subject: null,
        channel: 'background',
      }),
    ]);
  });

  it('paused by the operator: recall is 402 and spends nothing; new memory waits', async () => {
    const paused = await operator('PUT', `/${tenant[eve.name]}/override`, {
      override: { mode: 'pause', reason: 'unpaid invoice' },
    });
    expect(paused.status).toBe(200);
    const before = await uses(eve);

    const refused = await recall(eve, 'where are the spare keys');
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({
      error: 'credits_paused',
      rule: 'credits_suspended',
      reason: expect.stringContaining('unpaid invoice'),
    });
    // The assistant's recall-memory tool calls the same route, as the person.
    const asBot = await asAssistant(eve.id)('GET', '/api/memory/recall?q=spare%20keys');
    expect(asBot.status).toBe(402);
    expect(asBot.body.rule).toBe('credits_suspended');
    expect((await eve.chat('hello')).status).toBe(402);

    // Written while paused: the write goes through, its embedding waits. Another business's
    // memory, written after it, is embedded meanwhile, so the indexer has seen both.
    const waiting = await remember(eve, 'Deliveries come in by the back gate');
    const elsewhere = await remember(ana, 'The office is closed on Sundays');
    await indexed(elsewhere);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await indexRow(waiting)).toEqual({
      state: 'pending',
      attempts: 0,
      error: null,
      model: null,
    });
    expect(await uses(eve)).toEqual(before);

    // Cleared: the memory is embedded and metered, and recall finds it.
    expect(
      (await operator('PUT', `/${tenant[eve.name]}/override`, { override: null })).status,
    ).toBe(200);
    await indexed(waiting, 20_000);
    expect(await embeddingsOf(eve, 'memory.index')).toHaveLength(2);
    const found = await recall(eve, 'deliveries back gate');
    expect(found.status).toBe(200);
    expect(found.body.items.map((i: { text: string }) => i.text)).toContain(
      'Deliveries come in by the back gate',
    );
  });

  it('a limit on embedding tokens refuses recall only; turns run without it', async () => {
    const used = (await embeddingsOf(eve)).reduce((n, u) => n + u.quantity, 0);
    expect(
      (
        await setPlan(eve, {
          enforce: true,
          allowance: 1_000_000,
          limits: { embedding_tokens: used },
          prices: EMBEDDING_PRICES,
        })
      ).status,
    ).toBe(200);
    const limited = await recall(eve, 'spare keys');
    expect(limited.status).toBe(402);
    expect(limited.body).toMatchObject({ error: 'credits_paused', rule: 'usage_limit_reached' });

    const before = (await embeddingsOf(eve)).length;
    expect((await eve.chat('hello')).status).toBe(200);
    expect(await embeddingsOf(eve)).toHaveLength(before);
    const status = (await eve.call('GET', '/api/credits')).body;
    expect(status.paused).toBeNull();
    expect(
      status.meters.find((m: { meter: string }) => m.meter === 'embedding_tokens'),
    ).toMatchObject({ unit: 'token', quantity: used, limit: used, paused: true });
  });
});

describe('WhatsApp', () => {
  const customer = `1555${String(Date.now()).slice(-7)}`;
  const toCustomer = () => sent.filter((s) => s.to === customer && s.type);
  const delivery = (from: string, body: string) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: NUMBER },
                messages: [
                  {
                    from,
                    id: `m-cr-${Date.now()}-${seq++}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  const post = (raw: string) =>
    fetch(`${server.base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });

  beforeAll(async () => {
    // Mia's business answers on WhatsApp; she is paused for turns (her tool-call limit).
    expect(
      (await mia.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
    ).toBe(201);
  });

  it('a paused business’s customer is handed to the team and told so', async () => {
    await setPlan(mia, { enforce: true, allowance: 0 });
    const raw = delivery(customer, 'add a task please');
    expect((await post(raw)).status).toBe(200);
    // The welcome, then the handoff line instead of an answer.
    const replies = await eventually(() => (toCustomer().length >= 2 ? toCustomer() : undefined));
    expect(replies[1].text?.body).toMatch(/Someone from the team will reply here/);
    const { rows } = await pool.query(
      `select h.reason, (select count(*)::int from app.thread_messages m where m.thread_id = h.thread_id) as said
       from channel.handoffs h join channel.contacts c on c.id = h.contact_id
       where c.address = $1`,
      [customer],
    );
    expect(rows).toEqual([{ reason: 'assistant_paused', said: 2 }]);
  });

  it('messages sent are metered once the provider takes them, priced by category', async () => {
    await eventually(async () =>
      (await uses(mia)).filter((u) => u.meter === 'messages').length >= 2 ? true : undefined,
    );
    const messages = (await uses(mia)).filter((u) => u.meter === 'messages');
    expect(messages.every((m) => m.quantity === 1 && m.cost === 5 && m.source === 'outbound')).toBe(
      true,
    );
    expect(messages[0].subject).toMatch(/^contact:/);
  });

  it('a paused business sends no category its plan pauses; others still go', async () => {
    await setPlan(mia, { enforce: true, allowance: 0, pauseMessages: ['marketing'] });
    const { OutboundService } = await import('../../dist/channels/outbound.service.js');
    const outbound = server.app?.get(OutboundService, { strict: false });
    const { rows: contacts } = await pool.query(
      'select id from channel.contacts where tenant_id = $1 and address = $2',
      [tenant[mia.name], customer],
    );
    const target = { tenantId: tenant[mia.name], contactId: contacts[0].id, from: NUMBER };
    const text = (body: string) => [{ kind: 'text' as const, to: customer, text: body }];
    const [refused] = await outbound.queue(target, text('An offer'), { category: 'marketing' });
    const [kept] = await outbound.queue(target, text('Your booking'), { category: 'utility' });
    await eventually(() =>
      toCustomer().some((s) => s.text?.body === 'Your booking') ? true : undefined,
    );
    expect(toCustomer().some((s) => s.text?.body === 'An offer')).toBe(false);
    const { rows } = await pool.query(
      `select id, status, meta->'refused'->>'rule' as rule from channel.messages where id = any($1)`,
      [[refused, kept]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[refused]).toMatchObject({ status: 'failed', rule: 'credits_exhausted' });
    expect(byId[kept].status).not.toBe('failed');
    await eventually(async () =>
      (await uses(mia)).some((u) => u.variant === 'utility') ? true : undefined,
    );
    expect((await uses(mia)).some((u) => u.variant === 'marketing')).toBe(false);
  });
});

describe("the business's own roles say who is alerted (X1)", () => {
  const kai = new Person('Kai Credits'); // the owner, whose role the business edits
  const bea = new Person('Bea Credits'); // a role the business made, with credits.manage
  let kaiTenant = '';
  const inKai = (person: Person) => (method: string, path: string, body?: unknown) =>
    person.call(method, path, body, { 'x-tenant-id': kaiTenant });

  beforeAll(async () => {
    for (const person of [kai, bea]) await person.signUp();
    kaiTenant = (await me(kai)).tenantId;
    const made = await kai.call('POST', '/api/members/roles', {
      name: 'billing',
      label: { en: 'Billing' },
      capabilities: ['credits.manage', 'credits.view'],
    });
    expect(made.status).toBe(200);
    // The owner keeps managing members, and stops managing the credits.
    const edited = await kai.call('PATCH', '/api/members/roles/owner', {
      capabilities: ['members.manage', 'members.read', 'credits.view'],
    });
    expect(edited.status).toBe(200);
    await addMember(bea, kaiTenant, ['billing']);
  });

  it('the amounts and the alert go to the role the business made, not to the role it edited', async () => {
    expect((await inKai(bea)('GET', '/api/credits')).body).toHaveProperty('spent');
    expect((await kai.call('GET', '/api/credits')).body).not.toHaveProperty('spent');

    const plan = { enforce: true, allowance: 500, prices: { tokens: 0 } };
    expect((await operator('PUT', `/${kaiTenant}/settings`, plan)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await addTask(kai)).status).toBe(200);
    const { rows } = await pool.query(
      `select row from app.domain_events where tenant_id = $1 and name = 'credits.threshold'`,
      [kaiTenant],
    );
    expect(rows.map((r) => [r.row.cap, r.row.level])).toEqual([['credits', 'alert']]);

    const mail = await eventually(async () => {
      const m = await mailTo(bea.email);
      return m.find((x) => x.Subject === '[credits] credits alert');
    });
    expect(mail).toBeTruthy();
    expect(await mailTo(kai.email)).toEqual([]);
  });
});

describe('a run that crosses the cap in the middle (H3)', () => {
  const pia = new Person('Pia Credits'); // on credits; report pages cost the most
  const PLAN = { enforce: true, prices: { tokens: 0, tool_calls: 0, report_pages: 600 } };

  const tasksTitled = async (title: string) =>
    (
      await pool.query('select id from app.fixture_tasks where tenant_id = $1 and title = $2', [
        tenant[pia.name],
        title,
      ])
    ).rows;

  /** A running run of one of Pia's agents, made by hand: what its token reaches. */
  async function runningRun(agentId: string) {
    const runId = randomUUID().replaceAll('-', '');
    await pool.query(
      `insert into app.agent_runs (tenant_id, agent_id, run_id, trigger_kind, dedupe, status, queues)
       values ($1, $2, $3, 'manual', $4, 'running', 'test-none')`,
      [tenant[pia.name], agentId, runId, `test:${runId}`],
    );
    return runId;
  }

  const asRun = async (runId: string, method: string, path: string) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      headers: { 'x-agent-run': agentRunToken(runId), 'x-run-id': runId },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  let agentId = '';

  beforeAll(async () => {
    await pia.signUp();
    tenant[pia.name] = (await me(pia)).tenantId;
    // 1,000 credits: two report pages (1,200) take the business past its cap.
    expect((await setPlan(pia, { ...PLAN, allowance: 1000 })).status).toBe(200);
    const made = await pia.call('POST', '/api/agents', {
      name: 'Reporter',
      instructions: 'render 2 report pages then add Agent follow-up',
      scope: { tools: ['render-report', 'create-task', 'list-tasks'] },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    agentId = made.body.value.id;
  });

  it('a turn whose first call takes the business past 100% ends with the paused sentence', async () => {
    const res = await pia.chat('render 2 report pages then add Pia follow-up');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(pausedText('en'));
    expect(
      res.body.toolCalls.map((c: { tool: string; outcome: string }) => `${c.tool}:${c.outcome}`),
    ).toEqual(['render-report:done', 'create-task:refused']);
    // The second call never reached the write: no task, and nothing more was spent on it.
    expect(await tasksTitled('Pia follow-up')).toEqual([]);
    const pages = (await uses(pia)).filter((u) => u.meter === 'report_pages');
    expect(pages).toEqual([
      expect.objectContaining({ quantity: 2, cost: 1200, source: 'credit_checks.render' }),
    ]);
    const status = (await pia.call('GET', '/api/credits')).body;
    expect(status.paused).toMatchObject({ rule: 'credits_exhausted' });
    // The next turn is refused before it starts.
    const next = await pia.chat('render 1 report page then add Another');
    expect(next.status).toBe(402);
    expect(next.body).toMatchObject({ error: 'turn_refused', rule: 'credits_exhausted' });
  });

  it('while paused, the assistant’s and an agent run’s calls are refused with 402', async () => {
    const assistant = await asAssistant(`user:${pia.id}`, { 'x-channel': 'app' })(
      'GET',
      '/api/tasks',
    );
    expect(assistant.status).toBe(402);
    expect(assistant.body).toMatchObject({ error: 'credits_paused', rule: 'credits_exhausted' });
    const runId = await runningRun(agentId);
    const run = await asRun(runId, 'GET', '/api/tasks');
    expect(run.status).toBe(402);
    expect(run.body).toMatchObject({ error: 'credits_paused' });
    // The person still works in the app: only agents are stopped.
    expect((await pia.call('GET', '/api/tasks')).status).toBe(200);
    // Another business's assistant is not.
    expect(
      (await asAssistant(`user:${ana.id}`, { 'x-channel': 'app' })('GET', '/api/tasks')).status,
    ).toBe(200);
    // The operator's `run` lets them through again.
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await operator('PUT', `/${tenant[pia.name]}/override`, {
      override: { mode: 'run', until, reason: 'support case' },
    });
    expect(
      (await asAssistant(`user:${pia.id}`, { 'x-channel': 'app' })('GET', '/api/tasks')).status,
    ).toBe(200);
    expect((await asRun(runId, 'GET', '/api/tasks')).status).toBe(200);
    await operator('PUT', `/${tenant[pia.name]}/override`, { override: null });
    expect((await asRun(runId, 'GET', '/api/tasks')).status).toBe(402);
  });

  it('an agent’s run that crosses the cap stops there, with the paused sentence in its log', async () => {
    // 2,000 credits: under the cap when the run starts (the 200 the first turn overshot is still
    // owed by the wallet: 1,200 of 1,800), and past it after its render.
    expect((await setPlan(pia, { ...PLAN, allowance: 2000 })).status).toBe(200);
    expect((await pia.call('GET', '/api/credits')).body).toMatchObject({
      paused: null,
      usedPercent: 66.7,
      balance: -200,
    });
    const ran = await pia.call('POST', `/api/agents/${agentId}/run`, {});
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    const id = ran.body.value.id as string;
    const run = await eventually(async () => {
      const r = await pia.call('GET', `/api/agent-runs/${id}`);
      return ['done', 'waiting', 'failed', 'refused'].includes(r.body?.status) ? r.body : undefined;
    }, 20_000);
    expect(run.status).toBe('done');
    expect(run.reply).toBe(pausedText('en'));
    expect(
      run.toolCalls.map((c: { tool: string; outcome: string }) => `${c.tool}:${c.outcome}`),
    ).toEqual(['render-report:done', 'create-task:refused']);
    expect(await tasksTitled('Agent follow-up')).toEqual([]);
    expect((await pia.call('GET', '/api/credits')).body.paused).toMatchObject({
      rule: 'credits_exhausted',
    });
  });
});

describe('a purchase its gateway confirms by webhook (H3)', () => {
  const SECRET = 'fixture-gateway-secret-0123456789abcdef';
  const OTHER = 'fixture-gateway-other-0123456789abcdef';
  let leePath = '';
  let raviPath = '';

  const post = (path: string, body: object, secret: string, event = `ev-${randomUUID()}`) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = `${timestamp}.${event}.${raw}`;
    const signature = `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`;
    return fetch(`${server.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-signature': signature,
        'x-gateway-event': event,
        'x-gateway-timestamp': timestamp,
      },
      body: raw,
    });
  };

  const buy = async (amount: number) => {
    const res = await lee.call('POST', '/api/credits/purchases', { amount, provider: GATEWAY });
    expect(res.status).toBe(201);
    return res.body.value as { id: string; status: string; checkoutUrl: string | null };
  };

  const purchaseOf = async (id: string) =>
    (await pool.query('select status, provider_ref from app.credit_purchases where id = $1', [id]))
      .rows[0];

  const topupsFor = async (id: string) =>
    (
      await pool.query(
        `select amount::int from app.credit_ledger where tenant_id = $1 and kind = 'topup' and ref = $2`,
        [tenant[lee.name], id],
      )
    ).rows;

  const inboundOf = async (event: string) =>
    (
      await pool.query(
        'select status, error, handled from app.integration_inbound where external_id = $1',
        [event],
      )
    ).rows;

  beforeAll(async () => {
    const mine = await lee.call('POST', '/api/integrations/connections', {
      connector: GATEWAY,
      label: 'Our gateway',
      credentials: { secret: SECRET },
    });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    leePath = mine.body.value.inboundPath;
    const theirs = await ravi.call('POST', '/api/integrations/connections', {
      connector: GATEWAY,
      credentials: { secret: OTHER },
    });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
    raviPath = theirs.body.value.inboundPath;
  });

  it('opens a checkout; the signed webhook tops the wallet up once, however often it comes', async () => {
    const purchase = await buy(2000);
    expect(purchase).toMatchObject({
      status: 'open',
      checkoutUrl: `https://gateway.example.test/pay/${purchase.id}`,
    });
    const body = { type: 'payment.succeeded', purchaseId: purchase.id, ref: 'gw-pay-1' };
    const event = `ev-${randomUUID()}`;
    expect((await post(leePath, body, SECRET, event)).status).toBe(200);
    // The same delivery again (the gateway retries): stored once.
    expect((await post(leePath, body, SECRET, event)).status).toBe(200);
    await eventually(async () =>
      (await purchaseOf(purchase.id))?.status === 'paid' ? true : undefined,
    );
    expect(await purchaseOf(purchase.id)).toEqual({ status: 'paid', provider_ref: 'gw-pay-1' });
    expect(await inboundOf(event)).toEqual([
      { status: 'processed', error: null, handled: { 'credit-checks.settle': 'done' } },
    ]);
    // Another event for the same purchase (a second notice): settled already, nothing moves.
    const again = `ev-${randomUUID()}`;
    expect((await post(leePath, body, SECRET, again)).status).toBe(200);
    await eventually(async () =>
      (await inboundOf(again))[0]?.status === 'processed' ? true : undefined,
    );
    expect(await topupsFor(purchase.id)).toEqual([{ amount: 2000 }]);
    const { rows } = await pool.query(
      `select actor_kind, actor_id from audit.events where action = 'credits.purchase.settle'
       and resource_id = $1`,
      [purchase.id],
    );
    expect(rows).toEqual([{ actor_kind: 'system', actor_id: 'credits.purchase' }]);
  });

  it('a failed payment moves nothing', async () => {
    const purchase = await buy(2100);
    const event = `ev-${randomUUID()}`;
    await post(leePath, { type: 'payment.failed', purchaseId: purchase.id }, SECRET, event);
    await eventually(async () =>
      (await purchaseOf(purchase.id))?.status === 'failed' ? true : undefined,
    );
    expect(await topupsFor(purchase.id)).toEqual([]);
  });

  it('a bad signature is 401, and nothing is stored', async () => {
    const purchase = await buy(2200);
    const event = `ev-${randomUUID()}`;
    const res = await post(
      leePath,
      { type: 'payment.succeeded', purchaseId: purchase.id },
      'not-the-secret-0123456789abcdef',
      event,
    );
    expect(res.status).toBe(401);
    expect(await inboundOf(event)).toEqual([]);
    expect((await purchaseOf(purchase.id)).status).toBe('open');
  });

  it('another business’s connection cannot settle this business’s purchase', async () => {
    const purchase = await buy(2300);
    const before = await ledgerOf(lee);
    const event = `ev-${randomUUID()}`;
    // Ravi's own connection, correctly signed with Ravi's secret, naming Lee's purchase.
    const res = await post(
      raviPath,
      { type: 'payment.succeeded', purchaseId: purchase.id, ref: 'stolen' },
      OTHER,
      event,
    );
    expect(res.status).toBe(200);
    const [row] = await eventually(async () => {
      const rows = await inboundOf(event);
      return rows[0]?.status === 'failed' ? rows : undefined;
    });
    expect(row.error).toContain('No such purchase');
    expect(await purchaseOf(purchase.id)).toEqual({
      status: 'open',
      provider_ref: `gw-${purchase.id}`,
    });
    expect(await ledgerOf(lee)).toEqual(before);
    expect((await ledgerOf(ravi)).filter((e) => e.kind === 'topup')).toEqual([]);
  });

  it('a purchase made through another provider is not the gateway’s to settle', async () => {
    const res = await lee.call('POST', '/api/credits/purchases', {
      amount: CHECKOUT_FROM + 2,
      provider: 'fixture-pay',
    });
    const purchase = res.body.value as { id: string };
    const event = `ev-${randomUUID()}`;
    await post(leePath, { type: 'payment.succeeded', purchaseId: purchase.id }, SECRET, event);
    await eventually(async () =>
      (await inboundOf(event))[0]?.status === 'failed' ? true : undefined,
    );
    expect((await purchaseOf(purchase.id)).status).toBe('open');
  });
});
