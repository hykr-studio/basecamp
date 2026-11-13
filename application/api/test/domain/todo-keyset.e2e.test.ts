// To-dos page without repeating or skipping one that shares its time (docs/decisions/V12.md).
// Acceptance found it live: an import writes its rows in one transaction, so they share a
// created_at to the microsecond, and a cursor that kept the millisecond took its own row again
// ascending (the to-dos' default sort: 60 pages showed one to-do) and skipped the rest
// descending (12 of 17). Two imports here, and rows within one millisecond, walked to the end.
import { boot, eventually, me, origin, Person, pool, server, shutdown } from '@hykr/api/testing';
import { createApiClient } from '@hykr/api-client';
import { isJobFinished } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Keyset');
let tenantId = '';

async function importCsv(text: string, source: string) {
  const api = createApiClient({
    baseUrl: server.base,
    headers: () => ({ origin, cookie: owner.cookie }),
  });
  const file = await api.imports.upload(new TextEncoder().encode(text), {
    name: 'todos.csv',
    mime: 'text/csv',
  });
  const started = await api.imports.start({
    entity: 'todo',
    file: file.id,
    key: 'legacy_id',
    source,
  });
  if (started.status !== 'done') throw new Error(`the import did not start: ${started.status}`);
  await eventually(async () => {
    const job = await api.jobs.get(started.value.id);
    return isJobFinished(job.status) ? job : undefined;
  }, 20_000);
}

const csv = (prefix: string, n: number) =>
  ['legacy_id,title', ...Array.from({ length: n }, (_, i) => `${prefix}-${i},${prefix} ${i}`)].join(
    '\n',
  );

/** Walks every page; fails rather than hangs when a walk never advances. */
async function walk(query: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await owner.call('GET', `/api/todos?${query}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    seen.push(...res.body.items.map((t: { id: string }) => t.id));
    cursor = res.body.nextCursor;
    if (!cursor) return seen;
  }
  throw new Error(`the walk never ended: ${seen.length} to-dos over 60 pages`);
}

const order = async (by: string) =>
  (
    await pool.query(`select id from app.todos where tenant_id = $1 order by ${by}, id`, [tenantId])
  ).rows.map((r: { id: string }) => r.id);

beforeAll(async () => {
  await boot(application);
  await owner.signUp();
  tenantId = (await me(owner)).tenantId;
  await importCsv(csv('First', 8), 'first');
  await importCsv(csv('Second', 9), 'second');
  // Three more, one millisecond apart at most: before, between and after in the microseconds.
  for (const [title, at] of [
    ['Early', '2026-01-01 00:00:00.0001+00'],
    ['Middle', '2026-01-01 00:00:00.0005+00'],
    ['Late', '2026-01-01 00:00:00.0009+00'],
  ]) {
    const res = await owner.call('POST', '/api/todos', { title });
    expect(res.status).toBe(201);
    await pool.query('update app.todos set created_at = $2 where id = $1', [res.body.value.id, at]);
  }
});
afterAll(shutdown);

describe('to-dos page by their time', () => {
  it('rows of one import share a time to the microsecond', async () => {
    const shared = await pool.query(
      'select count(*)::int as n from app.todos where tenant_id = $1 group by created_at order by n desc limit 1',
      [tenantId],
    );
    expect(shared.rows[0].n).toBeGreaterThan(1);
  });

  for (const [query, by] of [
    ['', 'created_at asc'],
    ['sort=createdAt', 'created_at asc'],
    ['sort=-createdAt', 'created_at desc'],
    ['sort=-createdAt,title', 'created_at desc, title asc'],
  ])
    for (const limit of [1, 2])
      it(`${query || 'the default sort'} at limit=${limit}: every to-do once, in order`, async () => {
        const all = await order(by);
        expect(all).toHaveLength(20);
        expect(await walk(`limit=${limit}${query ? `&${query}` : ''}`)).toEqual(all);
      });
});
