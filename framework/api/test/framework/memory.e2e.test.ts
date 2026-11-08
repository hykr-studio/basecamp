// Memory and semantic recall (A8): the business's memory (`memory`, by capability), records of
// any entity with the `memory` trait (the fixture's memos, memory of a task), and what a person
// said, recalled by meaning before each turn and through GET /api/memory/recall, each memory
// loaded again as the reader. Vectors come from the fake embedding (fake/embedding); the last
// test switches a business to the stub gateway's embedding model.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TenantConfigService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECALL_TIMEOUT_MS } from '../../dist/features/memory/index.js';
import * as api from '../../dist/index.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  shutdown,
} from '../../dist/testing.js';
import { memoryApp, seen } from '../fixture/dist/features/memory/index.js';
import { type StubGateway, startGateway } from '../fixture/dist/features/models/gateway.js';

const ana = new Person('Ana Memory'); // owner of her business
const bob = new Person('Bob Memory'); // staff in Ana's business
const carol = new Person('Carol Memory'); // admin in Ana's business
const ravi = new Person('Ravi Memory'); // owner of another business
let anaTenant = '';
let raviTenant = '';

const ENV = ['MODEL_PROVIDERS', 'EMBEDDING_MODEL'] as const;
const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

beforeAll(async () => {
  await boot(memoryApp);
  for (const p of [ana, bob, carol, ravi]) await p.signUp();
  anaTenant = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  await addMember(bob, anaTenant, ['staff']);
  await addMember(carol, anaTenant, ['admin']);
});

afterAll(async () => {
  for (const n of ENV)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  await shutdown();
});

/** A person's calls in Ana's business. */
const inAna = (person: Person) => (method: string, path: string, body?: unknown) =>
  person.call(method, path, body, { 'x-tenant-id': anaTenant });

/** One turn in Ana's business. */
const chatInAna = (person: Person, content: string) =>
  inAna(person)('POST', '/api/chat/once', { message: content });

const recall = (person: Person, query: Record<string, string>, tenant = anaTenant) =>
  person.call('GET', `/api/memory/recall?${new URLSearchParams(query)}`, undefined, {
    'x-tenant-id': tenant,
  });

type Item = { kind: string; type: string; id: string; text: string; about?: object };
const texts = (res: { body: { items: Item[] } }) => res.body.items.map((i) => i.text);

/** The index row of one record, once its vector is made. */
async function indexed(type: string, id: string) {
  return eventually(async () => {
    const { rows } = await pool.query(
      `select state, model, embedding, about_type, about_id, updated_at from app.memory_index
       where source_type = $1 and source_id = $2`,
      [type, id],
    );
    return rows[0]?.state === 'ready' ? rows[0] : undefined;
  });
}

async function memo(person: Person, input: object) {
  const res = await inAna(person)('POST', '/api/memos', input);
  expect(res.status).toBe(201);
  const value = res.body.value as { id: string };
  await indexed('memo', value.id);
  return value;
}

/** The context lines of the last turn the fixture's turn-context tool saw. */
async function contextOf(person: Person, question: string) {
  const before = seen.contexts.length;
  const res = await chatInAna(person, `show context ${question}`);
  expect(res.status).toBe(200);
  expect(seen.contexts.length).toBe(before + 1);
  return seen.contexts.at(-1) ?? [];
}

const settings = async (tenantId: string, key: string, value: unknown) => {
  await pool.query(
    `update app.tenants set settings = jsonb_set(settings, $2, $3::jsonb) where id = $1`,
    [tenantId, `{${key}}`, JSON.stringify(value)],
  );
  server.app?.get(TenantConfigService).invalidate(tenantId);
};
const unset = async (tenantId: string, key: string) => {
  await pool.query(`update app.tenants set settings = settings - $2 where id = $1`, [
    tenantId,
    key,
  ]);
  server.app?.get(TenantConfigService).invalidate(tenantId);
};

