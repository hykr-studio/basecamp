// The to-dos module is offline-capable (decisions B12): a to-do added on a phone without a network
// arrives with the id the phone chose, and a retry of it changes nothing; to-dos are versioned, so
// a tick made on two phones offline is applied once and the second is a conflict, never a silent
// overwrite. Another business never reaches a to-do, whatever it sends.
import { randomUUID } from 'node:crypto';
import { boot, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const ana = new Person('Ana Offline');
const stranger = new Person('Stranger Offline');

beforeAll(async () => {
  await boot(application);
  for (const p of [ana, stranger]) await p.signUp();
});
afterAll(shutdown);

const add = (title: string, id = randomUUID(), key = randomUUID()) =>
  ana.call('POST', '/api/todos', { id, title }, { 'idempotency-key': key });

describe('to-dos captured offline', () => {
  it('arrive with the id the phone chose, once, however often they are sent', async () => {
    const id = randomUUID();
    const key = randomUUID();
    const first = await add('Measure the hall', id, key);
    expect(first.status).toBe(201);
    expect(first.body.value).toMatchObject({ id, title: 'Measure the hall', version: 1 });
    const again = await add('Measure the hall', id, key);
    expect(again.body).toEqual(first.body);
    const titles = (await ana.call('GET', '/api/todos')).body.items.filter(
      (t: { id: string }) => t.id === id,
    );
    expect(titles).toHaveLength(1);
  });

  it('a tick from a second phone on an old version is a conflict', async () => {
    const todo = (await add('Order the paint')).body.value;
    const phoneA = await ana.call(
      'PATCH',
      `/api/todos/${todo.id}`,
      { done: true },
      { 'if-match': `"${todo.version}"`, 'idempotency-key': randomUUID() },
    );
    expect(phoneA.status).toBe(200);
    expect(phoneA.body.value).toMatchObject({ done: true, version: 2 });
    const phoneB = await ana.call(
      'PATCH',
      `/api/todos/${todo.id}`,
      { title: 'Order the blue paint' },
      { 'if-match': `"${todo.version}"`, 'idempotency-key': randomUUID() },
    );
    expect(phoneB.status).toBe(409);
    expect(phoneB.body.error).toBe('stale');
    const now = (await ana.call('GET', `/api/todos/${todo.id}`)).body;
    expect(now).toMatchObject({ title: 'Order the paint', done: true, version: 2 });
  });

  it("another business's to-do is not there, and its id is taken", async () => {
    const todo = (await add('Not yours')).body.value;
    const patched = await stranger.call(
      'PATCH',
      `/api/todos/${todo.id}`,
      { done: true },
      { 'if-match': '"1"' },
    );
    expect(patched.status).toBe(404);
    const reused = await stranger.call('POST', '/api/todos', { id: todo.id, title: 'Mine now' });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe('id_taken');
  });
});
