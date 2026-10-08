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
  await app.listen(0); // a random free port
  server.app = app;
  server.base = (await app.getUrl()).replace('[::1]', 'localhost');
  process.env.API_INTERNAL_URL = server.base; // the agent's tools call this same app
}

export async function shutdown() {
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