describe("the business's memory", () => {
  let anas = '';
  let bobs = '';

  it('members add memory and read all of it; only its author or a manager changes it', async () => {
    const a = await inAna(ana)('POST', '/api/memories', {
      text: 'The office is closed on Sundays',
    });
    expect(a.status).toBe(201);
    expect(a.body.value).toMatchObject({ createdBy: 'person' });
    anas = a.body.value.id;
    const b = await inAna(bob)('POST', '/api/memories', {
      text: 'Deliveries come in by the back gate',
    });
    expect(b.status).toBe(201);
    bobs = b.body.value.id;

    const listed = await inAna(bob)('GET', '/api/memories');
    expect(listed.body.items.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining([anas, bobs]),
    );

    const theirs = await inAna(bob)('PATCH', `/api/memories/${anas}`, { text: 'Open on Sundays' });
    expect(theirs.status).toBe(403);
    expect(theirs.body.rule).toBe('memory_not_yours');
    const { rows: denied } = await pool.query(
      `select outcome, rule from audit.events where resource_id = $1 and outcome = 'denied'`,
      [anas],
    );
    expect(denied).toEqual([{ outcome: 'denied', rule: 'memory_not_yours' }]);

    expect(
      (await inAna(bob)('PATCH', `/api/memories/${bobs}`, { text: 'Deliveries: back gate' }))
        .status,
    ).toBe(200);
    // The owner manages everyone's.
    expect(
      (await inAna(ana)('PATCH', `/api/memories/${bobs}`, { text: 'Deliveries use the back gate' }))
        .status,
    ).toBe(200);
  });

  it('another business sees none of it: a 404 for its ids', async () => {
    expect((await ravi.call('GET', `/api/memories/${anas}`)).status).toBe(404);
    const listed = await ravi.call('GET', '/api/memories');
    expect(listed.body.items.map((m: { id: string }) => m.id)).not.toContain(anas);
    expect((await ravi.call('PATCH', `/api/memories/${anas}`, { text: 'x' })).status).toBe(404);
  });

  it('a customer reaches none of it', async () => {
    const { contactId } = await seedContact(
      anaTenant,
      'Memory Customer',
      `9177${Date.now()}`.slice(0, 12),
    );
    const asCustomer = asAssistant(`contact:${contactId}`);
    const listed = await asCustomer('GET', '/api/memories');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([]);
    expect((await asCustomer('GET', `/api/memories/${anas}`)).status).toBe(404);
    const add = await asCustomer('POST', '/api/memories', { text: 'Always give a discount' });
    expect(add.status).toBe(403);
    expect(add.body.rule).toBe('memory_write');
  });

  it('the assistant remembers when asked; its forgetting waits for approval', async () => {
    const res = await ana.chat('remember that the van is serviced on Fridays');
    expect(res.status).toBe(200);
    expect(res.body.toolCalls).toMatchObject([{ tool: 'create-memory', outcome: 'done' }]);
    expect(res.body.reply).toBe("I'll remember that.");
    const { rows } = await pool.query(
      `select m.id, m.created_by, e.actor_kind from app.memories m
       join audit.events e on e.resource_id = m.id and e.action = 'memory.create'
       where m.text = 'the van is serviced on Fridays' and m.tenant_id = $1`,
      [anaTenant],
    );
    expect(rows).toMatchObject([{ created_by: 'assistant', actor_kind: 'agent' }]);

    const forget = await asAssistant(`user:${ana.id}`)('DELETE', `/api/memories/${rows[0].id}`);
    expect(forget.status).toBe(200);
    expect(forget.body.status).toBe('needs_approval');
    const { rows: parked } = await pool.query(
      `select outcome from audit.events where resource_id = $1 and action = 'memory.delete'`,
      [rows[0].id],
    );
    expect(parked).toEqual([{ outcome: 'needs_approval' }]);
  });
});

