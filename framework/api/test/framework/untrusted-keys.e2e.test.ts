// Keys and values someone sends never reach an object's prototype, and a name that is one never
// picks something it should not (docs/decisions/V1.md). The API runs in this process, so a
// request that pollutes shows here as an own key of Object.prototype; every test cleans it up.
// On the settings fixture: gadgets (custom fields, shared) and the base fixture's tasks (a plain list).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { boot, makeOperator, me, Person, pool, server, shutdown } from '../../dist/testing.js';
import { settingsApp } from '../fixture/dist/features/settings/index.js';

const a = new Person('Owner A Keys');
const b = new Person('Owner B Keys');
let tenantA = '';
let tenantB = '';
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
  tenantB = (await me(b)).tenantId;
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
        // Text Postgres cannot hold: the class-22 backstop answers for it (V10).
        { ...genuine, v: ['a\u0000b'] },
        { ...genuine, id: 'a\u0000b' },
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

describe('a NUL character in what someone sends', () => {
  // Postgres's text and jsonb hold no U+0000: before V10, any that reached it was a 500.
  const nul = (res: { status: number; body: unknown }, what: string) => {
    expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body, what).toMatchObject({ error: 'invalid', rule: 'nul_character' });
  };

  it('is 400 in a query string, a body or a path, on every route, and nothing is stored', async () => {
    const task = await a.call('POST', '/api/tasks', { title: 'NUL target' });
    expect(task.status).toBe(201);
    const id = task.body.value.id as string;
    const on = `entity=task&id=${id}`;
    for (const path of [
      '/api/tasks?title=a%00b',
      '/api/tasks?q=a%00b',
      '/api/tasks/summary?title=a%00b',
      '/api/gadgets?title=a%00b',
      '/api/jobs?kind=a%00b',
      '/api/calls?entity=task&id=a%00b',
      `/api/comments/mentionable?${on}&q=a%00b`,
      '/api/comments?entity=task&id=a%00b',
      '/api/tasks/a%00b',
      '/api/tasks?a%00b=1',
    ])
      nul(await a.call('GET', path), path);
    for (const [method, path, body] of [
      ['POST', '/api/tasks', { title: 'a\u0000b' }],
      ['POST', '/api/tasks', { title: 'ok', extra: ['deep', { in: 'a\u0000b' }] }],
      ['POST', '/api/tasks', raw('{"title":"ok","a\\u0000b":1}')],
      ['PATCH', `/api/tasks/${id}`, { title: 'a\u0000b' }],
      ['POST', '/api/gadgets', { title: 'ok', custom: { colour: 'a\u0000b' } }],
      ['POST', '/api/comments', { entity: 'task', recordId: id, body: 'a\u0000b' }],
      ['PATCH', '/api/settings/wording', { phrases: { greeting: { en: 'a\u0000b' } } }],
    ] as const) {
      nul(await a.call(method, path, body), `${method} ${path} ${JSON.stringify(body)}`);
      await othersUnharmed(`${method} ${path}`);
    }
    // Not stored with the character dropped either: the patch changed nothing.
    expect((await a.call('GET', `/api/tasks/${id}`)).body.title).toBe('NUL target');
  });

  it('with a genuine cursor, a NUL filter is the filter’s fault, not the cursor’s', async () => {
    for (const title of ['Paged one', 'Paged two'])
      expect((await a.call('POST', '/api/tasks', { title })).status).toBe(201);
    const first = await a.call('GET', '/api/tasks?sort=title&limit=1');
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    const at = `/api/tasks?sort=title&limit=1&cursor=${cursor}`;
    expect((await a.call('GET', at)).status).toBe(200);
    nul(await a.call('GET', `${at}&title=a%00b`), 'paged');
  });

  it('in a custom filter’s JSON, decoded after the edge, is refused alike, with or without a cursor', async () => {
    // `custom={"colour":"a\u0000b"}`: the query text holds a backslash, JSON.parse makes the NUL.
    const field = await a.call('POST', '/api/custom-fields', {
      entity: 'gadget',
      key: 'colour',
      type: 'text',
      label: { en: 'Colour' },
    });
    expect(field.status, JSON.stringify(field.body)).toBe(201);
    for (const title of ['Colour one', 'Colour two'])
      expect(
        (await a.call('POST', '/api/gadgets', { title, custom: { colour: 'red' } })).status,
      ).toBe(201);
    const json = (o: unknown) => encodeURIComponent(JSON.stringify(o));
    const first = await a.call('GET', '/api/gadgets?sort=title&limit=1');
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    for (const filter of [
      { colour: 'a\u0000b' },
      { colour: { contains: 'a\u0000b' } },
      { colour: { in: ['red', 'a\u0000b'] } },
      { colour: { ne: 'a\u0000b' } },
    ])
      for (const path of [
        '/api/gadgets?',
        '/api/gadgets/summary?',
        `/api/gadgets?sort=title&limit=1&cursor=${cursor}&`,
      ]) {
        const res = await a.call('GET', `${path}custom=${json(filter)}`);
        nul(res, `${path} ${JSON.stringify(filter)}`);
        expect(res.body.where).toBe('query.custom');
      }
    // A backslash and "u0000" are text like any other, and the plain filter still reads.
    for (const colour of ['red', 'a\\u0000b']) {
      const res = await a.call('GET', `/api/gadgets?custom=${json({ colour })}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await a.call('GET', `/api/gadgets/summary?custom=${json({ colour })}`)).status).toBe(
        200,
      );
    }
    expect(
      (await a.call('GET', `/api/gadgets?sort=title&limit=1&cursor=${cursor}`)).body.items,
    ).toHaveLength(1);
  });

  it('past the query parser’s 1000 keys too: a page that reads the raw query sees no NUL', async () => {
    // Express keeps the first 1000 keys in req.query; the OAuth pages read the raw query again.
    const filler = Array.from({ length: 1000 }, (_, i) => `f${i}=0`).join('&');
    const anon = async (path: string) => {
      const res = await fetch(`${server.base}${path}`, { redirect: 'manual' });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: res.status, body };
    };
    for (const path of [
      `/oauth/consent?${filler}&client_id=a%00b`,
      `/oauth/sign-in?${filler}&client_id=a%00b`,
      `/api/branding/public?${filler}&x=a%00b`,
    ])
      nul(await anon(path), path.slice(-30));
    for (const path of [
      `/api/tasks?${filler}&title=a%00b`,
      `/api/auth/get-session?${filler}&x=a%00b`,
    ])
      nul(await a.call('GET', path), path.slice(-30));
    // `%2500` is the text "%00", not a NUL.
    expect((await a.call('GET', '/api/tasks?title=a%2500b')).status).toBe(200);
  });

  it('half of a surrogate pair is refused alike: a custom value with one was a 500', async () => {
    // jsonb refuses a lone surrogate (22P05), and text turned one into U+FFFD without a word.
    const lone = (res: { status: number; body: unknown }, what: string) => {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body, what).toMatchObject({ error: 'invalid', rule: 'lone_surrogate' });
    };
    const field = await a.call('POST', '/api/custom-fields', {
      entity: 'gadget',
      key: 'shade',
      type: 'text',
      label: { en: 'Shade' },
    });
    expect(field.status, JSON.stringify(field.body)).toBe(201);
    lone(
      await a.call('POST', '/api/gadgets', { title: 'ok', custom: { shade: 'a\ud800b' } }),
      'custom',
    );
    lone(await a.call('POST', '/api/tasks', { title: 'a\udc00b' }), 'title');
    const filter = encodeURIComponent(JSON.stringify({ shade: 'a\ud800b' }));
    lone(await a.call('GET', `/api/gadgets?custom=${filter}`), 'filter');
    const named = new Person('Half Pair');
    expect((await named.signUp()).status).toBe(200);
    lone(await named.call('POST', '/api/auth/update-user', { name: 'Half \ud800' }), 'name');
    expect((await named.call('GET', '/api/auth/get-session')).body.user.name).toBe('Half Pair');
    // A whole pair is a character like any other.
    const smile = await a.call('POST', '/api/tasks', { title: 'Smile \u{1F600}' });
    expect(smile.status).toBe(201);
    expect(smile.body.value.title).toBe('Smile \u{1F600}');
    await othersUnharmed('half a pair');
  });

  it('Better Auth’s routes refuse one too: an update of the name was a 500', async () => {
    // Its routes are not Nest's: a hook in front of its endpoints checks them (infra/auth.ts).
    const odd = new Person('Odd Name');
    const signUp = await odd.call('POST', '/api/auth/sign-up/email', {
      name: 'Odd\u0000Name',
      email: odd.email,
      password: 'password123',
    });
    nul(signUp, 'sign-up');
    expect((await odd.signUp()).status).toBe(200);
    nul(await odd.call('POST', '/api/auth/update-user', { name: 'Odd\u0000Again' }), 'update');
    nul(await odd.call('GET', '/api/auth/get-session?x=a%00b'), 'session');
    expect((await odd.call('GET', '/api/auth/get-session')).body.user.name).toBe('Odd Name');
  });
});

describe('a tampered keyset cursor (inbox, comments, agent runs)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const now = new Date().toISOString();
  /** A time Postgres cannot store, a NUL in the id, and an id longer than any id. */
  const bad = [
    ['99999', 'x'],
    ['-100000-01-01T00:00:00Z', 'x'],
    [now, 'a\u0000b'],
    [now, 'x'.repeat(129)],
  ];

  it('is 400 bad_cursor for a far-off time, a NUL id or an over-long id, never a 500', async () => {
    const task = await a.call('POST', '/api/tasks', { title: 'Cursor target' });
    const on = `entity=task&id=${task.body.value.id}`;
    for (const [path, encode] of [
      ['/api/inbox', ([at, id]: string[]) => b64(`${at}|${id}`)],
      [`/api/comments?${on}`, ([at, id]: string[]) => b64(`${at}|${id}`)],
      ['/api/agent-runs', (x: string[]) => b64(JSON.stringify(x))],
    ] as const)
      for (const parts of bad) {
        const res = await a.call(
          'GET',
          `${path}${path.includes('?') ? '&' : '?'}cursor=${encode(parts)}`,
        );
        const what = `${path} ${JSON.stringify(parts).slice(0, 60)}`;
        expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(400);
        // The query's schema refuses a cursor that long before it is read; the rest are its own.
        if (parts[1].length <= 128) expect(res.body.error, what).toBe('bad_cursor');
      }
  });
});

describe('a time Postgres cannot store, in a query string', () => {
  // JavaScript reads year 0 and years past 9999; Postgres refuses them (22008): a 500 before V10.
  const year0 = encodeURIComponent('0000-01-01T00:00:00Z');
  const past9999 = encodeURIComponent('9999-12-31T23:59:59-01:00');
  const fine = encodeURIComponent('2026-01-01T00:00:00Z');

  it('is 400 in a list’s date filter, history, credits usage and the platform’s routing', async () => {
    expect(
      (await a.call('POST', '/api/tasks', { title: 'Dated', dueOn: '2026-12-01' })).status,
    ).toBe(201);
    const operator = new Person('Operator Times');
    await operator.signUp();
    await makeOperator(operator);
    const bad: [Person, string][] = [
      [a, '/api/tasks?dueOn=0000-01-01'],
      [a, '/api/tasks?dueOn[gte]=0000-01-01'],
      [a, `/api/tasks?dueOn[lt]=${year0}`],
      [a, `/api/tasks?dueOn[lt]=${past9999}`],
      [a, '/api/tasks/summary?dueOn[gte]=0000-01-01'],
      [a, `/api/history?since=${year0}`],
      [a, `/api/history?since=${past9999}`],
      [a, '/api/credits/usage?from=99999'],
      [a, '/api/credits/usage?to=99999'],
      [a, `/api/credits/usage?from=${year0}`],
      [a, '/api/credits/usage?from=not-a-time'],
      [operator, `/api/platform/routing?before=${year0}`],
      [operator, `/api/platform/routing?before=${past9999}`],
    ];
    for (const [who, path] of bad) {
      const res = await who.call('GET', path);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(400);
    }
    for (const [who, path] of [
      [a, '/api/tasks?dueOn[gte]=2026-01-01'],
      [a, `/api/tasks?dueOn[lt]=${fine}`],
      [a, '/api/tasks/summary?dueOn[gte]=2026-01-01'],
      [a, `/api/history?since=${fine}`],
      [a, `/api/credits/usage?from=${fine}`],
      [operator, `/api/platform/routing?before=${fine}`],
    ] as const) {
      const res = await who.call('GET', path);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});

describe('a filter value its column cannot hold', () => {
  // The list schema takes any finite number for a `number` field; an `integer` column holds
  // whole numbers to 2^31 - 1. Postgres refused the rest (22003, 22P02): a 500 before V10, and
  // `bad_cursor` with a genuine cursor, which blamed the cursor for the filter.
  it('is 400 invalid on the list, its summary and with a cursor, never a 500 or bad_cursor', async () => {
    for (const title of ['Ranked one', 'Ranked two'])
      expect((await a.call('POST', '/api/gadgets', { title, rank: 1 })).status).toBe(201);
    const cursor = (await a.call('GET', '/api/gadgets?sort=title&limit=1')).body.nextCursor;
    expect(cursor).toBeTruthy();
    for (const q of ['rank=1e12', 'rank[gt]=-1e12', 'rank=1.5', 'rank[in]=1,1e12'])
      for (const path of [
        '/api/gadgets?',
        '/api/gadgets/summary?',
        `/api/gadgets?sort=title&limit=1&cursor=${cursor}&`,
      ]) {
        const res = await a.call('GET', `${path}${q}`);
        expect(res.status, `${path}${q}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body, `${path}${q}`).toMatchObject({ error: 'invalid', field: 'rank' });
      }
    expect((await a.call('GET', '/api/gadgets?rank=2147483647')).status).toBe(200);
    expect((await a.call('GET', '/api/gadgets/summary?rank[in]=1,2')).status).toBe(200);
  });
});

