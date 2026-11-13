// Money in minor units with a currency, and gapless number series (B3), on the fixture's
// baskets (fixture/src/features/line-items).
import { execFileSync } from 'node:child_process';
import { formatNumber, type Money, numberPeriod, type Principal } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  defaultCurrency,
  defaultTimeZone,
  nextNumber,
  setDefaultCurrency,
  setDefaultTimeZone,
} from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import {
  BasketSeries,
  lineItems,
  UnregisteredSeries,
} from '../fixture/dist/features/line-items/index.js';

const owner = new Person('Owner Money');
const other = new Person('Other Money');
const admin = new Person('Admin Money');
let tenantId = '';
let otherTenant = '';

const db = () => {
  if (!server.app) throw new Error('The app is not booted');
  return (server.app.get(CORE_OPTIONS, { strict: false }) as CoreOptions).db;
};

const principalOf = (person: Person, tenant: string): Principal => ({
  actor: { kind: 'user', id: person.id },
  subject: { kind: 'user', userId: person.id },
  tenantId: tenant,
  roles: ['owner'],
  assurance: 'session',
  scopes: [],
});

const setMoney = (tenant: string, money: object, more: object = {}) =>
  setTenantSettings(tenant, { money, ...more });

const eur = (minor: number): Money => ({ minor, currency: 'EUR' });

const audit = async (action: string, rule: string) =>
  (
    await pool.query(
      'select outcome, rule from audit.events where tenant_id = $1 and action = $2 and rule = $3',
      [tenantId, action, rule],
    )
  ).rows;

