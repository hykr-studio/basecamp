// A keyset page never repeats or skips a row that shares its time (docs/decisions/V12.md).
// Postgres keeps microseconds and a JavaScript Date milliseconds: a cursor cut on the Date took
// its own row again ascending (a walk at limit=1 never ended) and skipped the rest of that
// millisecond descending. Rows written in one transaction share their time exactly. Every keyset
// read is walked here to its end, at limit=1 and 2, and must show each row exactly once, in the
// order Postgres gives: the entity lists (every sort), the inbox, agent runs, the credits ledger,
// the integrations delivery log and the platform routing log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, makeOperator, me, Person, pool, shutdown } from '../../dist/testing.js';
import { fixture } from '../fixture/dist/index.js';

const owner = new Person('Owner Keyset');
let tenantId = '';

/**
 * Seven times: three rows of one transaction (one time), one before them and one after within
 * the same millisecond, the next millisecond, and the next day.
 */
const TIMES = [
  '2026-01-01 00:00:00.0005+00',
  '2026-01-01 00:00:00.0005+00',
  '2026-01-01 00:00:00.0005+00',
  '2026-01-01 00:00:00.0001+00',
  '2026-01-01 00:00:00.0009+00',
  '2026-01-01 00:00:00.001+00',
  '2026-01-02 00:00:00+00',
];
/** Due days for the two-key sorts: some none, some shared. */
const DUE = ['2026-02-01', null, '2026-02-01', null, '2026-02-01', null, '2026-02-02'];

const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (text: string) => Buffer.from(text).toString('base64url');

type Page = { ids: string[]; next: string | null; status: number; body: unknown };

/**
 * Pages until there is no next, collecting ids in the order shown. Ends after 60 pages: a walk
 * that never advanced (the ascending defect) fails here rather than hanging.
 */
async function walk(page: (next: string | null) => Promise<Page>, first: string | null = null) {
  const seen: string[] = [];
  let next = first;
  for (let i = 0; i < 60; i++) {
    const p = await page(next);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    seen.push(...p.ids);
    next = p.next;
    if (!next) return seen;
  }
  throw new Error(`the walk never ended: ${seen.length} rows over 60 pages`);
}

const ids = async (sql: string, params: unknown[]) =>
  (await pool.query(sql, params)).rows.map((r: { id: string }) => r.id);

beforeAll(async () => {
  await boot(fixture);
  await owner.signUp();
  tenantId = (await me(owner)).tenantId;
});
afterAll(shutdown);