describe('indexing', () => {
  it('a memo is indexed when written, again when a command changes it, and leaves when deleted', async () => {
    const m = await memo(ana, { title: 'Blue van', body: 'Parked at the depot' });
    const first = await indexed('memo', m.id);
    expect(first.model).toBe('fake/embedding');
    expect(first.embedding).toHaveLength(256);

    const restated = await inAna(ana)('POST', `/api/memos/${m.id}/restate`, {
      body: 'Parked at the north gate',
    });
    expect(restated.status).toBe(200);
    const again = await eventually(async () => {
      const row = await indexed('memo', m.id);
      return JSON.stringify(row.embedding) !== JSON.stringify(first.embedding) ? row : undefined;
    });
    expect(again.model).toBe('fake/embedding');

    expect((await inAna(ana)('DELETE', `/api/memos/${m.id}`)).status).toBe(200);
    const { rows } = await pool.query(`select 1 from app.memory_index where source_id = $1`, [
      m.id,
    ]);
    expect(rows).toEqual([]);
  });

  it('a claim whose run died is taken over after its lease; a live run keeps its own', async () => {
    const m = await memo(ana, { title: 'White bucket', body: 'Under the stairs' });
    const row = () =>
      pool
        .query(`select state, claim from app.memory_index where source_id = $1`, [m.id])
        .then((r) => r.rows[0]);
    // Another run is embedding it right now: left alone.
    await pool.query(
      `update app.memory_index set state = 'pending', claim = 'live-run', claimed_at = now()
       where source_id = $1`,
      [m.id],
    );
    await new Promise((r) => setTimeout(r, 2500));
    expect(await row()).toEqual({ state: 'pending', claim: 'live-run' });
    // That run died an hour ago: its claim has lapsed, and the row is embedded again.
    await pool.query(
      `update app.memory_index set claimed_at = now() - interval '1 hour' where source_id = $1`,
      [m.id],
    );
    await indexed('memo', m.id);
    expect(await row()).toEqual({ state: 'ready', claim: null });
  });

  it('records written before (or without a write) are found by the backfill', async () => {
    const { rows } = await pool.query(
      `insert into app.fixture_memos_recall (tenant_id, owner_id, title) values ($1, $2, 'Old memo')
       returning id`,
      [anaTenant, ana.id],
    );
    const { DB } = await import('../../dist/testing-internals.js');
    expect(await api.backfillAll(server.app?.get(DB, { strict: false }))).toBeGreaterThan(0);
    expect((await indexed('memo', rows[0].id)).model).toBe('fake/embedding');
  });
});

