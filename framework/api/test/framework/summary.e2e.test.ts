// Summaries (B14): counts and totals grouped by up to two fields, over exactly the rows a list
// reaches, never over a field the reader cannot see; the agent's summarize tool and kpi.row
// tiles computed from a summary, on the fixture's entries (fixture/src/features/summary).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { summaryServer } from '../fixture/dist/features/summary/index.js';

const owner = new Person('Owner Summary');
const staff = new Person('Staff Summary');
const idle = new Person('Idle Summary');
const ops = new Person('Ops Summary');
const other = new Person('Other Summary');
const empty = new Person('Empty Summary');
let tenantId = '';

const inOwner = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });
const eur = (minor: number) => ({ minor, currency: 'EUR' });
const usd = (minor: number) => ({ minor, currency: 'USD' });

async function add(p: Person, entry: Record<string, unknown>, inTenant = true) {
  const res = inTenant
    ? await inOwner(p)('POST', '/api/entries', entry)
    : await p.call('POST', '/api/entries', entry);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

beforeAll(async () => {
  await boot(summaryServer);
  for (const p of [owner, staff, idle, ops, other, empty]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(idle, tenantId, ['staff']);
  await addMember(ops, tenantId, ['ops']);
  // The business works in Berlin: 23:30 UTC on 31 October is 1 November there.
  await pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
    tenantId,
    JSON.stringify({ timeZone: 'Europe/Berlin' }),
  ]);
  await add(owner, {
    title: 'Alpha',
    state: 'draft',
    flagged: true,
    currency: 'EUR',
    amount: { minor: 1000 },
    units: 2,
    margin: 100,
    bookedAt: '2026-10-31T23:30:00Z',
    dueOn: '2026-11-02',
  });
  await add(owner, {
    title: 'Beta',
    state: 'done',
    currency: 'EUR',
    amount: { minor: 2500 },
    units: 5,
    margin: 300,
    bookedAt: '2026-10-15T10:00:00Z',
    dueOn: '2026-10-20',
  });
  await add(owner, {
    title: 'Gamma',
    state: 'done',
    currency: 'EUR',
    amount: { minor: 501 },
    units: 1,
    bookedAt: '2026-11-05T10:00:00Z',
  });
  await add(owner, {
    title: 'Delta',
    state: 'void',
    currency: 'USD',
    amount: { minor: 700 },
    units: 3,
  });
  await add(staff, {
    title: 'Staff one',
    state: 'draft',
    currency: 'EUR',
    amount: { minor: 300 },
    units: 4,
  });
  await add(
    other,
    { title: 'Theirs', state: 'done', currency: 'EUR', amount: { minor: 9999 } },
    false,
  );
});
afterAll(shutdown);

const summary = (p: Person, query: string) => inOwner(p)('GET', `/api/entries/summary?${query}`);

describe('counts and totals', () => {
  it('without groups: the count of every record the reader reaches', async () => {
    const res = await summary(owner, '');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [], totals: [{ key: {}, count: 5 }], more: false });
  });

  it('by a value, keys in order', async () => {
    const res = await summary(owner, 'groupBy=state');
    expect(res.body.groups).toEqual([
      { key: { state: 'done' }, count: 2 },
      { key: { state: 'draft' }, count: 2 },
      { key: { state: 'void' }, count: 1 },
    ]);
    expect(res.body.totals).toEqual([{ key: {}, count: 5 }]);
  });

  it('money is summed per currency, never across two', async () => {
    const res = await summary(owner, 'groupBy=state&sum=amount');
    expect(res.body.groups).toEqual([
      { key: { state: 'done', currency: 'EUR' }, count: 2, sum: { amount: eur(3001) } },
      { key: { state: 'draft', currency: 'EUR' }, count: 2, sum: { amount: eur(1300) } },
      { key: { state: 'void', currency: 'USD' }, count: 1, sum: { amount: usd(700) } },
    ]);
    expect(res.body.totals).toEqual([
      { key: { currency: 'EUR' }, count: 4, sum: { amount: eur(4301) } },
      { key: { currency: 'USD' }, count: 1, sum: { amount: usd(700) } },
    ]);
  });

  it('a money average is whole minor units, rounded half up', async () => {
    const res = await summary(owner, 'state=done&avg=amount&min=amount&max=amount');
    expect(res.body.totals).toEqual([
      {
        key: { currency: 'EUR' },
        count: 2,
        avg: { amount: eur(1501) },
        min: { amount: eur(501) },
        max: { amount: eur(2500) },
      },
    ]);
  });

  it('numbers: sum, average, lowest and highest', async () => {
    const res = await summary(owner, 'sum=units&avg=units&min=units&max=units');
    expect(res.body.totals).toEqual([
      {
        key: {},
        count: 5,
        sum: { units: 15 },
        avg: { units: 3 },
        min: { units: 1 },
        max: { units: 5 },
      },
    ]);
  });

  it('by a boolean, and by two fields', async () => {
    const flagged = await summary(owner, 'groupBy=flagged&sum=units');
    expect(flagged.body.groups).toEqual([
      { key: { flagged: false }, count: 4, sum: { units: 13 } },
      { key: { flagged: true }, count: 1, sum: { units: 2 } },
    ]);
    const two = await summary(owner, 'groupBy=state,flagged');
    expect(two.body.groups).toHaveLength(4);
    expect(two.body.groups[0]).toEqual({ key: { state: 'done', flagged: false }, count: 2 });
  });
});