describe('entity lists', () => {
  const titles: Record<string, string> = {};

  beforeAll(async () => {
    for (let i = 0; i < TIMES.length; i++) {
      const res = await owner.call('POST', '/api/tasks', { title: `Task ${i}` });
      expect(res.status).toBe(201);
      titles[res.body.value.id] = `Task ${i}`;
      await pool.query('update app.fixture_tasks set created_at = $2, due_on = $3 where id = $1', [
        res.body.value.id,
        TIMES[i],
        DUE[i],
      ]);
    }
  });

  const list = (sort: string, limit: number) => async (cursor: string | null) => {
    const res = await owner.call(
      'GET',
      `/api/tasks?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    );
    return {
      status: res.status,
      body: res.body,
      ids: (res.body.items ?? []).map((t: { id: string }) => t.id),
      next: res.body.nextCursor ?? null,
    };
  };
  /** The order Postgres gives for this ORDER BY, which the list's id tie-break completes. */
  const order = (by: string) =>
    ids(`select id from app.fixture_tasks where tenant_id = $1 order by ${by}, id`, [tenantId]);

  const sorts: [string, string][] = [
    ['createdAt', 'created_at asc'],
    ['-createdAt', 'created_at desc'],
    // A time that is not the last key: rows at one time are told apart by the next key.
    ['createdAt,title', 'created_at asc, title asc'],
    ['-createdAt,-title', 'created_at desc, title desc'],
    // A time after a nullable key: its `same` branch carries the rows of one day.
    ['dueOn,createdAt', "coalesce(due_on, '9999-12-31') asc, created_at asc"],
    ['-dueOn,-createdAt', "coalesce(due_on, '0001-01-01') desc, created_at desc"],
  ];
  for (const [sort, by] of sorts)
    for (const limit of [1, 2])
      it(`sort=${sort} at limit=${limit} shows every row once, in order`, async () => {
        expect(await walk(list(sort, limit))).toEqual(await order(by));
      });

  it('a cursor made before V12, with a millisecond, still pages: never a 500, and skips none', async () => {
    for (const [sort, by, dir] of [
      ['createdAt', 'created_at asc', 'asc'],
      ['-createdAt', 'created_at desc', 'desc'],
    ] as const) {
      const all = await order(by);
      // Stopped at the second of the rows that share one time, as an older server kept it.
      const shared = await ids(
        `select id from app.fixture_tasks where tenant_id = $1 and created_at = '${TIMES[0]}'`,
        [tenantId],
      );
      const stop = all.filter((id) => shared.includes(id))[1];
      const ms = (
        await pool.query('select created_at from app.fixture_tasks where id = $1', [stop])
      ).rows[0].created_at.toISOString();
      const seen = await walk(list(sort, 1), encode({ s: sort, v: [ms], id: stop }));
      // Every row after it, each at least once: what may repeat is the cursor's own millisecond.
      for (const id of all.slice(all.indexOf(stop) + 1))
        expect(seen, `${dir}: ${titles[id]}`).toContain(id);
    }
  });

  it('a cursor whose time was tampered with is 400 bad_cursor', async () => {
    const [anId] = await order('created_at');
    for (const v of [
      '2026-01-01T00:00:00.0005001', // seven digits
      '2026-02-31T00:00:00.000000', // no such day
      '0000-01-01T00:00:00.000000', // a year Postgres has no room for
      '2026-01-01T24:00:00.000000',
      '2026-01-01T00:00:00.000500Z', // neither form a server wrote
      '2026-01-01 00:00:00.000500',
    ]) {
      const res = await owner.call(
        'GET',
        `/api/tasks?sort=createdAt&cursor=${encode({ s: 'createdAt', v: [v], id: anId })}`,
      );
      expect(res.status, v).toBe(400);
      expect(res.body.error, v).toBe('bad_cursor');
    }
  });
});

describe('the other keyset reads', () => {
  const STAMP = Date.now().toString(36);

  it('the inbox', async () => {
    for (let i = 0; i < TIMES.length; i++)
      await pool.query(
        `insert into channel.inbox_items (tenant_id, user_id, notification, dedupe, title, body, created_at)
         values ($1, $2, 'v12.test', $3, $4, 'body', $5)`,
        [tenantId, owner.id, `v12-${i}`, `Item ${i}`, TIMES[i]],
      );
    const all = await ids(
      'select id from channel.inbox_items where tenant_id = $1 and user_id = $2 order by created_at desc, id desc',
      [tenantId, owner.id],
    );
    for (const limit of [1, 2]) {
      const seen = await walk(async (cursor) => {
        const res = await owner.call(
          'GET',
          `/api/inbox?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        );
        return {
          status: res.status,
          body: res.body,
          ids: (res.body.items ?? []).map((t: { id: string }) => t.id),
          next: res.body.nextCursor ?? null,
        };
      });
      expect(seen, `limit=${limit}`).toEqual(all);
    }
    // A cursor made before V12 (the millisecond) pages; a tampered one is 400.
    const ms = (
      await pool.query('select created_at from channel.inbox_items where id = $1', [all[3]])
    ).rows[0].created_at.toISOString();
    const old = await owner.call('GET', `/api/inbox?limit=10&cursor=${token(`${ms}|${all[3]}`)}`);
    expect(old.status).toBe(200);
    const shown = old.body.items.map((t: { id: string }) => t.id);
    for (const id of all.slice(4)) expect(shown).toContain(id);
    const bad = await owner.call(
      'GET',
      `/api/inbox?cursor=${token(`0000-01-01T00:00:00.000000|${all[3]}`)}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_cursor');
  });

  it('agent runs', async () => {
    const agent = (
      await pool.query(
        `insert into app.agents (tenant_id, owner_id, name, instructions) values ($1, $2, 'Keyset', 'x') returning id`,
        [tenantId, owner.id],
      )
    ).rows[0].id;
    for (let i = 0; i < TIMES.length; i++)
      await pool.query(
        `insert into app.agent_runs (tenant_id, agent_id, run_id, trigger_kind, dedupe, status, created_at)
         values ($1, $2, $3, 'manual', $4, 'done', $5)`,
        [tenantId, agent, `v12${STAMP}${i}`.padEnd(32, '0'), `v12-${i}`, TIMES[i]],
      );
    const all = await ids(
      'select id from app.agent_runs where agent_id = $1 order by created_at desc, id desc',
      [agent],
    );
    for (const limit of [1, 2]) {
      const seen = await walk(async (cursor) => {
        const res = await owner.call(
          'GET',
          `/api/agent-runs?agentId=${agent}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        );
        return {
          status: res.status,
          body: res.body,
          ids: (res.body.items ?? []).map((t: { id: string }) => t.id),
          next: res.body.nextCursor ?? null,
        };
      });
      expect(seen, `limit=${limit}`).toEqual(all);
    }
  });

  it('the credits ledger', async () => {
    for (let i = 0; i < TIMES.length; i++)
      await pool.query(
        `insert into app.credit_ledger (tenant_id, kind, amount, balance_after, currency, actor_kind, actor_id, at)
         values ($1, 'grant', 1, $2, 'credits', 'user', $3, $4)`,
        [tenantId, i + 1, owner.id, TIMES[i]],
      );
    const all = await ids(
      'select id from app.credit_ledger where tenant_id = $1 order by at desc, id desc',
      [tenantId],
    );
    for (const limit of [1, 2]) {
      const seen = await walk(async (before) => {
        const res = await owner.call(
          'GET',
          `/api/credits/ledger?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        );
        return {
          status: res.status,
          body: res.body,
          ids: (res.body.items ?? []).map((t: { id: string }) => t.id),
          next: res.body.next ?? null,
        };
      });
      expect(seen, `limit=${limit}`).toEqual(all);
    }
    // A time someone chose is still a bound: entries strictly before it.
    const day = await owner.call(
      'GET',
      `/api/credits/ledger?limit=50&before=${encodeURIComponent('2026-01-02T00:00:00Z')}`,
    );
    expect(day.status).toBe(200);
    expect(day.body.items).toHaveLength(TIMES.length - 1);
  });

  it('the integrations delivery log', async () => {
    const endpoint = (
      await pool.query(
        `insert into app.integration_endpoints (tenant_id, url, events, secret_sealed)
         values ($1, 'https://example.com/hook', '{*}', 'sealed') returning id`,
        [tenantId],
      )
    ).rows[0].id;
    for (let i = 0; i < TIMES.length; i++)
      await pool.query(
        `insert into app.integration_deliveries (tenant_id, endpoint_id, event_id, event_name, resource_type, body, status, created_at)
         values ($1, $2, $3, 'task.created', 'task', '{}', 'delivered', $4)`,
        [tenantId, endpoint, `v12-${i}`, TIMES[i]],
      );
    const all = await ids(
      'select id from app.integration_deliveries where endpoint_id = $1 order by created_at desc, id desc',
      [endpoint],
    );
    for (const limit of [1, 2]) {
      const seen = await walk(async (before) => {
        const res = await owner.call(
          'GET',
          `/api/integrations/endpoints/${endpoint}/deliveries?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        );
        return {
          status: res.status,
          body: res.body,
          ids: (res.body.items ?? []).map((t: { id: string }) => t.id),
          next: res.body.nextBefore ?? null,
        };
      });
      expect(seen, `limit=${limit}`).toEqual(all);
    }
  });

  it('the platform routing log', async () => {
    await makeOperator(owner);
    for (let i = 0; i < TIMES.length; i++)
      await pool.query(
        `insert into app.platform_routed (source, ref, tenant_id, status, created_at)
         values ('v12', $1, $2, 'routed', $3)`,
        [`${STAMP}-${i}`, tenantId, TIMES[i]],
      );
    const all = await ids(
      'select id from app.platform_routed where tenant_id = $1 order by created_at desc, id desc',
      [tenantId],
    );
    for (const limit of [1, 2]) {
      // The log is an array: a page shorter than the limit is its end, and the last row's
      // cursor is the next `before`.
      const seen = await walk(async (before) => {
        const res = await owner.call(
          'GET',
          `/api/platform/routing?tenantId=${tenantId}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        );
        const rows: { id: string; cursor: string }[] = Array.isArray(res.body) ? res.body : [];
        return {
          status: res.status,
          body: res.body,
          ids: rows.map((r) => r.id),
          next: rows.length === limit ? (rows.at(-1)?.cursor ?? null) : null,
        };
      });
      expect(seen, `limit=${limit}`).toEqual(all);
    }
    // A time is still taken; text that is neither is 400.
    const at = await owner.call(
      'GET',
      `/api/platform/routing?tenantId=${tenantId}&before=${encodeURIComponent('2026-01-02T00:00:00Z')}`,
    );
    expect(at.status).toBe(200);
    expect(at.body).toHaveLength(TIMES.length - 1);
    const bad = await owner.call('GET', `/api/platform/routing?before=nonsense`);
    expect(bad.status).toBe(400);
  });
});