describe('recall in a turn', () => {
  let ladder = '';

  beforeAll(async () => {
    ladder = (await memo(ana, { title: 'Green ladder', body: 'Kept in the shed' })).id;
  });

  it('the turn reads what is remembered, as data', async () => {
    const lines = await contextOf(ana, 'about the green ladder');
    expect(lines.some((l) => l.includes(`memo ${ladder}`) && l.includes('Kept in the shed'))).toBe(
      true,
    );
    const office = await contextOf(ana, 'is the office closed on sundays');
    expect(office.some((l) => l.includes('The office is closed on Sundays'))).toBe(true);
  });

  it('a member who cannot read a memo, and another business, recall nothing of it', async () => {
    // (What each of them said themselves may come back: their own words, not Ana's memo.)
    expect((await contextOf(bob, 'about the green ladder')).join('\n')).not.toContain(
      'Kept in the shed',
    );
    const before = seen.contexts.length;
    await ravi.chat('show context about the green ladder');
    expect(seen.contexts.length).toBe(before + 1);
    expect((seen.contexts.at(-1) ?? []).join('\n')).not.toContain('Kept in the shed');
    expect(
      texts(await recall(ravi, { q: 'green ladder shed', kinds: 'record' }, raviTenant)),
    ).toEqual([]);
  });

  it('fields hidden from the reader stay hidden, and are not even searched', async () => {
    await memo(ana, { title: 'Gate code', body: 'For the yard', secret: 'sapphire falcon' });
    const forAna = await recall(ana, { q: 'gate code yard' });
    expect(texts(forAna)).toContain('Gate code. For the yard');
    expect(JSON.stringify(forAna.body)).not.toContain('sapphire');
    // Carol may read secrets: the same memory, whole.
    const forCarol = await recall(carol, { q: 'gate code yard' });
    expect(texts(forCarol)).toContain('Gate code. For the yard. sapphire falcon');
    // The vector was made without the secret: its words find nothing.
    expect(texts(await recall(carol, { q: 'sapphire falcon' }))).toEqual([]);
  });

  it('records the assistant may not read are never recalled', async () => {
    const aside = await inAna(ana)('POST', '/api/asides', { title: 'Purple umbrella in the hall' });
    expect(aside.status).toBe(201);
    await indexed('aside', aside.body.value.id);
    expect(texts(await recall(ana, { q: 'purple umbrella hall' }))).toEqual([]);
  });

  it('memory of a record the reader cannot read is skipped', async () => {
    const task = await inAna(bob)('POST', '/api/tasks', { title: 'Fix the fence' });
    expect(task.status).toBe(201);
    const taskId = task.body.value.id;
    await memo(bob, { title: 'Fence wood', body: 'Cedar planks', taskId });
    // Ana reads every memo, but not Bob's task: the memo is not hers to recall.
    expect(texts(await recall(ana, { q: 'fence wood cedar planks' }))).toEqual([]);
    expect((await recall(ana, { q: 'fence wood', about: `task:${taskId}` })).status).toBe(404);
    // Carol (admin) reads both.
    const forCarol = await recall(carol, { q: 'fence wood cedar planks', about: `task:${taskId}` });
    expect(forCarol.body.items).toMatchObject([
      { kind: 'record', type: 'memo', about: { type: 'task', id: taskId } },
    ]);
  });

  it('a record its trait cannot read fails alone: marked failed, the rest indexed', async () => {
    const bad = await inAna(ana)('POST', '/api/memos', { title: 'explode', body: 'Red bucket' });
    const good = await inAna(ana)('POST', '/api/memos', {
      title: 'Red bucket',
      body: 'By the door',
    });
    const failed = await eventually(async () => {
      const { rows } = await pool.query(
        `select state, error from app.memory_index where source_id = $1`,
        [bad.body.value.id],
      );
      return rows[0]?.state === 'failed' ? rows[0] : undefined;
    });
    expect(failed.error).toContain('cannot read the memo');
    await indexed('memo', good.body.value.id);
    expect(texts(await recall(ana, { q: 'red bucket door' }))).toContain('Red bucket. By the door');
  });

  it('a record deleted behind the index is not recalled', async () => {
    const m = await memo(ana, { title: 'Orange kettle', body: 'In the kitchen' });
    await pool.query(`delete from app.fixture_memos_recall where id = $1`, [m.id]);
    expect(texts(await recall(ana, { q: 'orange kettle kitchen' }))).toEqual([]);
  });

  it('a business can turn recall off; one without an embedding model runs without it', async () => {
    await settings(anaTenant, 'memory', { recall: false });
    try {
      expect(await contextOf(ana, 'about the green ladder')).toEqual([]);
    } finally {
      await unset(anaTenant, 'memory');
    }
    await settings(anaTenant, 'models', { embedding: 'nope/embed' });
    try {
      expect(await contextOf(ana, 'about the green ladder')).toEqual([]);
      expect((await recall(ana, { q: 'green ladder' })).body).toEqual({ items: [], model: null });
    } finally {
      await unset(anaTenant, 'models');
    }
    expect((await contextOf(ana, 'about the green ladder')).join('\n')).toContain('Green ladder');
  });
});

