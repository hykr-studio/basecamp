// A shared entity's list pages its own rows and the platform's together (docs/decisions/V12.md):
// its cursor keeps a time as Postgres stores it too, so rows of both that share a time, or lie
// within one millisecond, are each shown exactly once, at limit=1 and 2, either way.
import { configureSharedRecords } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { settingsApp } from '../fixture/dist/features/settings/index.js';

const owner = new Person('Owner Shared Keyset');
const curator = new Person('Curator Shared Keyset');
let tenantId = '';
let platform = '';

/** The platform's three and the business's three, interleaved in time, three at one time. */
const ROWS: [who: 'platform' | 'own', at: string][] = [
  ['platform', '2026-01-01 00:00:00.0005+00'],
  ['own', '2026-01-01 00:00:00.0005+00'],
  ['platform', '2026-01-01 00:00:00.0005+00'],
  ['own', '2026-01-01 00:00:00.0001+00'],
  ['platform', '2026-01-01 00:00:00.0009+00'],
  ['own', '2026-01-02 00:00:00+00'],
];

beforeAll(async () => {
  await boot(settingsApp);
  for (const p of [owner, curator]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  platform = (await me(curator)).tenantId;
  configureSharedRecords({ platformTenantId: platform });
  for (const [i, [who, at]] of ROWS.entries()) {
    const res = await (who === 'own' ? owner : curator).call('POST', '/api/gadgets', {
      title: `Gadget ${i}`,
    });
    expect(res.status).toBe(201);
    await pool.query('update app.fixture_gadgets set created_at = $2 where id = $1', [
      res.body.value.id,
      at,
    ]);
  }
});
afterAll(async () => {
  configureSharedRecords({ platformTenantId: undefined });
  await shutdown();
});

describe('a shared list', () => {
  for (const [sort, dir] of [
    ['createdAt', 'asc'],
    ['-createdAt', 'desc'],
  ] as const)
    for (const limit of [1, 2])
      it(`sort=${sort} at limit=${limit} shows its rows and the platform's once each`, async () => {
        const all = (
          await pool.query(
            `select id from app.fixture_gadgets where tenant_id = any($1) order by created_at ${dir}, id`,
            [[tenantId, platform]],
          )
        ).rows.map((r: { id: string }) => r.id);
        expect(all).toHaveLength(ROWS.length);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 30 && (i === 0 || cursor); i++) {
          const res = await owner.call(
            'GET',
            `/api/gadgets?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          seen.push(...res.body.items.map((g: { id: string }) => g.id));
          cursor = res.body.nextCursor;
        }
        expect(cursor, 'the walk ended').toBeNull();
        expect(seen).toEqual(all);
      });
});
