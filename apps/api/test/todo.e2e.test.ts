// Boots the real, compiled API against real Postgres and Redis, with the scripted
// model, and checks the rules from Steps 6–10 hold end to end.
//
// It imports dist/, not src/: Vitest compiles TypeScript with esbuild, which emits no
// decorator metadata, and Nest's dependency injection needs it. That is why `test`
// depends on `build` in turbo.json.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: INestApplication;
let base: string;

/** A trusted origin: Better Auth rejects browser-like requests (Node's fetch) without one. */
const origin = (process.env.WEB_ORIGINS ?? 'http://localhost:8081').split(',')[0].trim();
const stamp = Date.now();

// biome-ignore lint/suspicious/noExplicitAny: JSON bodies; the assertions check their shape
type Json = any;
type Res<T = Json> = { status: number; body: T };

/** One signed-in person: keeps the session cookie from set-cookie, like a browser. */
class Person {
  cookie = '';
  id = '';
  constructor(
    readonly name: string,
    readonly email = `${name.toLowerCase()}-${stamp}@test.local`,
  ) {}

  async call<T = Json>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        origin,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length > 0) this.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async signUp() {
    const res = await this.call('POST', '/api/auth/sign-up/email', {
      name: this.name,
      email: this.email,
      password: 'password123',
    });
    this.id = res.body?.user?.id ?? '';
    return res;
  }

  chat(content: string) {
    return this.call('POST', '/api/chat', { messages: [{ role: 'user', content }] });
  }
}

const alice = new Person('Alice');
const bob = new Person('Bob');

beforeAll(async () => {
  process.env.MODEL_MODE = 'fake';
  const { AppModule } = await import('../dist/app.module.js');
  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  app.enableCors({ origin, credentials: true });
  await app.listen(0); // a random free port
  base = (await app.getUrl()).replace('[::1]', 'localhost');
  process.env.API_INTERNAL_URL = base; // the agent's tools call this same app
});

afterAll(async () => {
  await app?.close();
});

describe('to-dos, end to end', () => {
  let plumberId = '';

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
    expect(second.body.todo.id).toBe(first.body.todo.id);

    const list = await alice.call('GET', '/api/todos');
    expect(list.body.map((t: { title: string }) => t.title)).toEqual(['Buy cement']);
  });

  it("4. Bob gets 404 patching Alice's to-do, and sees an empty list", async () => {
    const [aliceTodo] = (await alice.call('GET', '/api/todos')).body;
    const patch = await bob.call('PATCH', `/api/todos/${aliceTodo.id}`, { done: true });
    expect(patch.status).toBe(404);
    expect((await bob.call('GET', '/api/todos')).body).toEqual([]);
  });

  it('5. "add Call the plumber" through chat; "list" shows it', async () => {
    const add = await alice.chat('add Call the plumber');
    expect(add.status).toBe(200);
    expect(add.body.toolCalls).toEqual([{ tool: 'add-todo', ok: true }]);

    const list = await alice.chat('list');
    expect(list.body.reply).toContain('Call the plumber');
    plumberId = (await alice.call('GET', '/api/todos')).body.find(
      (t: { title: string }) => t.title === 'Call the plumber',
    ).id;
  });

  it("6. the agent's delete is parked; Bob gets 404 approving; Alice approves; it is gone", async () => {
    const del = await alice.chat('delete Call the plumber');
    expect(del.body.toolCalls.map((c: { tool: string }) => c.tool)).toEqual([
      'list-todos',
      'delete-todo',
    ]);
    // Parked, not deleted.
    const titles = async () =>
      (await alice.call('GET', '/api/todos')).body.map((t: { title: string }) => t.title);
    expect(await titles()).toContain('Call the plumber');

    const [approval] = (await alice.call('GET', '/api/approvals')).body;
    expect(approval.summary).toBe('Delete "Call the plumber"');

    const bobTry = await bob.call('POST', `/api/approvals/${approval.id}/approve`);
    expect(bobTry.status).toBe(404);

    const ok = await alice.call('POST', `/api/approvals/${approval.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(await titles()).not.toContain('Call the plumber');
    expect(plumberId).not.toBe('');
  });
});