describe('conversation memory', () => {
  it('what a person said is recalled in a later thread, for them and in that business only', async () => {
    const said = await ana.chat('My locker number is forty two');
    expect(said.status).toBe(200);
    await eventually(async () => {
      const { rows } = await pool.query(
        `select i.state from app.memory_index i join app.thread_messages m on m.id = i.message_id
         where i.subject = $1 and m.text = 'My locker number is forty two'`,
        [`user:${ana.id}`],
      );
      return rows[0]?.state === 'ready';
    });
    // Only the person's words: no reply is ever indexed.
    const { rows: replies } = await pool.query(
      `select count(*)::int as n from app.memory_index i join app.thread_messages m
       on m.id = i.message_id where m.role <> 'user'`,
    );
    expect(replies).toEqual([{ n: 0 }]);

    expect((await ana.call('POST', '/api/threads')).status).toBe(201);
    const lines = await contextOf(ana, 'what is my locker number');
    expect(
      lines.some((l) => l.startsWith('Recalled, what the person said') && l.includes('forty two')),
    ).toBe(true);

    expect((await contextOf(bob, 'what is my locker number')).join('\n')).not.toContain(
      'forty two',
    );
    await addMember(ana, raviTenant, ['staff']);
    const before = seen.contexts.length;
    await ana.call(
      'POST',
      '/api/chat/once',
      { message: 'show context what is my locker number' },
      { 'x-tenant-id': raviTenant },
    );
    expect(seen.contexts.length).toBe(before + 1);
    expect((seen.contexts.at(-1) ?? []).join('\n')).not.toContain('forty two');
  });
});

