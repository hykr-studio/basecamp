// Keys and values someone sends never reach an object's prototype, and a name that is one never
// picks something it should not (docs/decisions/V1.md). The API runs in this process, so a
// request that pollutes shows here as an own key of Object.prototype; every test cleans it up.
// On the settings fixture: gadgets (custom fields, shared) and the base fixture's tasks (a plain list).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { settingsApp } from '../fixture/dist/features/settings/index.js';

const a = new Person('Owner A Keys');
const b = new Person('Owner B Keys');
let tenantA = '';
let fresh = 0;

const polluted = () => Object.keys(Object.prototype);
function clean() {
  for (const key of Object.keys(Object.prototype))
    delete (Object.prototype as Record<string, unknown>)[key];
}

/** A body holding the key itself: an object literal's `__proto__` would set its prototype. */
const raw = (json: string) => JSON.parse(json) as Record<string, unknown>;

/** Another business is untouched: its lists, its write and a new sign-up all still work. */
async function othersUnharmed(what: string) {
  expect(polluted(), what).toEqual([]);
  const tasks = await b.call('GET', '/api/tasks');
  expect(tasks.status, `${what}: ${JSON.stringify(tasks.body)}`).toBe(200);
  expect((await b.call('GET', '/api/gadgets')).status, what).toBe(200);
  expect((await b.call('GET', '/api/tasks/summary')).status, what).toBe(200);
  expect((await b.call('POST', '/api/tasks', { title: 'Still fine' })).status, what).toBe(201);
  const newcomer = new Person(`Newcomer Keys ${++fresh}`);
  expect((await newcomer.signUp()).status, what).toBe(200);
}

const storedSettings = async (tenantId: string) =>
  (
    await pool.query<{ s: string }>('select settings::text as s from app.tenants where id = $1', [
      tenantId,
    ])
  ).rows[0]?.s ?? '';

beforeAll(async () => {
  await boot(settingsApp);
  for (const p of [a, b]) await p.signUp();
  tenantA = (await me(a)).tenantId;
  expect((await b.call('POST', '/api/tasks', { title: 'B task' })).status).toBe(201);
  expect((await b.call('POST', '/api/gadgets', { title: 'B gadget' })).status).toBe(201);
});
afterEach(clean);
afterAll(async () => {
  clean();
  await shutdown();
});

describe('a query string naming a prototype', () => {
  it('is refused for its sender alone, on a list, a summary and a custom filter', async () => {
    try {
      for (const path of [
        '/api/tasks?__proto__[x]=1',
        '/api/tasks/summary?__proto__[x]=1',
        '/api/gadgets?custom[colour]=red&__proto__[y]=1',
        '/api/gadgets/summary?__proto__[x]=1',
        '/api/tasks?constructor[x]=1',
        '/api/tasks?prototype[x]=1',
        '/api/tasks?__proto__=1',
        '/api/gadgets?__proto__[x]=1&title=a',
      ]) {
        const res = await a.call('GET', path);
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(400);
        await othersUnharmed(path);
      }
    } finally {
      clean();
    }
  });
});