describe('dates, in the business’s time zone', () => {
  it('by month: 23:30 UTC on 31 October counts in November in Berlin', async () => {
    const res = await summary(owner, 'groupBy=bookedAt:month');
    expect(res.body.groups).toEqual([
      { key: { bookedAt: '2026-10' }, count: 1 },
      { key: { bookedAt: '2026-11' }, count: 2 },
      { key: { bookedAt: null }, count: 2 },
    ]);
  });

  it('by day, ISO week (its Monday), quarter and year', async () => {
    const day = await summary(owner, 'groupBy=bookedAt:day&bookedAt[gte]=2026-10-31');
    expect(day.body.groups.map((g: { key: object }) => g.key)).toEqual([
      { bookedAt: '2026-11-01' },
      { bookedAt: '2026-11-05' },
    ]);
    const week = await summary(owner, 'groupBy=dueOn:week');
    expect(week.body.groups.map((g: { key: object }) => g.key)).toEqual([
      { dueOn: '2026-10-19' },
      { dueOn: '2026-11-02' },
      { dueOn: null },
    ]);
    const quarter = await summary(owner, 'groupBy=bookedAt:quarter&bookedAt[gte]=2026-01-01');
    expect(quarter.body.groups).toEqual([{ key: { bookedAt: '2026-Q4' }, count: 3 }]);
    const year = await summary(owner, 'groupBy=dueOn:year&dueOn[gte]=2026-01-01');
    expect(year.body.groups).toEqual([{ key: { dueOn: '2026' }, count: 2 }]);
  });
});

describe('order, limit and filters', () => {
  it('by count, descending, cut at the limit (more says so)', async () => {
    const res = await summary(owner, 'groupBy=state&sort=-count&limit=1');
    expect(res.body.groups).toEqual([{ key: { state: 'done' }, count: 2 }]);
    expect(res.body.more).toBe(true);
    expect(res.body.totals[0].count).toBe(5);
  });

  it('by a measure, and by key descending', async () => {
    // done and draft both total 6 units: the key breaks the tie.
    const byMeasure = await summary(owner, 'groupBy=state&sum=units&sort=sum:units');
    expect(byMeasure.body.groups.map((g: { key: { state: string } }) => g.key.state)).toEqual([
      'void',
      'done',
      'draft',
    ]);
    const byKey = await summary(owner, 'groupBy=state&sort=-key');
    expect(byKey.body.groups.map((g: { key: { state: string } }) => g.key.state)).toEqual([
      'void',
      'draft',
      'done',
    ]);
  });

  it('the list’s filters and search narrow it', async () => {
    expect((await summary(owner, 'amount[gte]=1000')).body.totals[0].count).toBe(2);
    expect((await summary(owner, 'state[in]=done,void')).body.totals[0].count).toBe(3);
    expect((await summary(owner, 'q=alp')).body.totals[0].count).toBe(1);
    const json = await inOwner(owner)('GET', `/api/entries/summary?state[ne]=void&groupBy=state`);
    expect(json.body.groups).toHaveLength(2);
  });

  it('a request outside the grammar is a 400', async () => {
    for (const q of [
      'groupBy=margin',
      'groupBy=bookedAt',
      'groupBy=bookedAt:hour',
      'groupBy=state,flagged,title',
      'groupBy=bookedAt:month,bookedAt:day',
      'sum=state',
      'sum=units,amount&avg=units,amount&min=units,amount&max=units',
      'sort=total',
      'groupBy=state&sort=sum:units',
      'limit=500',
      'nope=1',
    ])
      expect((await summary(owner, q)).status, q).toBe(400);
  });
});

describe('scope', () => {
  it('another business’s records are never counted', async () => {
    const mine = await summary(owner, 'sum=amount');
    expect(
      mine.body.totals.find((t: { key: { currency: string } }) => t.key.currency === 'EUR'),
    ).toMatchObject({ count: 4, sum: { amount: eur(4301) } });
    const theirs = await other.call('GET', '/api/entries/summary?sum=amount');
    expect(theirs.body.totals).toEqual([
      { key: { currency: 'EUR' }, count: 1, sum: { amount: eur(9999) } },
    ]);
  });

  it('a business with no records: one zero bucket, measures null', async () => {
    const res = await empty.call('GET', '/api/entries/summary?sum=amount&groupBy=state');
    expect(res.body).toEqual({
      groups: [],
      totals: [{ key: {}, count: 0, sum: { amount: null } }],
      more: false,
    });
  });

  it('staff count only their own records, as their lists show', async () => {
    const res = await summary(staff, 'groupBy=state&sum=amount');
    expect(res.body.totals).toEqual([
      { key: { currency: 'EUR' }, count: 1, sum: { amount: eur(300) } },
    ]);
  });
});