describe('GET /api/memory/recall and recall-memory', () => {
  it('returns what the caller may read, best first, and keeps to one record with `about`', async () => {
    const res = await recall(ana, { q: 'green ladder shed' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fake/embedding');
    expect(res.body.items[0]).toMatchObject({
      kind: 'record',
      type: 'memo',
      text: 'Green ladder. Kept in the shed',
    });
    const scores = res.body.items.map((i: { score: number }) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const task = await inAna(ana)('POST', '/api/tasks', { title: 'Paint the hall' });
    const taskId = task.body.value.id;
    await memo(ana, { title: 'Hall paint', body: 'Two coats of white', taskId });
    const about = await recall(ana, { q: 'hall paint white', about: `task:${taskId}` });
    expect(about.body.items.map((i: Item) => i.about)).toEqual([{ type: 'task', id: taskId }]);
    expect(
      (await recall(ana, { q: 'messages only', kinds: 'message' })).body.items.every(
        (i: Item) => i.kind === 'message',
      ),
    ).toBe(true);
  });

  it('refuses a bad query with 400', async () => {
    for (const q of [
      {},
      { q: '' },
      { q: 'x', limit: '0' },
      { q: 'x', kinds: 'notes' },
      { q: 'x', about: 'nope' },
      { q: 'x', other: '1' },
    ]) {
      const res = await recall(ana, q as Record<string, string>);
      expect(res.status, JSON.stringify(q)).toBe(400);
    }
  });

  it('the assistant recalls through recall-memory, as the person', async () => {
    const res = await ana.chat('what do you remember about the green ladder?');
    expect(res.body.toolCalls).toMatchObject([{ tool: 'recall-memory', outcome: 'done' }]);
    expect(res.body.reply).toBe('I remember: Green ladder. Kept in the shed');
    // Someone new, in a business of their own, has nothing to recall.
    const dee = new Person('Dee Memory');
    await dee.signUp();
    const none = await dee.chat('what do you remember about the green ladder?');
    expect(none.body.toolCalls).toMatchObject([{ tool: 'recall-memory', outcome: 'done' }]);
    expect(none.body.reply).toBe("I don't remember anything about that.");
  });
});

describe('personal data', () => {
  it("a contact's erasure removes the vectors of what it said", async () => {
    const { contactId } = await seedContact(
      anaTenant,
      'Erase Memory',
      `9188${Date.now()}`.slice(0, 12),
    );
    const { rows: thread } = await pool.query(
      `insert into app.threads (tenant_id, contact_id) values ($1, $2) returning id`,
      [anaTenant, contactId],
    );
    const { rows: msg } = await pool.query(
      `insert into app.thread_messages (thread_id, role, text, channel)
       values ($1, 'user', 'My gate is blue', 'whatsapp') returning id`,
      [thread[0].id],
    );
    await pool.query(
      `insert into app.memory_index (tenant_id, kind, source_type, source_id, message_id, subject,
       model, embedding, state) values ($1, 'message', 'message', $2, $2, $3, 'fake/embedding',
       '{1,0}', 'ready')`,
      [anaTenant, msg[0].id, `contact:${contactId}`],
    );
    const { ErasureService } = await import('../../dist/channels/maintenance/erasure.service.js');
    await server.app?.get(ErasureService, { strict: false }).erase(contactId);
    const { rows } = await pool.query(`select 1 from app.memory_index where subject = $1`, [
      `contact:${contactId}`,
    ]);
    expect(rows).toEqual([]);
    const { rows: audit } = await pool.query(
      `select after from audit.events where action = 'channel.contact.erased' and resource_id = $1`,
      [contactId],
    );
    expect(audit[0].after.contributors).toMatchObject({ memory: 1 });
  });

  it('export lists the memories a person wrote; erasing them removes those and their vectors', async () => {
    const { DB } = await import('../../dist/testing-internals.js');
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: bob.id };
    const exported = await api.exportPersonalData({ subject, tenantId: anaTenant, db });
    expect((exported.memories as { text: string }[]).map((m) => m.text)).toEqual([
      'Deliveries use the back gate',
    ]);
    const { rows: mine } = await pool.query(
      `select id from app.memories where owner_id = $1 and tenant_id = $2`,
      [bob.id, anaTenant],
    );
    await indexed('memory', mine[0].id);
    const { counts } = await db.transaction((tx: unknown) =>
      api.eraseWithContributors({ subject, tenantId: anaTenant, tx: tx as never }),
    );
    expect(counts.memory).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      `select (select count(*)::int from app.memories where owner_id = $1) as memories,
              (select count(*)::int from app.memory_index where source_id = $2) as vectors`,
      [bob.id, mine[0].id],
    );
    expect(rows).toEqual([{ memories: 0, vectors: 0 }]);
  });
});

describe('credits (H3)', () => {
  const pat = new Person('Pat Memory'); // owner of a business that gets paused
  let patTenant = '';
  const usesOf = async (tenantId: string, source: string) =>
    (
      await pool.query(
        `select meter, variant, quantity::int, source, ref, subject, run_id from app.usage_events
         where tenant_id = $1 and source = $2 order by at, id`,
        [tenantId, source],
      )
    ).rows;
  const indexer = () => server.app?.get(api.MemoryIndexer, { strict: false }) as api.MemoryIndexer;

  beforeAll(async () => {
    await pat.signUp();
    patTenant = (await me(pat)).tenantId;
  });

  it('the indexer’s embeddings are metered for the business, a use per batch', async () => {
    const m = await memo(ana, { title: 'Metered crate', body: 'In the loft' });
    expect(m.id).toBeTruthy();
    const batches = await usesOf(anaTenant, 'memory.index');
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.at(-1)).toMatchObject({ meter: 'tokens', variant: 'fake/embedding' });
    expect(batches.at(-1).quantity).toBeGreaterThan(0);
    expect(batches.at(-1).ref).toMatch(/^memory\.index:/);
    // Another business pays for none of it.
    expect(await usesOf(raviTenant, 'memory.index')).toEqual([]);
  });

  it('recall’s embedding is metered: in a turn, and through the API', async () => {
    const turn = await chatInAna(bob, 'show context about the metered crate');
    expect(turn.status).toBe(200);
    const inTurn = (await usesOf(anaTenant, 'memory.recall')).filter((u) => u.run_id);
    expect(inTurn.at(-1)).toMatchObject({
      meter: 'tokens',
      variant: 'fake/embedding',
      subject: `user:${bob.id}`,
    });
    // Six words: the fake embedding counts one token a word.
    expect(inTurn.at(-1).quantity).toBe(6);
    expect(inTurn.at(-1).ref).toBe(`memory.recall:${inTurn.at(-1).run_id}`);
    const before = (await usesOf(anaTenant, 'memory.recall')).length;
    expect((await recall(bob, { q: 'metered crate' })).status).toBe(200);
    const after = await usesOf(anaTenant, 'memory.recall');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ quantity: 2, subject: `user:${bob.id}` });
  });

  it('a paused business embeds nothing: recall is 402 and its memories wait', async () => {
    let memoId = '';
    await settings(patTenant, 'credits', { override: { mode: 'pause', reason: 'test pause' } });
    try {
      const res = await recall(pat, { q: 'anything at all' }, patTenant);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: 'credits_paused', rule: 'credits_suspended' });
      const made = await pat.call('POST', '/api/memos', { title: 'Paused shed', body: 'Waits' });
      expect(made.status).toBe(201);
      memoId = made.body.value.id;
      // The indexer looks every second; the memo's row stays pending, no attempt counted.
      await new Promise((r) => setTimeout(r, 2500));
      const { rows } = await pool.query(
        `select state, attempts, claim from app.memory_index where source_id = $1`,
        [made.body.value.id],
      );
      expect(rows).toEqual([{ state: 'pending', attempts: 0, claim: null }]);
      expect(await usesOf(patTenant, 'memory.index')).toEqual([]);
      expect(await usesOf(patTenant, 'memory.recall')).toEqual([]);
    } finally {
      await unset(patTenant, 'credits');
    }
    // Credits again: the indexer is told (or looks again within a minute) and embeds it.
    indexer().wake(patTenant);
    await indexed('memo', memoId);
    expect((await usesOf(patTenant, 'memory.index')).length).toBe(1);
    expect((await recall(pat, { q: 'paused shed' }, patTenant)).status).toBe(200);
  });
});

