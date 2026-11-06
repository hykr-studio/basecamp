// Credits and caps (A3): every turn's tokens and tool calls, every WhatsApp message sent and
// every voice second metered and priced (CREDITS_CONFIG); the operator's plan, override and
// grants; the 80% alert and the 100% pause; the prepaid wallet with its ledger and purchases
// through a provider; and who may see and do what.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditsService } from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
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
  started,
} from '../fixture/dist/features/credits/index.js';

const OPERATOR_KEY = `operator-${'k'.repeat(40)}`;
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
const tenant: Record<string, string> = {};

const ENV = [
  'CREDITS_CONFIG',
  'OPERATOR_API_KEY',
  'WA_GRAPH_URL',
  'WA_APP_SECRET',
  'WA_VERIFY_TOKEN',
];
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
  process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  await boot(creditsApp);
  for (const person of [ana, lee, sam, mia, ravi]) {
    await person.signUp();
    tenant[person.name] = (await me(person)).tenantId;
  }
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

const operator = (method: string, path: string, body?: unknown, key = OPERATOR_KEY) =>
  fetch(`${server.base}/api/credits/operator${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-operator-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

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
  it('prices a turn’s tokens and tool calls; nothing is capped or debited', async () => {
    const res = await addTask(ana);
    expect(res.status).toBe(200);
    const all = await uses(ana);
    expect(all).toHaveLength(2);
    const tokens = all.find((u) => u.meter === 'tokens');
    const tools = all.find((u) => u.meter === 'tool_calls');
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

  it('a turn without a tool counts its tokens only', async () => {
    const before = (await uses(ana)).length;
    expect((await ana.chat('hello')).status).toBe(200);
    const added = (await uses(ana)).slice(before);
    expect(added.map((u) => u.meter)).toEqual(['tokens']);
  });
});

describe('the operator', () => {
  it('needs the key: none or a wrong one is 401, an unknown business 404', async () => {
    expect((await operator('GET', `/${tenant[lee.name]}`, undefined, '')).status).toBe(401);
    expect((await operator('GET', `/${tenant[lee.name]}`, undefined, 'x'.repeat(48))).status).toBe(
      401,
    );
    expect((await operator('GET', '/no-such-business')).status).toBe(404);
    // No key configured: the routes are not there.
    delete process.env.OPERATOR_API_KEY;
    expect((await operator('GET', `/${tenant[lee.name]}`)).status).toBe(404);
    process.env.OPERATOR_API_KEY = OPERATOR_KEY;
  });

  it('sets a plan, audited in that business; another business is untouched', async () => {
    const res = await setPlan(lee, { enforce: true, allowance: 500, prices: { tokens: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    const { rows } = await pool.query(
      `select action, actor_kind, actor_id, before, after from audit.events
       where tenant_id = $1 and action in ('credits.plan.set', 'tenant.update') order by at`,
      [tenant[lee.name]],
    );
    expect(rows.map((r) => [r.action, r.actor_kind, r.actor_id])).toEqual([
      ['tenant.update', 'system', 'credits.operator'],
      ['credits.plan.set', 'system', 'credits.operator'],
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
      recipients: [lee.id],
    });
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
    const bought = await lee.call('POST', '/api/credits/purchases', { amount: 5000 });
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
    const bought = await lee.call('POST', '/api/credits/purchases', { amount: CHECKOUT_FROM });
    const purchase = bought.body.value;
    expect(purchase).toMatchObject({
      status: 'open',
      checkoutUrl: `https://pay.example.test/${purchase.id}`,
    });
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    const paid = await credits.settlePurchase(purchase.id, { status: 'paid', ref: 'pay-1' });
    expect(paid).toMatchObject({ status: 'paid', checkoutUrl: null });
    // Settled twice: nothing moves again.
    await credits.settlePurchase(purchase.id, { status: 'paid', ref: 'pay-1' });
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
    const { id } = (await lee.call('POST', '/api/credits/purchases', { amount: CHECKOUT_FROM + 1 }))
      .body.value;
    const credits = server.app?.get(CreditsService, { strict: false }) as CreditsService;
    expect(
      await credits.settlePurchase(id, { status: 'failed', reason: 'declined' }),
    ).toMatchObject({
      status: 'failed',
      reason: 'declined',
    });
    expect(await ledgerOf(lee)).toEqual(before);
  });

  it('a large purchase waits for an approval, audited, and starts once approved', async () => {
    const parked = await lee.call('POST', '/api/credits/purchases', { amount: APPROVAL_FROM });
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
    const res = await inLee(sam)('POST', '/api/credits/purchases', { amount: 100 });
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