describe('routes that read their own query string', () => {
  it('answer a malformed one with a 4xx or a page, never a 500', async () => {
    const operator = new Person('Operator Keys');
    await operator.signUp();
    await makeOperator(operator);
    const id = '00000000-0000-4000-8000-000000000000';
    const wrongTypes = Buffer.from(JSON.stringify({ at: { a: 1 }, id: 5, s: [], v: 'x' })).toString(
      'base64url',
    );
    const variants = [
      'limit=-1',
      'limit=1e9',
      'limit=abc',
      'limit=1&limit=2',
      'before=not-a-date',
      'before=a&before=b',
      // A time JavaScript reads and Postgres has no room for.
      'before=99999',
      'before=-100000-01-01T00:00:00Z',
      'from=99999&to=99999',
      'from=-100000-01-01&to=-100000-01-02',
      'cursor=garbage',
      `cursor=${wrongTypes}`,
      'cursor=a&cursor=b',
      'status=a&status=b',
      'from=x&to=y',
      'from=a&from=b',
      'lang=constructor',
      'lang=__proto__',
      'lang=a&lang=b',
      'entity=constructor',
      'entity=__proto__',
      'entity=a&entity=b',
      'id=a&id=b',
      'ids=a&ids=b',
      'q=a&q=b',
      'page=a&page=b',
      'form=a&form=b',
      'kind=a&kind=b',
      'origin=a&origin=b',
      // A NUL character, which no Postgres text holds (V10).
      'q=a%00b',
      'kind=a%00b',
      'status=a%00b',
      'id=a%00b',
      'entity=a%00b',
      `cursor=${Buffer.from('99999|x').toString('base64url')}`,
      `cursor=${Buffer.from(`${new Date().toISOString()}|a\u0000b`).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify(['99999', 'x'])).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify([new Date().toISOString(), 'a\u0000b'])).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ d: '2026-01-01T00:00:00.000000', i: 'a\u0000b' })).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ d: '0000-01-01T00:00:00.000000', i: 'x' })).toString('base64url')}`,
      // Times JavaScript reads and Postgres refuses, on every name a route reads one by (V10).
      ...['since', 'before', 'after', 'from', 'to', 'until'].flatMap((name) =>
        ['99999', '0000-01-01T00:00:00Z', '0000-01-01', '9999-12-31T23:59:59-01:00'].map(
          (v) => `${name}=${encodeURIComponent(v)}`,
        ),
      ),
      // More keys than the query parser keeps, with a NUL past them (V10).
      `${Array.from({ length: 1000 }, (_, i) => `f${i}=0`).join('&')}&q=a%00b&client_id=a%00b`,
    ];
    const task = await a.call('POST', '/api/tasks', { title: 'Fuzzed' });
    const on = `entity=task&id=${task.body.value.id}`;
    const resource = `resourceType=task&resourceId=${task.body.value.id}`;
    const day = 'from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00.000Z';
    // Each route bare, and with the parameters it needs, so a malformed one reaches its reading.
    const member = [
      '/api/calls',
      '/api/comments',
      `/api/comments?${on}`,
      `/api/comments/mentionable?${on}`,
      `/api/calendar/busy?${day}`,
      `/api/calendar/free?${day}&minutes=30`,
      '/api/calendar/invites',
      `/api/calendar/invites?${on}`,
      '/api/inbox',
      '/api/privacy/requests',
      '/api/privacy/register',
      '/api/memory/recall?q=hello',
      `/api/memory/recall?q=hello&about=task:${task.body.value.id}`,
      '/api/agent-runs',
      '/api/agent-templates',
      `/api/integrations/endpoints/${id}/deliveries`,
      `/api/integrations/connections/${id}/inbound`,
      '/api/members',
      '/api/sla',
      '/api/parties',
      `/api/participants?${resource}`,
      '/api/jobs',
      '/api/history',
      `/api/history/versions?${resource}`,
      '/api/credits/ledger',
      `/api/credits/usage?${day}`,
      '/api/credits/usage',
      '/api/tasks',
      '/api/tasks/summary',
      '/api/files',
      `/api/acceptances?${on}`,
      '/api/acceptances/kinds?entity=task',
      `/api/shares?${on}`,
      `/api/documents?${on}`,
      '/api/documents/kinds?entity=task',
      '/api/branding/public',
    ];
    const platform = [
      '/api/platform/tenants',
      '/api/platform/support',
      '/api/platform/usage',
      '/api/platform/usage?from=2026-11-01&to=2026-11-02',
      '/api/platform/routing',
      `/api/credits/operator/${tenantA}/ledger`,
    ];
    // Routes anyone may call, with no session. A redirect (the calendar's callback) is an answer.
    const anyone = {
      call: async (_method: string, path: string) => {
        const res = await fetch(`${server.base}${path}`, { redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, body: text };
      },
    };
    const open = [
      '/api/calendar/google/callback',
      '/webhooks/whatsapp',
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
      '/api/share/not-a-token',
      '/api/share/not-a-token/acceptances/documents/x',
      '/oauth/consent?client_id=x',
      '/oauth/sign-in',
    ];
    const failures: string[] = [];
    for (const [who, paths] of [
      [a, member],
      [operator, platform],
      [anyone, open],
    ] as const)
      for (const path of paths)
        for (const q of variants) {
          const res = await who.call('GET', `${path}${path.includes('?') ? '&' : '?'}${q}`);
          if (res.status >= 500) failures.push(`${path}?${q}: ${JSON.stringify(res.body)}`);
          // Never another business's rows: nothing of B's in what A, the operator or anyone sees.
          if (who !== operator && JSON.stringify(res.body).includes(tenantB))
            failures.push(`${path}?${q}: shows the other business`);
          expect(polluted()).toEqual([]);
        }
    expect(failures, failures.join('\n').slice(0, 4000)).toEqual([]);
  }, 180_000); // Every route with every variant: a few thousand requests.
});
