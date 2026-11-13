// What the credits say to people (V13). A limit's refusal names its meter as people call it,
// in the reader's language: the framework's meters in its own phrases, a module's meter by the
// label it declares. And one use that jumps past both levels of a cap says only the higher one:
// the pause, never "low" beside it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, makeOperator, me, Person, pool, shutdown } from '../../dist/testing.js';
import { creditsApp } from '../fixture/dist/features/credits/index.js';

// Connections keep their credentials sealed with it; set before the app reads its configuration.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';

const ENV = ['CREDITS_CONFIG'];
const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

const mia = new Person('Mia Words'); // a tool-call limit
const rao = new Person('Rao Words'); // a module meter's limit
const lin = new Person('Lin Words'); // one use past what is left: the wallet below zero
const opal = new Person('Opal Words'); // a platform operator holding platform.credits
const tenant: Record<string, string> = {};

beforeAll(async () => {
  process.env.CREDITS_CONFIG = JSON.stringify({ currency: 'XXX', prices: { tool_calls: 100 } });
  await boot(creditsApp);
  for (const person of [mia, rao, lin]) {
    await person.signUp();
    tenant[person.name] = (await me(person)).tenantId;
  }
  await opal.signUp();
  await makeOperator(opal, ['platform.credits']);
});

afterAll(async () => {
  for (const n of ENV)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  await shutdown();
});

const setPlan = (person: Person, plan: object) =>
  opal.call('PUT', `/api/credits/operator/${tenant[person.name]}/settings`, plan);

type Meter = { meter: string; label?: string; refusal?: { reason: string } };
const meterOf = (status: { meters: Meter[] }, name: string) =>
  status.meters.find((m) => m.meter === name);

/** The `credits.threshold` events of a business, as `cap/level`, oldest first. */
async function thresholds(person: Person) {
  const { rows } = await pool.query(
    `select row->>'cap' as cap, row->>'level' as level from app.domain_events
     where tenant_id = $1 and name = 'credits.threshold' order by seq`,
    [tenant[person.name]],
  );
  return rows.map((r) => `${r.cap}/${r.level}`);
}

async function alertRows(person: Person) {
  const { rows } = await pool.query(
    `select cap, level from app.credit_alerts where tenant_id = $1 order by cap, level`,
    [tenant[person.name]],
  );
  return rows.map((r) => `${r.cap}/${r.level}`);
}

describe("a limit's refusal, in people's words", () => {
  it("names the framework's meter by its label, in the reader's language", async () => {
    const put = await setPlan(mia, {
      enforce: true,
      allowance: 1_000_000,
      limits: { tool_calls: 1 },
    });
    expect(put.status).toBe(200);
    expect((await mia.chat('add words task 1')).status).toBe(200);

    const en = (await mia.call('GET', '/api/credits')).body;
    expect(en.paused).toEqual({
      rule: 'usage_limit_reached',
      cap: 'tool_calls',
      reason: "Assistant actions: this period's limit is reached",
    });
    expect(meterOf(en, 'tool_calls')).toMatchObject({
      label: 'Assistant actions',
      refusal: { reason: en.paused.reason },
    });

    const hi = (await mia.call('GET', '/api/credits?lang=hi')).body;
    expect(hi.paused.reason).toBe('असिस्टेंट के काम: इस अवधि की सीमा पूरी हो गई');
    expect(meterOf(hi, 'tool_calls')?.label).toBe('असिस्टेंट के काम');
    const te = (await mia.call('GET', '/api/credits?lang=te')).body;
    expect(te.paused.reason).toBe('అసిస్టెంట్ చర్యలు: ఈ వ్యవధి పరిమితి పూర్తయింది');
    // A language the application does not declare reads in English.
    expect((await mia.call('GET', '/api/credits?lang=xx')).body.paused.reason).toBe(
      en.paused.reason,
    );
    // The operator reads it too, in the language asked for.
    const op = await opal.call('GET', `/api/credits/operator/${tenant[mia.name]}?lang=hi`);
    expect(op.body.paused.reason).toBe(hi.paused.reason);

    // The next turn is refused with the same words: never the meter's internal name.
    const refused = await mia.chat('add words task 2');
    expect(refused.status).toBe(402);
    expect(refused.body.reason).toBe(en.paused.reason);
    expect(JSON.stringify(refused.body)).not.toMatch(/tool_calls|calls of/);
    // A turn in Hindi is refused in Hindi; a turn that names no language, in English.
    const inHindi = await mia.call('POST', '/api/chat/once', {
      message: 'add words task 3',
      lang: 'hi',
    });
    expect(inHindi.status).toBe(402);
    expect(inHindi.body.reason).toBe(hi.paused.reason);
  });

  it("names a module's meter by the label it declares", async () => {
    const put = await setPlan(rao, {
      enforce: true,
      allowance: 1_000_000,
      limits: { report_pages: 5 },
    });
    expect(put.status).toBe(200);
    const render = await rao.call('POST', '/api/credit-checks/render', { pages: 50 });
    expect(render.status).toBeLessThan(300);

    const en = (await rao.call('GET', '/api/credits')).body;
    expect(meterOf(en, 'report_pages')).toMatchObject({
      label: 'Report pages',
      refusal: { reason: "Report pages: this period's limit is reached" },
    });
    const te = (await rao.call('GET', '/api/credits?lang=te')).body;
    expect(meterOf(te, 'report_pages')).toMatchObject({
      label: 'రిపోర్ట్ పేజీలు',
      refusal: { reason: 'రిపోర్ట్ పేజీలు: ఈ వ్యవధి పరిమితి పూర్తయింది' },
    });
  });
});