beforeAll(async () => {
  await boot(lineItems);
  for (const p of [owner, other, admin]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  otherTenant = (await me(other)).tenantId;
  await addMember(admin, tenantId, ['admin']);
});
afterAll(shutdown);

describe('the business currency', () => {
  it('is the deployment default, else XXX, until the business sets its own', async () => {
    const was = defaultCurrency();
    try {
      setDefaultCurrency(undefined);
      expect((await owner.call('GET', '/api/money')).body).toMatchObject({
        currency: 'XXX',
        fyStartMonth: 1,
      });
      setDefaultCurrency('JPY');
      expect((await owner.call('GET', '/api/money')).body).toMatchObject({
        currency: 'JPY',
        exponent: 0,
      });
      await setMoney(tenantId, { currency: 'EUR', fyStartMonth: 4 }, { timeZone: 'Asia/Tokyo' });
      expect((await owner.call('GET', '/api/money')).body).toEqual({
        currency: 'EUR',
        exponent: 2,
        fyStartMonth: 4,
        timeZone: 'Asia/Tokyo',
      });
      // Another business still has none of its own.
      expect((await other.call('GET', '/api/money')).body.currency).toBe('JPY');
    } finally {
      setDefaultCurrency(was === 'XXX' ? undefined : was);
    }
  });

  it('never shows named amounts or bands', async () => {
    await setMoney(tenantId, {
      currency: 'EUR',
      fyStartMonth: 4,
      amounts: { 'baskets.limit': eur(100) },
      bands: { 'baskets.size': [eur(10), eur(100)] },
    });
    const res = await owner.call('GET', '/api/money');
    expect(res.body).not.toHaveProperty('amounts');
    expect(res.body).not.toHaveProperty('bands');
  });
});

describe('money on a record', () => {
  it('is written as a decimal or minor units, stored as minor units and read as Money', async () => {
    const made = await owner.call('POST', '/api/baskets', {
      title: 'Plain',
      currency: 'EUR',
      total: '12.5',
    });
    expect(made.status).toBe(201);
    expect(made.body.value).toMatchObject({ currency: 'EUR', total: eur(1250), taxTotal: eur(0) });
    const { rows } = await pool.query(
      'select total, tax_total, currency from app.fixture_baskets where id = $1',
      [made.body.value.id],
    );
    expect(rows[0]).toEqual({ total: '1250', tax_total: '0', currency: 'EUR' });
    const patched = await owner.call('PATCH', `/api/baskets/${made.body.value.id}`, {
      total: { minor: 99 },
    });
    expect(patched.body.value.total).toEqual(eur(99));
  });

  it('refuses two currencies, a change of currency, none at all, and digits the currency lacks', async () => {
    const mixed = await owner.call('POST', '/api/baskets', {
      title: 'Mixed',
      currency: 'EUR',
      total: { minor: 5, currency: 'JPY' },
    });
    expect(mixed.status).toBe(403);
    expect(mixed.body.rule).toBe('currency_mismatch');
    expect(await audit('basket.create', 'currency_mismatch')).toEqual([
      { outcome: 'denied', rule: 'currency_mismatch' },
    ]);

    const none = await owner.call('POST', '/api/baskets', { title: 'None', total: '1' });
    expect(none.body.rule).toBe('currency_required');

    const made = await owner.call('POST', '/api/baskets', { title: 'Fixed', currency: 'EUR' });
    const id = made.body.value.id;
    const moved = await owner.call('PATCH', `/api/baskets/${id}`, { currency: 'JPY' });
    expect(moved.body.rule).toBe('currency_fixed');
    const tooFine = await owner.call('PATCH', `/api/baskets/${id}`, { total: '1.234' });
    expect(tooFine.status).toBe(403);
    expect(tooFine.body.rule).toBe('money_invalid');
    // A bare number could be either unit: the schema refuses it.
    const bare = await owner.call('PATCH', `/api/baskets/${id}`, { total: 12.5 });
    expect(bare.status).toBe(400);
  });

  it('filters and sorts on minor units, and refuses a decimal filter', async () => {
    for (const total of ['1000.00', '20.00', '300.00'])
      await owner.call('POST', '/api/baskets', { title: `Sort ${total}`, currency: 'EUR', total });
    const res = await owner.call('GET', '/api/baskets?total[gte]=2000&sort=-total');
    const totals = res.body.items.map((b: { total: Money }) => b.total.minor);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(totals).toContain(100000);
    expect(totals).toContain(30000);
    expect(totals.every((t: number) => t >= 2000)).toBe(true);
    expect((await owner.call('GET', '/api/baskets?total[gte]=20.5')).status).toBe(400);
  });

  it("another business's basket is a 404, whatever it holds", async () => {
    const made = await owner.call('POST', '/api/baskets', {
      title: 'Mine',
      currency: 'EUR',
      total: '5',
    });
    const id = made.body.value.id;
    expect((await other.call('GET', `/api/baskets/${id}`)).status).toBe(404);
    expect((await other.call('PATCH', `/api/baskets/${id}`, { total: '1' })).status).toBe(404);
    const list = await other.call('GET', '/api/baskets');
    expect(list.body.items.map((b: { id: string }) => b.id)).not.toContain(id);
  });
});

describe('number series', () => {
  const save = (person: Person, title: string, items: object[] = [], extra: object = {}) =>
    person.call('POST', '/api/baskets/save', { title, items, ...extra });

  it('numbers a saved basket from its series, in the business zone and financial year', async () => {
    await setMoney(tenantId, { currency: 'EUR', fyStartMonth: 4 }, { timeZone: 'Asia/Tokyo' });
    const res = await save(owner, 'Numbered', [{ ref: 'a', title: 'A', price: '2.00' }]);
    expect(res.status).toBe(200);
    const settings = { timeZone: 'Asia/Tokyo', fyStartMonth: 4 };
    const now = new Date();
    const { rows } = await pool.query(
      'select last from app.number_series where tenant_id = $1 and series = $2 and period = $3',
      [tenantId, BasketSeries.name, numberPeriod(BasketSeries, now, settings)],
    );
    expect(res.body.value.basket.number).toBe(
      formatNumber(BasketSeries, Number(rows[0].last), now, settings),
    );
    expect(res.body.value.basket.number).toMatch(/^B\d{4}-\d{2}-\d{3}$/);
  });

  it('gives concurrent saves 1..N with no gap and no repeat, per business', async () => {
    await setMoney(otherTenant, { currency: 'EUR' });
    const saves = await Promise.all(
      Array.from({ length: 8 }, (_, i) => save(other, `Concurrent ${i}`)),
    );
    expect(saves.every((r) => r.status === 200)).toBe(true);
    const seqs = saves
      .map((r) => Number(String(r.body.value.basket.number).split('-').at(-1)))
      .sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a save that fails gives its number back', async () => {
    const before = await save(other, 'Before');
    // The item's rule refuses after the number was taken: the whole save rolls back.
    const failed = await save(other, 'Fails', [{ ref: 'a', title: '[refuse] this', price: '1' }]);
    expect(failed.status).toBe(403);
    expect(failed.body.rule).toBe('item_refused');
    const after = await save(other, 'After');
    const seq = (r: { body: { value: { basket: { number: string } } } }) =>
      Number(r.body.value.basket.number.split('-').at(-1));
    expect(seq(after)).toBe(seq(before) + 1);
  });

  it('a parked save takes no number; approved, it takes the next; rejected, never', async () => {
    const first = await save(other, 'Direct');
    const asks = asAssistant(`user:${other.id}`, { 'x-channel': 'app' });
    const parked = await asks('POST', '/api/baskets/save', { title: 'Asked', items: [] });
    expect(parked.body.status).toBe('needs_approval');
    const rejected = await asks('POST', '/api/baskets/save', { title: 'Refused', items: [] });
    const rejection = await other.call(
      'POST',
      `/api/approvals/${rejected.body.approval.id}/reject`,
    );
    expect(rejection.body.status).toBe('rejected');
    const approved = await other.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    const { rows } = await pool.query(
      'select title, number from app.fixture_baskets where tenant_id = $1 and title in ($2, $3, $4)',
      [otherTenant, 'Direct', 'Asked', 'Refused'],
    );
    const numberOf = (t: string) => rows.find((r) => r.title === t)?.number as string | undefined;
    const seq = (n: string) => Number(n.split('-').at(-1));
    expect(numberOf('Refused')).toBeUndefined();
    expect(seq(numberOf('Asked') as string)).toBe(seq(first.body.value.basket.number) + 1);
  });

  it('refuses a series nobody registered', async () => {
    await expect(
      db().transaction((tx) => nextNumber(tx, principalOf(owner, tenantId), UnregisteredSeries)),
    ).rejects.toThrow(/not registered/);
    await expect(
      db().transaction((tx) =>
        nextNumber(tx, principalOf(owner, tenantId), { ...BasketSeries, format: 'X{seq}' }),
      ),
    ).rejects.toThrow(/another format/);
  });

  it('a rolled-back transaction gives its number back', async () => {
    const p = principalOf(owner, tenantId);
    const taken = await db().transaction((tx) => nextNumber(tx, p, BasketSeries));
    await expect(
      db().transaction(async (tx) => {
        await nextNumber(tx, p, BasketSeries);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    const next = await db().transaction((tx) => nextNumber(tx, p, BasketSeries));
    expect(next.seq).toBe(taken.seq + 1);
  });

  it("a business without a zone of its own numbers in the deployment's, else UTC", async () => {
    // 20:00 UTC on 31 March is 1 April in Tokyo: the next financial year there.
    const at = new Date('2027-03-31T20:00:00Z');
    const fresh = new Person('Fresh Money');
    await fresh.signUp();
    const freshTenant = (await me(fresh)).tenantId;
    await setMoney(freshTenant, { currency: 'EUR', fyStartMonth: 4 });
    const p = principalOf(fresh, freshTenant);
    const was = defaultTimeZone();
    try {
      setDefaultTimeZone('Asia/Tokyo');
      expect((await fresh.call('GET', '/api/money')).body.timeZone).toBe('Asia/Tokyo');
      const tokyo = await db().transaction((tx) => nextNumber(tx, p, BasketSeries, at));
      expect(tokyo).toMatchObject({ period: 'FY2027', number: 'B2027-28-001' });
      setDefaultTimeZone(undefined);
      expect((await fresh.call('GET', '/api/money')).body.timeZone).toBe('UTC');
      const utc = await db().transaction((tx) => nextNumber(tx, p, BasketSeries, at));
      expect(utc).toMatchObject({ period: 'FY2026', number: 'B2026-27-001' });
    } finally {
      setDefaultTimeZone(was === 'UTC' ? undefined : was);
    }
  });
});

describe('a currency that does not exist (V4)', () => {
  const save = (title: string, items: object[] = [], extra: object = {}) =>
    owner.call('POST', '/api/baskets/save', { title, items, ...extra });
  const seq = (r: { body: { value: { basket: { number: string } } } }) =>
    Number(r.body.value.basket.number.split('-').at(-1));
  const titled = async (title: string) =>
    (
      await pool.query('select id from app.fixture_baskets where tenant_id = $1 and title = $2', [
        tenantId,
        title,
      ])
    ).rows;

  beforeAll(() => setMoney(tenantId, { currency: 'EUR' }));

  it('a plain create in a made-up currency is refused, audited, and writes nothing', async () => {
    const cases = [
      { title: 'Made up', currency: 'ABC', total: '1.00' },
      { title: 'Made up, no amount', currency: 'QZX' },
      { title: 'Made up, minor units', total: { minor: 100, currency: 'ABC' } },
    ];
    for (const body of cases) {
      const res = await owner.call('POST', '/api/baskets', body);
      expect(res.status, body.title).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden', rule: 'money_invalid' });
      expect(res.body.reason).toMatch(/^"(ABC|QZX)" is not a currency$/);
      expect(await titled(body.title)).toEqual([]);
    }
    const denied = await audit('basket.create', 'money_invalid');
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((a) => a.outcome === 'denied')).toBe(true);
    // XXX is ISO's "no currency", which a business that set none counts in.
    const none = await owner.call('POST', '/api/baskets', { title: 'In XXX', currency: 'XXX' });
    expect(none.status).toBe(201);
  });

  it("a command's write is refused too, and gives its number back", async () => {
    const before = await save('Before ABC');
    expect(before.status).toBe(200);
    // No priced line: nothing resolves an amount, so the plugin refuses the insert in run.
    const failed = await save('In ABC', [], { currency: 'ABC' });
    expect(failed.status).toBe(403);
    expect(failed.body).toMatchObject({ rule: 'money_invalid', reason: '"ABC" is not a currency' });
    expect(await titled('In ABC')).toEqual([]);
    const after = await save('After ABC');
    expect(seq(after)).toBe(seq(before) + 1);
  });

  it('a row stored with one before still reads, sums and changes, but takes no new amount', async () => {
    const made = await owner.call('POST', '/api/baskets', {
      title: 'Stored ABC',
      currency: 'EUR',
      total: '1.00',
    });
    const id = made.body.value.id;
    await pool.query(`update app.fixture_baskets set currency = 'ABC' where id = $1`, [id]);
    const got = await owner.call('GET', `/api/baskets/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.total).toEqual({ minor: 100, currency: 'ABC' });
    const list = await owner.call('GET', '/api/baskets?total[eq]=100');
    expect(list.body.items.map((b: { id: string }) => b.id)).toContain(id);
    const sums = await owner.call('GET', '/api/baskets/summary?sum=total');
    expect(sums.status).toBe(200);
    expect(sums.body.totals).toContainEqual({
      key: { currency: 'ABC' },
      count: 1,
      sum: { total: { minor: 100, currency: 'ABC' } },
    });
    const renamed = await owner.call('PATCH', `/api/baskets/${id}`, { title: 'Stored ABC, kept' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.value.title).toBe('Stored ABC, kept');
    const priced = await owner.call('PATCH', `/api/baskets/${id}`, { total: '2.00' });
    expect(priced.status).toBe(403);
    expect(priced.body).toMatchObject({ rule: 'money_invalid' });
    expect(priced.body.reason).toContain('"ABC" is not a currency');
  });

  it('DEFAULT_CURRENCY must be a currency the runtime knows', () => {
    const config = new URL('../../dist/config.js', import.meta.url).href;
    const startWith = (code: string) => {
      try {
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const { assertConfig } = await import(${JSON.stringify(config)}); assertConfig();`,
          ],
          { env: { ...process.env, DEFAULT_CURRENCY: code }, stdio: 'pipe' },
        );
        return 'started';
      } catch (e) {
        return String((e as { stderr?: Buffer }).stderr ?? e);
      }
    };
    for (const code of ['ABC', 'eur']) expect(startWith(code), code).toContain('DEFAULT_CURRENCY');
    for (const code of ['JPY', 'XXX']) expect(startWith(code), code).toBe('started');
  });
});