describe("a business's embedding model changes", () => {
  let gateway: StubGateway;

  afterAll(async () => {
    await gateway?.close();
  });

  it('its memory is embedded again with the new model', async () => {
    gateway = await startGateway();
    process.env.MODEL_PROVIDERS = JSON.stringify([
      {
        id: 'stub',
        baseUrl: `${gateway.url}/v1`,
        apiKey: 'stub-key',
        models: [{ id: 'embed', kind: 'embedding' }],
      },
    ]);
    const set = await ana.call('PUT', '/api/models/policy', {
      allowed: ['stub/embed'],
      embedding: 'stub/embed',
    });
    expect(set.status).toBe(200);
    expect(set.body.status).toBe('done');
    await eventually(async () => {
      const { rows } = await pool.query(
        `select model, state, count(*)::int as n from app.memory_index where tenant_id = $1
           and state <> 'failed' group by model, state`,
        [anaTenant],
      );
      return rows.length === 1 && rows[0].model === 'stub/embed' && rows[0].state === 'ready';
    }, 20_000);
    expect(gateway.requests.some((r) => r.path === '/v1/embeddings')).toBe(true);
    // Ravi's business keeps its own model.
    const { rows } = await pool.query(
      `select distinct model from app.memory_index where tenant_id = $1`,
      [raviTenant],
    );
    expect(rows.every((r) => r.model !== 'stub/embed')).toBe(true);
    expect((await recall(ana, { q: 'green ladder' })).body.model).toBe('stub/embed');
  });
});

/**
 * An embedding provider that answers nothing until it is released: what a slow or hung provider
 * looks like to the indexer and to recall. Its vectors are [length of the text, 1, 0].
 */
