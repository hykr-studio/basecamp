// The to-dos module with live updates: a to-do the assistant adds shows up on Alice's other
// open screens without a reload (GET /api/live), never on Bob's.
import { boot, eventually, origin, Person, server, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const alice = new Person('Alice Live');
const bob = new Person('Bob Live');
const streams: AbortController[] = [];

/** A live stream, its raw text collected as it arrives. */
async function listen(who: Person) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${server.base}/api/live`, {
    headers: { origin, cookie: who.cookie },
    signal: controller.signal,
  });
  const s = { text: '' };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        s.text += decoder.decode(value, { stream: true });
      }
    } catch {
      // closed
    }
  })();
  await eventually(() => (s.text.includes('event: ready') ? true : undefined));
  return s;
}

beforeAll(async () => {
  await boot(application);
  await alice.signUp();
  await bob.signUp();
});
afterAll(async () => {
  for (const c of streams) c.abort();
  await shutdown();
});

it('a to-do added through the assistant reaches Alice’s stream as ids only, not Bob’s', async () => {
  const mine = await listen(alice);
  const his = await listen(bob);
  const add = await alice.chat('add Order the live tiles');
  expect(add.body.toolCalls).toEqual([{ tool: 'create-todo', ok: true, outcome: 'done' }]);
  const [todo] = (await alice.call('GET', '/api/todos?q=live%20tiles')).body.items;
  const line = `data: ${JSON.stringify({ name: 'todo.created', type: 'todo', id: todo.id })}`;
  // The assistant's to-do is an `internal` change: its event waits out the undo window (10 s,
  // application/domain/src/server/approval-levels.ts) before it leaves.
  await eventually(() => (mine.text.includes(line) ? true : undefined), 20_000);
  expect(mine.text).not.toContain('Order the live tiles');
  await new Promise((r) => setTimeout(r, 2000));
  expect(his.text).not.toContain(todo.id);
});