describe('hidden fields', () => {
  it('a field policy: no sum of a margin the reader cannot see', async () => {
    for (const who of [staff, ops]) {
      const res = await summary(who, 'sum=margin');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'forbidden', rule: 'field_hidden' });
      expect(res.body.reason).toContain('Margin');
    }
    expect((await summary(owner, 'sum=margin')).body.totals[0].sum).toEqual({ margin: 400 });
  });

  it('nor a filter on it, even one nothing matches', async () => {
    for (const q of ['margin[gt]=100000', 'margin[gt]=0&groupBy=state']) {
      const res = await summary(staff, q);
      expect(res.status, q).toBe(403);
      expect(res.body.rule).toBe('field_hidden');
    }
  });

  it('a read projector: staff cannot total the units their records never show', async () => {
    const record = await inOwner(staff)('GET', '/api/entries');
    expect(record.body.items[0]).not.toHaveProperty('units');
    const res = await summary(staff, 'sum=units');
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('field_hidden');
    // Ops see units: the projector hides them from staff only.
    expect((await summary(ops, 'sum=units')).body.totals[0].sum).toEqual({ units: 15 });
  });

  it('a reader who reaches no record gets zeros, which reveal nothing', async () => {
    const res = await summary(idle, 'sum=units');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual([{ key: {}, count: 0, sum: { units: null } }]);
  });
});

describe('who may summarize', () => {
  it('the assistant, where it may list', async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const res = await asks('GET', '/api/entries/summary?groupBy=state');
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(3);
  });

  it('a people-only list: people only', async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const refused = await asks('GET', '/api/tallies/summary');
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('humans_only');
    expect((await owner.call('GET', '/api/tallies/summary')).body.totals[0].count).toBe(5);
  });

  it('an internal list has no summary route', async () => {
    expect((await owner.call('GET', '/api/ledgers/summary')).status).toBe(404);
  });
});

describe('the summarize tool and kpi.row', () => {
  it('the assistant counts with the tool; the tiles are computed, not typed', async () => {
    const res = await owner.chat('count entries by state', undefined, ['inline']);
    expect(res.body.toolCalls.map((t: { tool: string }) => t.tool)).toEqual(['summarize-entries']);
    expect(res.body.toolCalls[0].present).toEqual({
      kind: 'inline',
      view: 'kpi.row',
      props: { of: { entity: 'entries', query: { groupBy: ['state'], sort: '-count' } } },
    });
    expect(res.body.reply).toBe('5 entries in all.');
  });

  it('in words, the tiles are computed for the reader', async () => {
    const res = await owner.chat('count entries by state', undefined, ['text']);
    expect(res.body.toolCalls[0].present).toEqual({
      kind: 'text',
      text: 'done: 2\ndraft: 2\nvoid: 1',
    });
    const spoken = await staff.chat('count entries by state', undefined, ['text']);
    // Staff, in their own business, reach no entries there.
    expect(spoken.body.reply).toBe('0 entries in all.');
  });

  it('a saved page keeps the query, checked against the summary grammar', async () => {
    const block = (query: object) => ({
      name: `Numbers ${JSON.stringify(query).length}`,
      spec: {
        title: 'Numbers',
        blocks: [{ id: 'kpis', view: 'kpi.row', props: { of: { entity: 'entries', query } } }],
      },
    });
    const saved = await owner.call('POST', '/api/pages', block({ groupBy: ['state'] }));
    expect(saved.status).toBe(201);
    expect(saved.body.value.spec.blocks[0].props).toEqual({
      of: { entity: 'entries', query: { groupBy: ['state'] } },
    });
    for (const bad of [{ groupBy: ['margin'] }, { sum: ['state'] }, { nope: 1 }]) {
      const res = await owner.call('POST', '/api/pages', block(bad));
      expect(res.status, JSON.stringify(bad)).toBe(403);
      expect(res.body.rule).toBe('bad_spec');
    }
    const unknown = await owner.call('POST', '/api/pages', {
      name: 'Unknown',
      spec: {
        title: 'Unknown',
        blocks: [{ id: 'kpis', view: 'kpi.row', props: { of: { entity: 'nopes', query: {} } } }],
      },
    });
    expect(unknown.body.rule).toBe('bad_spec');
    const internal = await owner.call('POST', '/api/pages', {
      name: 'Internal',
      spec: {
        title: 'Internal',
        blocks: [{ id: 'kpis', view: 'kpi.row', props: { of: { entity: 'ledgers' } } }],
      },
    });
    expect(internal.body.rule).toBe('bad_spec');
    const both = await owner.call('POST', '/api/pages', {
      name: 'Both',
      spec: {
        title: 'Both',
        blocks: [
          {
            id: 'kpis',
            view: 'kpi.row',
            props: { items: [{ label: 'x', value: 1 }], of: { entity: 'entries' } },
          },
        ],
      },
    });
    expect(both.body.rule).toBe('bad_spec');
  });
});