async function heldProvider() {
  let release = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: string[][] = [];
  let waiting = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
      inputs.push(input);
      waiting++;
      await open;
      waiting--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: body.model,
          data: input.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: [text.length, 1, 0],
          })),
          usage: { prompt_tokens: input.length, total_tokens: input.length },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    inputs,
    waiting: () => waiting,
    release: () => release(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('the index waits for no provider', () => {
  const eve = new Person('Eve Memory');
  let provider: Awaited<ReturnType<typeof heldProvider>>;

  beforeAll(async () => {
    provider = await heldProvider();
    process.env.MODEL_PROVIDERS = JSON.stringify([
      {
        id: 'held',
        baseUrl: `${provider.url}/v1`,
        apiKey: 'held-key',
        models: [{ id: 'embed', kind: 'embedding' }],
      },
    ]);
    await eve.signUp();
    // Set directly: no policy event, so no rebuild runs into the test.
    await settings((await me(eve)).tenantId, 'models', {
      allowed: ['held/embed'],
      embedding: 'held/embed',
    });
  });

  afterAll(async () => {
    provider?.release();
    await provider?.close();
  });

  it('a record changed while its old words are being embedded is saved at once, and its new words win', async () => {
    const made = await eve.call('POST', '/api/memos', { title: 'Grey tarp', body: 'On the roof' });
    expect(made.status).toBe(201);
    const id = made.body.value.id as string;
    const row = () =>
      pool
        .query(`select state, claim, embedding from app.memory_index where source_id = $1`, [id])
        .then((r) => r.rows[0]);
    // The indexer has claimed the row and waits for the provider.
    await eventually(() => provider.waiting() === 1);
    expect(provider.inputs).toEqual([['Grey tarp. On the roof']]);
    expect(await row()).toMatchObject({ state: 'pending', claim: expect.any(String) });

    // The write locks nothing the indexer holds: it returns while the provider still waits.
    const changed = await eve.call('PATCH', `/api/memos/${id}`, {
      body: 'Folded in the garage by the door',
    });
    expect(changed.status).toBe(200);
    expect(provider.waiting()).toBe(1);
    expect(await row()).toMatchObject({ state: 'pending', claim: null });

    // The old words' vector is not kept: the row is embedded again, with the new words.
    provider.release();
    const done = await eventually(async () => {
      const r = await row();
      return r?.state === 'ready' ? r : undefined;
    });
    expect(done.embedding).toEqual(['Grey tarp. Folded in the garage by the door'.length, 1, 0]);
    expect(provider.inputs.at(-1)).toEqual(['Grey tarp. Folded in the garage by the door']);
  });
});

describe('recall waits for no provider', () => {
  const fay = new Person('Fay Memory');
  let provider: Awaited<ReturnType<typeof heldProvider>>;
  let fayTenant = '';

  beforeAll(async () => {
    // Never released while the tests run: a provider that keeps the connection open and says nothing.
    provider = await heldProvider();
    process.env.MODEL_PROVIDERS = JSON.stringify([
      {
        id: 'hung',
        baseUrl: `${provider.url}/v1`,
        apiKey: 'hung-key',
        models: [{ id: 'embed', kind: 'embedding' }],
      },
    ]);
    await fay.signUp();
    fayTenant = (await me(fay)).tenantId;
    await settings(fayTenant, 'models', { allowed: ['hung/embed'], embedding: 'hung/embed' });
  });

  afterAll(async () => {
    provider?.release();
    await provider?.close();
  });

  it('a turn runs without recall once the bound has passed, and keeps nothing', async () => {
    const message = 'show context about the hung provider';
    const before = seen.contexts.length;
    const started = Date.now();
    const turn = await fay.call('POST', '/api/chat/once', { message });
    const took = Date.now() - started;
    expect(turn.status).toBe(200);
    // The provider was asked and never answered: the bound ended the wait, in one try.
    expect(provider.inputs.filter((i) => i.includes(message))).toHaveLength(1);
    expect(took).toBeGreaterThanOrEqual(RECALL_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(RECALL_TIMEOUT_MS + 3_000);
    expect(seen.contexts.length).toBe(before + 1);
    expect(seen.contexts.at(-1) ?? []).toEqual([]);
    // Recall did not run, so the message is not kept as memory either.
    const { rows } = await pool.query(
      `select count(*)::int as n from app.memory_index where tenant_id = $1`,
      [fayTenant],
    );
    expect(rows[0].n).toBe(0);
  });

  it('the recall API answers 503 within the bound', async () => {
    const started = Date.now();
    const res = await fay.call('GET', `/api/memory/recall?${new URLSearchParams({ q: 'tarp' })}`);
    expect(Date.now() - started).toBeLessThan(RECALL_TIMEOUT_MS + 3_000);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'recall_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain(provider.url);
  });
});
