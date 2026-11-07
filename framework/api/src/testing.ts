// For end-to-end tests (the framework's and an application's): boot the app once per file
// against real Postgres and Redis, with the scripted model, and sign people in.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import type { Basecamp } from './runtime.js';

// biome-ignore lint/suspicious/noExplicitAny: JSON bodies; the assertions check their shape
export type Json = any;
export type Res<T = Json> = { status: number; body: T; headers: Headers };

/** A trusted origin: Better Auth rejects browser-like requests (Node's fetch) without one. */
export const origin = (process.env.WEB_ORIGINS ?? 'http://localhost:8081').split(',')[0].trim();
export const stamp = Date.now();

export const server = { base: '', app: undefined as INestApplication | undefined };

/**
 * Boot the API for an application. Import this from the compiled package (@hykr/api/testing),
 * not from source: Vitest's esbuild emits no decorator metadata, which Nest's DI needs.
 */
export async function boot(application: Basecamp) {
  process.env.MODEL_MODE = 'fake';
  const { setRuntime } = await import('./runtime.js');
  setRuntime(application);
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  // As startApi does (verified custom domains included), plus the tests' own origin.
  const { corsOrigin } = await import('./infra/cors.js');
  const check = corsOrigin();
  app.enableCors({
    origin: (o: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
      o === origin ? cb(null, true) : check(o, cb),
    credentials: true,
  });
  await app.listen(Number(process.env.TEST_PORT ?? 0)); // a random free port unless pinned
  server.app = app;
  server.base = (await app.getUrl()).replace('[::1]', 'localhost');
  process.env.API_INTERNAL_URL = server.base; // the agent's tools call this same app
}

export async function shutdown() {
  // Every queue this run registered (the channel's, the features', the app's): emptied, so Redis
  // keeps nothing from the tests.
  const { getQueueToken } = await import('@nestjs/bullmq');
  const { queues } = await import('./hooks.js');
  for (const { name } of queues.all()) {
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

/**
 * Settings written straight to the database, as tests do: the server caches each business's
 * settings for a few seconds (and reads them on every request), so drop its copy right after.
 */
export async function settingsChanged(tenantId?: string) {
  const { TenantConfigService } = await import('@hykr/core');
  server.app?.get(TenantConfigService).invalidate(tenantId);
}

/**
 * Change a business's settings straight in the database, as an operator would, then drop this
 * process's cached copy (`TenantConfigService`), so the next request reads the change at once.
 * Each key of `patch` replaces that whole section (`{ quietHours: {...} }`); null removes it.
 * Use it instead of a bare UPDATE: any request before it (`GET /api/me`) caches the settings
 * for a few seconds, and a stale copy makes a test depend on the hour or the timing.
 */
export async function setTenantSettings(tenantId: string, patch: Record<string, unknown>) {
  const removed = Object.keys(patch).filter((k) => patch[k] === null);
  const merged = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  await pool.query(
    'update app.tenants set settings = (settings || $2::jsonb) - $3::text[] where id = $1',
    [tenantId, JSON.stringify(merged), removed],
  );
  const { TenantConfigService } = await import('@hykr/core');
  server.app?.get(TenantConfigService, { strict: false }).invalidate(tenantId);
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

/** The application the test booted (its catalog, registry, notifications and assistant). */
export { runtime } from './runtime.js';

/** What one MCP tool call answered: its text, and whether it is an error result. */
export type McpToolOut = { text: string; isError: boolean };

/** An outside AI client a person connected over MCP (A1), with its tokens. */
export interface McpConnection {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** The scopes the token holds. */
  scope: string;
  /** The tool names the MCP endpoint lists for this token, sorted. */
  tools(): Promise<string[]>;
  /** Call one tool by its name (`todos_read`) over MCP. */
  call(tool: string, args: object): Promise<McpToolOut>;
  close(): Promise<void>;
}

/** A loopback redirect: a client on the person's computer. */
export const MCP_TEST_REDIRECT = 'http://127.0.0.1:43123/callback';

let mcpClients = 0;

/**
 * Connect an MCP client for a signed-in person, as a real one does: it registers itself, sends
 * the person to authorize (they are signed in, so straight to consent), the person allows
 * `accept` of the `scope` asked for, and it trades the code with its PKCE verifier. Then an MCP
 * client over HTTP (protocol 2026-07-28) with the token.
 */
export async function connectMcp(
  person: Person,
  scope: string,
  accept: string = scope,
  name = `Client of ${person.name}`,
): Promise<McpConnection> {
  const { createHash, randomBytes } = await import('node:crypto');
  const json = async (res: Response) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP connect: ${res.status} ${text}`);
    return JSON.parse(text) as Json;
  };
  const resource = (
    await json(await fetch(`${server.base}/.well-known/oauth-protected-resource/mcp`))
  ).resource as string;
  const client = await json(
    await fetch(`${server.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [MCP_TEST_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: MCP_TEST_REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope,
    state: 'test',
    resource,
  });
  const asked = await person.call('GET', `/api/auth/oauth2/authorize?${query}`, undefined, {
    accept: 'application/json',
  });
  const consented = await person.call('POST', '/api/auth/oauth2/consent', {
    accept: true,
    scope: accept,
    oauth_query: new URL(asked.body.url).search.slice(1),
  });
  if (consented.status !== 200) throw new Error(`MCP consent: ${JSON.stringify(consented.body)}`);
  const code = new URL(consented.body.url).searchParams.get('code') ?? '';
  const tokens = await json(
    await fetch(`${server.base}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: MCP_TEST_REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        resource,
      }).toString(),
    }),
  );
  const { MCPClient } = await import('@mastra/mcp');
  mcpClients += 1;
  const mcp = new MCPClient({
    id: `mcp-test-${stamp}-${mcpClients}`,
    servers: {
      app: {
        url: new URL(`${server.base}/mcp`),
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
        protocolVersion: '2026-07-28',
      },
    },
  });
  const tools = () => mcp.listTools();
  return {
    clientId: client.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    tools: async () =>
      Object.keys(await tools())
        .map((n) => n.replace(/^app_/, ''))
        .sort(),
    async call(tool, args) {
      const found = (await tools())[`app_${tool}`];
      if (!found?.execute) throw new Error(`No MCP tool ${tool}`);
      try {
        const out = (await found.execute(args as never, {} as never)) as {
          content?: { type: string; text?: string }[];
          isError?: boolean;
          error?: boolean;
          message?: string;
        };
        // The client checks the input against the tool's schema before sending anything.
        if (out?.error === true) return { text: out.message ?? '', isError: true };
        const text = (out?.content ?? []).map((c) => c.text ?? '').join('\n');
        return { text, isError: !!out?.isError };
      } catch (e) {
        return { text: String((e as Error).message ?? e), isError: true };
      }
    },
    close: () => mcp.disconnect(),
  };
}
