// Shared by the e2e files: boot the compiled app once per file, and a signed-in Person.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';

// biome-ignore lint/suspicious/noExplicitAny: JSON bodies; the assertions check their shape
export type Json = any;
export type Res<T = Json> = { status: number; body: T; headers: Headers };

/** A trusted origin: Better Auth rejects browser-like requests (Node's fetch) without one. */
export const origin = (process.env.WEB_ORIGINS ?? 'http://localhost:8081').split(',')[0].trim();
export const stamp = Date.now();

export const server = { base: '', app: undefined as INestApplication | undefined };

export async function boot() {
  process.env.MODEL_MODE = 'fake';
  // dist/, not src/: Vitest's esbuild emits no decorator metadata, which Nest's DI needs.
  const { AppModule } = await import('../dist/app.module.js');
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  app.enableCors({ origin, credentials: true });
  await app.listen(Number(process.env.TEST_PORT ?? 0)); // a random free port unless pinned
  server.app = app;
  server.base = (await app.getUrl()).replace('[::1]', 'localhost');
  process.env.API_INTERNAL_URL = server.base; // the agent's tools call this same app
}

export async function shutdown() {
  // This run's queues: emptied, so Redis keeps nothing from the tests.
  const { getQueueToken } = await import('@nestjs/bullmq');
  for (const name of [
    'wa-inbound',
    'wa-send',
    'notify-dispatch',
    'templates-sync',
    'channel-maintenance',
  ]) {
    const queue = server.app?.get(getQueueToken(name), { strict: false });
    await queue?.obliterate({ force: true }).catch(() => {});
  }
  await server.app?.close();
  await pool.end();
}

/** Straight to Postgres, for checks the API does not expose (the audit trail). */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** One signed-in person: keeps the session cookie from set-cookie, like a browser. */
export class Person {
  cookie = '';
  id = '';
  constructor(
    readonly name: string,
    readonly email = `${name.toLowerCase().replace(/\s/g, '')}-${stamp}@test.local`,
  ) {}

  async call<T = Json>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> {
    const res = await fetch(`${server.base}${path}`, {
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
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
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

  /** One turn as JSON (/api/chat/once). Surfaces default to text, as for any plain caller. */
  chat(content: string, context?: object, surfaces?: string[]) {
    return this.call('POST', '/api/chat/once', {
      message: content,
      ...(context ? { context } : {}),
      ...(surfaces ? { surfaces } : {}),
    });
  }

  /** One turn as the app sends it: the AI SDK stream, returned as its parsed SSE events. */
  async stream(content: string, surfaces = ['inline', 'canvas'], context?: object) {
    const res = await fetch(`${server.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: this.cookie },
      body: JSON.stringify({
        message: content,
        surfaces,
        ...(context ? { context } : {}),
      }),
    });
    const text = await res.text();
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown> & { type: string });
    return { status: res.status, headers: res.headers, events };
  }
}

/** The business and roles the API sees for this person (GET /api/me). */
export async function me(person: Person): Promise<{ tenantId: string; roles: string[] }> {
  return (await person.call('GET', '/api/me')).body;
}

/** Give a person roles in another business (the invitation flow is not built yet). */
export async function addMember(person: Person, tenantId: string, roles: string[]) {
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, is_default) values ($1, $2, $3, false)
     on conflict (tenant_id, user_id) do update set roles = excluded.roles`,
    [tenantId, person.id, roles],
  );
}

/**
 * A WhatsApp contact without an account: a customer of the business, as the inbound pipeline
 * creates one on a first message.
 */
export async function seedContact(tenantId: string, name: string, address: string) {
  const { rows } = await pool.query(
    `with c as (insert into app.customers (tenant_id, display_name) values ($1, $2) returning id)
     insert into channel.contacts (tenant_id, address, profile_name, customer_id)
     select $1, $3, $2, c.id from c returning id, customer_id`,
    [tenantId, name, address],
  );
  await pool.query('update app.customers set contact_id = $1 where id = $2', [
    rows[0].id,
    rows[0].customer_id,
  ]);
  return { contactId: rows[0].id as string, customerId: rows[0].customer_id as string };
}

/** The assistant's own API calls, acting for someone ("user:<id>", "contact:<id>"). */
export function asAssistant(actingFor: string, extra: Record<string, string> = {}) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-key': process.env.AGENT_API_KEY ?? '',
        'x-agent-id': 'assistant',
        'x-acting-for': actingFor,
        'x-run-id': `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
        'x-channel': 'whatsapp',
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

/** Wait until a check passes (async replies, queued work), or fail with what it last saw. */
export async function eventually<T>(
  check: () => Promise<T | undefined> | T | undefined,
  ms = 10_000,
) {
  const until = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < until) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting (last: ${JSON.stringify(last)})`);
}