describe('one use past both levels of a cap', () => {
  it('says only the pause; the alert is not said after it either', async () => {
    // 50 pages of a 5-page limit (previous test): 1000% in one use, past the alert and the pause.
    expect(await alertRows(rao)).toEqual(['report_pages/alert', 'report_pages/pause']);
    expect(await thresholds(rao)).toEqual(['report_pages/pause']);
    // More use while paused says nothing more.
    await rao.call('POST', '/api/credit-checks/render', { pages: 1 });
    expect(await thresholds(rao)).toEqual(['report_pages/pause']);
    // The event names the meter as people do, in each language, for whoever words the alert.
    const { rows } = await pool.query(
      `select row->'label' as label from app.domain_events
       where tenant_id = $1 and name = 'credits.threshold'`,
      [tenant[rao.name]],
    );
    expect(rows[0].label).toMatchObject({
      en: 'Report pages',
      hi: 'रिपोर्ट पेज',
      te: 'రిపోర్ట్ పేజీలు',
    });
  });

  it('a cap that passes its levels one at a time says each', async () => {
    const put = await setPlan(mia, {
      enforce: true,
      allowance: 1_000_000,
      limits: { tool_calls: 1, report_pages: 10 },
    });
    expect(put.status).toBe(200);
    await mia.call('POST', '/api/credit-checks/render', { pages: 8 });
    await mia.call('POST', '/api/credit-checks/render', { pages: 2 });
    expect((await thresholds(mia)).filter((t) => t.startsWith('report_pages/'))).toEqual([
      'report_pages/alert',
      'report_pages/pause',
    ]);
  });
});

describe('one use past what is left', () => {
  it("the budget's reason and share read 100%, never past it", async () => {
    expect((await setPlan(lin, { enforce: true, allowance: 1 })).status).toBe(200);
    const grant = await opal.call('POST', `/api/credits/operator/${tenant[lin.name]}/grants`, {
      amount: 50,
      note: 'Welcome credits',
    });
    expect(grant.status).toBe(201);
    // One tool call at 100: 1 from the allowance, 99 from a wallet of 50, which ends at -49.
    expect((await lin.chat('add overshoot task')).status).toBe(200);

    const en = (await lin.call('GET', '/api/credits')).body;
    expect(en).toMatchObject({
      usedPercent: 100,
      balance: -49,
      paused: {
        rule: 'credits_exhausted',
        reason: 'This business has used 100% of its credits this period',
      },
    });
    const hi = (await lin.call('GET', '/api/credits?lang=hi')).body;
    expect(hi.paused.reason).toBe('इस व्यवसाय ने इस अवधि में अपने क्रेडिट का 100% उपयोग कर लिया है');
    const refused = await lin.chat('add one more overshoot task');
    expect(refused.status).toBe(402);
    expect(refused.body.reason).toBe(en.paused.reason);
  });

  it("the ledger names a use's meter as people call it, never by its name in the code", async () => {
    type Entry = { kind: string; amount: number; note: string | null; use?: object };
    const items = async (path: string, who = lin): Promise<Entry[]> => {
      const res = await who.call('GET', path);
      expect(res.status).toBe(200);
      return res.body.items;
    };
    const en = await items('/api/credits/ledger');
    expect(en.find((e) => e.kind === 'debit')).toMatchObject({
      amount: -99,
      note: null,
      use: { meter: 'tool_calls', label: 'Assistant actions', quantity: 1 },
    });
    // A grant keeps the words its operator wrote.
    expect(en.find((e) => e.kind === 'grant')).toMatchObject({
      amount: 50,
      note: 'Welcome credits',
    });
    expect(JSON.stringify(en)).not.toMatch(/tool_calls ×/);
    // In the reader's language: the business's people and the operator.
    const hi = await items('/api/credits/ledger?lang=hi');
    expect(hi.find((e) => e.kind === 'debit')?.use).toMatchObject({ label: 'असिस्टेंट के काम' });
    const te = await items(`/api/credits/operator/${tenant[lin.name]}/ledger?lang=te`, opal);
    expect(te.find((e) => e.kind === 'debit')?.use).toMatchObject({ label: 'అసిస్టెంట్ చర్యలు' });
  });
});
