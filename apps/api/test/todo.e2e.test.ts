// Boots the real, compiled API against real Postgres and Redis, with the scripted
// model, and checks the rules from Steps 6–10 hold end to end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, shutdown, stamp } from './support.js';

const alice = new Person('Alice');
const bob = new Person('Bob');

beforeAll(boot);
afterAll(shutdown);

const titles = async (who: Person, query = '') =>
  (await who.call('GET', `/api/todos${query}`)).body.items.map((t: { title: string }) => t.title);

describe('to-dos, end to end', () => {
  it('1. Alice and Bob sign up', async () => {
    for (const person of [alice, bob]) {
      const res = await person.signUp();
      expect(res.status).toBe(200);
      expect(person.id).not.toBe('');
      expect(person.cookie).toContain('session_token');
    }
  });

  it('2. a call without a session gets 401', async () => {
    const res = await new Person('Nobody').call('GET', '/api/todos');
    expect(res.status).toBe(401);
  });

  it('3. two POSTs with one idempotency key create one to-do', async () => {
    const key = { 'idempotency-key': `e2e-${stamp}` };
    const first = await alice.call('POST', '/api/todos', { title: 'Buy cement' }, key);
    const second = await alice.call('POST', '/api/todos', { title: 'Buy cement' }, key);
    expect(first.status).toBe(201);
    expect(second.body.value.id).toBe(first.body.value.id);
    expect(await titles(alice)).toEqual(['Buy cement']);
  });

  it("4. Bob gets 404 patching Alice's to-do, and sees an empty list", async () => {
    const [aliceTodo] = (await alice.call('GET', '/api/todos')).body.items;
    const patch = await bob.call('PATCH', `/api/todos/${aliceTodo.id}`, { done: true });
    expect(patch.status).toBe(404);
    expect((await bob.call('GET', '/api/todos')).body.items).toEqual([]);
  });

  it('5. "add Call the plumber" through chat; "list" shows it', async () => {
    const add = await alice.chat('add Call the plumber');
    expect(add.status).toBe(200);
    expect(add.body.toolCalls).toEqual([{ tool: 'create-todo', ok: true }]);
    const list = await alice.chat('list');
    expect(list.body.reply).toContain('Call the plumber');
  });

  it("6. the agent's delete is parked; Bob gets 404 approving; Alice approves; it is gone", async () => {
    const del = await alice.chat('delete Call the plumber');
    expect(del.body.toolCalls.map((c: { tool: string }) => c.tool)).toEqual([
      'list-todos',
      'delete-todo',
    ]);
    expect(await titles(alice)).toContain('Call the plumber'); // parked, not deleted

    const [approval] = (await alice.call('GET', '/api/approvals')).body;
    expect(approval.summary).toBe('Delete "Call the plumber"');
    expect(approval.requestedBy).toBe('agent');

    expect((await bob.call('POST', `/api/approvals/${approval.id}/approve`)).status).toBe(404);
    const ok = await alice.call('POST', `/api/approvals/${approval.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(await titles(alice)).not.toContain('Call the plumber');
  });

  it('7. list grammar: filter, sort and a second page by cursor', async () => {
    for (const [title, dueOn] of [
      ['Pour slab', '2026-11-03'],
      ['Fix gate', '2026-11-01'],
      ['Paint wall', '2026-11-02'],
      ['Order tiles', undefined],
    ] as const) {
      await alice.call('POST', '/api/todos', { title, ...(dueOn ? { dueOn } : {}) });
    }
    await alice.call(
      'PATCH',
      `/api/todos/${(await alice.call('GET', '/api/todos?q=gate')).body.items[0].id}`,
      { done: true },
    );

    const first = await alice.call('GET', '/api/todos?done=false&sort=-dueOn&limit=2&count=true');
    expect(first.status).toBe(200);
    expect(first.body.items.map((t: { title: string }) => t.title)).toEqual([
      'Pour slab',
      'Paint wall',
    ]);
    expect(first.body.total).toBe(3 + 1); // Buy cement, Pour slab, Paint wall, Order tiles
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await alice.call(
      'GET',
      `/api/todos?done=false&sort=-dueOn&limit=2&cursor=${first.body.nextCursor}`,
    );
    // Undated to-dos sort last and are not skipped by the cursor.
    expect(second.body.items.map((t: { title: string }) => t.title)).toEqual([
      'Buy cement',
      'Order tiles',
    ]);
    expect(second.body.nextCursor).toBeNull();

    // Operators, search, and refusals of what was not declared.
    expect(await titles(alice, '?dueOn[lte]=2026-11-02&sort=dueOn')).toEqual([
      'Fix gate',
      'Paint wall',
    ]);
    expect(await titles(alice, '?q=TILE')).toEqual(['Order tiles']);
    expect((await alice.call('GET', '/api/todos?colour=red')).status).toBe(400);
    expect((await alice.call('GET', '/api/todos?sort=ownerId')).status).toBe(400);
    const otherSort = await alice.call(
      'GET',
      `/api/todos?sort=title&cursor=${first.body.nextCursor}`,
    );
    expect(otherSort.status).toBe(400);
    expect(otherSort.body.error).toBe('cursor_sort_mismatch');
  });
});