describe('a body key naming a prototype', () => {
  it('is refused or dropped, never stored, in custom values, wording, branding and settings', async () => {
    try {
      const gadget = await a.call('POST', '/api/gadgets', { title: 'A gadget' });
      expect(gadget.status).toBe(201);
      const id = gadget.body.value.id as string;
      for (const custom of [
        '{"__proto__":{"x":1}}',
        '{"constructor":{"prototype":{"x":1}}}',
        '{"toString":"x"}',
      ]) {
        const res = await a.call('PATCH', `/api/gadgets/${id}`, { custom: raw(custom) });
        expect(res.status, `${custom}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
        await othersUnharmed(custom);
      }
      const stored = await pool.query<{ c: string | null }>(
        'select custom::text as c from app.fixture_gadgets where id = $1',
        [id],
      );
      expect(stored.rows[0]?.c ?? '').not.toMatch(/__proto__|constructor|toString|"x"/);

      for (const [method, path, body] of [
        ['PATCH', '/api/settings/wording', '{"phrases":{"__proto__":{"en":"x"}}}'],
        ['PATCH', '/api/settings/wording', '{"phrases":{"constructor":{"en":"x"}}}'],
        ['PATCH', '/api/settings/wording', '{"phrases":{"toString":{"en":"x"}}}'],
        ['PATCH', '/api/settings/wording', '{"notifications":{"constructor":{"email":null}}}'],
        ['PATCH', '/api/settings/branding', '{"colors":{"__proto__":{"x":"#000000"}}}'],
        [
          'PATCH',
          '/api/settings/sections/general',
          '{"value":{"__proto__":{"x":1},"constructor":{"prototype":{"x":1}}}}',
        ],
        ['PUT', '/api/features/constructor', '{"on":true}'],
        ['PUT', '/api/features/__proto__', '{"on":true}'],
        ['PUT', '/api/features/toString', '{"on":true}'],
      ] as const) {
        const res = await a.call(method, path, raw(body));
        expect(res.status, `${path} ${body}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(
          200,
        );
        expect(res.status, `${path} ${body}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
        await othersUnharmed(`${path} ${body}`);
      }
      expect(await storedSettings(tenantA)).not.toMatch(/__proto__|constructor|toString|"x"/);
    } finally {
      clean();
    }
  });

  it('a custom field may not be named after one', async () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const res = await a.call('POST', '/api/custom-fields', {
        entity: 'gadget',
        key,
        type: 'text',
        label: { en: 'Odd' },
        required: true,
      });
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });
});

describe('a route parameter naming a prototype', () => {
  it('finds nothing: 404, never 500', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      for (const [method, path, body] of [
        ['GET', `/api/settings/sections/${name}`, undefined],
        ['PATCH', `/api/settings/sections/${name}`, { value: {} }],
        ['PATCH', `/api/members/roles/${name}`, { label: { en: 'X' } }],
        ['DELETE', `/api/members/roles/${name}`, undefined],
        ['GET', `/api/sla/${name}/${id}`, undefined],
        ['POST', `/api/${name}/${id}/start`, {}],
        ['POST', `/api/tasks/${id}/${name}`, {}],
        ['GET', `/webhooks/${name}/x`, undefined],
        ['POST', `/webhooks/${name}/x`, {}],
      ] as const) {
        const res = await a.call(method, path, body);
        expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(
          400,
        );
        expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
        expect(polluted()).toEqual([]);
      }
    }
  });
});

describe('a tampered list cursor', () => {
  const decode = (c: string) => JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  // (Ids are text columns here: any string id is a valid place to start from.)
  it('is 400 bad_cursor, never a 500, and the genuine one still pages', async () => {
    for (const dueOn of ['2026-12-01', '2026-12-02', '2026-12-03'])
      expect((await a.call('POST', '/api/tasks', { title: `Due ${dueOn}`, dueOn })).status).toBe(
        201,
      );
    for (const title of ['Cursor one', 'Cursor two'])
      expect((await a.call('POST', '/api/gadgets', { title, rank: 1 })).status).toBe(201);
    for (const [path, sort, values] of [
      ['/api/tasks', '-dueOn', ['not-a-date', { a: 1 }, '2026-02-31', true, 123]],
      ['/api/tasks', 'title', [{ a: 1 }, 123, null]],
      ['/api/tasks', '-createdAt', ['not-a-date', { a: 1 }, '2026-02-31T00:00:00.000Z', 123]],
      // A shared list pages its own rows and the platform's with the same cursor.
      ['/api/gadgets', 'rank', ['x', { a: 1 }, true, 1.5]],
    ] as const) {
      const at = `${path}?sort=${sort}&limit=1`;
      const first = await a.call('GET', at);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const cursor = first.body.nextCursor as string;
      expect(cursor, at).toBeTruthy();
      expect((await a.call('GET', `${at}&cursor=${cursor}`)).status, at).toBe(200);
      const genuine = decode(cursor);
      for (const tampered of [
        ...values.map((v) => ({ ...genuine, v: [v] })),
        { s: genuine.s, id: genuine.id },
        { ...genuine, v: 'x' },
        { ...genuine, v: [] },
        { ...genuine, id: { a: 1 } },
        null,
        5,
      ]) {
        const res = await a.call('GET', `${at}&cursor=${encode(tampered)}`);
        expect(res.status, `${at} ${JSON.stringify(tampered)}: ${JSON.stringify(res.body)}`).toBe(
          400,
        );
        expect(res.body.error).toBe('bad_cursor');
      }
    }
  });
});
