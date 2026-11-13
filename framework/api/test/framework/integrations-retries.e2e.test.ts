// Retries and the integration bus (V6): a write repeated with its idempotency-key is the first
// write again (one endpoint, one connection, one rotation, the same secret), a different body
// under the same key is a 409, and an endpoint gets only events that happened after it was made.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, eventually, me, Person, pool, shutdown } from '../../dist/testing.js';
import { integrationsApp } from '../fixture/dist/features/integrations/index.js';

process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.INTEGRATIONS_ALLOWED_HOSTS = '127.0.0.1';
process.env.INTEGRATIONS_RETRY_SCHEDULE = '100ms,100ms,100ms';

const received: { path: string; body: string }[] = [];
let receiver: Server;
let base = '';
const at = (path: string) => received.filter((r) => r.path === path);

const ana = new Person('Ana Retries');
let tenantId = '';

const post = (path: string, body: unknown, key: string) =>
  ana.call('POST', path, body, { 'idempotency-key': key });

const count = async (sql: string, args: unknown[]) =>
  Number((await pool.query(sql, args)).rows[0].n);

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '/', body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  await boot(integrationsApp);
  await ana.signUp();
  tenantId = (await me(ana)).tenantId;
});

afterAll(async () => {
  await shutdown();
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('an endpoint asked for twice with one key', () => {
  it('is one endpoint, answered with the same id and secret', async () => {
    const key = randomUUID();
    const body = { url: `${base}/idem/one`, events: ['nothing.here'] };
    const first = await post('/api/integrations/endpoints', body, key);
    const again = await post('/api/integrations/endpoints', body, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.value.id).toBe(first.body.value.id);
    expect(again.body.secret).toBe(first.body.secret);
    expect(
      await count('select count(*) n from app.integration_endpoints where url = $1', [body.url]),
    ).toBe(1);
    expect(
      await count(
        `select count(*) n from audit.events
          where action = 'integrations.endpoint.create' and resource_id = $1`,
        [first.body.value.id],
      ),
    ).toBe(1);
    // The secret is read back from the endpoint's sealed row: none is kept with the reply.
    const stored = await pool.query('select response from app.idempotency where key = $1', [key]);
    expect(JSON.stringify(stored.rows[0].response)).not.toContain(first.body.secret);
  });

  it('at the same moment, is still one endpoint with one secret', async () => {
    const key = randomUUID();
    const body = { url: `${base}/idem/race`, events: ['nothing.here'] };
    const [a, b] = await Promise.all([
      post('/api/integrations/endpoints', body, key),
      post('/api/integrations/endpoints', body, key),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.value.id).toBe(a.body.value.id);
    expect(b.body.secret).toBe(a.body.secret);
    expect(
      await count('select count(*) n from app.integration_endpoints where url = $1', [body.url]),
    ).toBe(1);
  });

  it('with another body is a 409, and nothing is made', async () => {
    const key = randomUUID();
    const first = await post(
      '/api/integrations/endpoints',
      { url: `${base}/idem/a`, events: ['nothing.here'] },
      key,
    );
    expect(first.status).toBe(201);
    const other = await post(
      '/api/integrations/endpoints',
      { url: `${base}/idem/b`, events: ['nothing.here'] },
      key,
    );
    expect(other.status).toBe(409);
    expect(
      await count('select count(*) n from app.integration_endpoints where url = $1', [
        `${base}/idem/b`,
      ]),
    ).toBe(0);
  });

  it('a rotation repeated rotates once: the secret before it stays the previous one', async () => {
    const made = await post(
      '/api/integrations/endpoints',
      { url: `${base}/idem/rotate`, events: ['nothing.here'] },
      randomUUID(),
    );
    const id = made.body.value.id as string;
    const key = randomUUID();
    const first = await post(`/api/integrations/endpoints/${id}/rotate`, undefined, key);
    const again = await post(`/api/integrations/endpoints/${id}/rotate`, undefined, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.secret).toBe(first.body.secret);
    expect(first.body.secret).not.toBe(made.body.secret);
    expect(
      await count(
        `select count(*) n from audit.events
          where action = 'integrations.endpoint.rotate' and resource_id = $1`,
        [id],
      ),
    ).toBe(1);
  });

  it('a change repeated is one change', async () => {
    const made = await post(
      '/api/integrations/endpoints',
      { url: `${base}/idem/patch`, events: ['nothing.here'] },
      randomUUID(),
    );
    const id = made.body.value.id as string;
    const key = randomUUID();
    for (let i = 0; i < 2; i++) {
      const res = await ana.call(
        'PATCH',
        `/api/integrations/endpoints/${id}`,
        { description: 'once' },
        { 'idempotency-key': key },
      );
      expect(res.status).toBe(200);
    }
    expect(
      await count(
        `select count(*) n from audit.events
          where action = 'integrations.endpoint.update' and resource_id = $1`,
        [id],
      ),
    ).toBe(1);
  });
});

describe('a repeat and who asks it', () => {
  it('shows the secret again only to whom the write would still allow', async () => {
    const ada = new Person('Ada Retries');
    await ada.signUp();
    await addMember(ada, tenantId, ['admin']);
    const headers = { 'x-tenant-id': tenantId, 'idempotency-key': randomUUID() };
    const body = { url: `${base}/idem/demoted`, events: ['nothing.here'] };
    const first = await ada.call('POST', '/api/integrations/endpoints', body, headers);
    expect(first.status).toBe(201);
    // No longer one who manages integrations: the stored answer gives away no secret.
    await addMember(ada, tenantId, ['staff']);
    const again = await ada.call('POST', '/api/integrations/endpoints', body, headers);
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({ rule: 'integrations_manage_needed' });
    expect(JSON.stringify(again.body)).not.toContain(first.body.secret);
  });
});

describe('a connection asked for twice with one key', () => {
  it('is one connection, with the same generated credentials', async () => {
    const key = randomUUID();
    const label = `retry ${key}`;
    const body = { connector: 'standard-webhooks', label };
    const first = await post('/api/integrations/connections', body, key);
    const again = await post('/api/integrations/connections', body, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.value.id).toBe(first.body.value.id);
    expect(first.body.credentials).toBeDefined();
    expect(again.body.credentials).toEqual(first.body.credentials);
    expect(
      await count('select count(*) n from app.integration_connections where label = $1', [label]),
    ).toBe(1);
  });
});

describe('an endpoint and the events before it', () => {
  it('gets no delivery for an event that happened before it was made, and one after', async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Before the endpoint' });
    expect(created.status).toBe(201);
    const taskId = created.body.value.id as string;
    const made = await post(
      '/api/integrations/endpoints',
      { url: `${base}/since`, events: ['task.*'] },
      randomUUID(),
    );
    expect(made.status).toBe(201);
    // A stored event of that task from before the endpoint, relayed only now (held, or late).
    const before = `evt-before-${randomUUID()}`;
    await pool.query(
      `insert into app.domain_events (id, tenant_id, name, resource_type, resource_id, row,
         actor_kind, actor_id, occurred_at, available_at, queues)
       select $1, $2, 'task.updated', 'task', $3, e.row, 'user', $4,
              now() - interval '1 minute', now(), $5
         from app.domain_events e where e.resource_id = $3 and e.name = 'task.created'`,
      [before, tenantId, taskId, ana.id, process.env.BULL_PREFIX],
    );
    const later = await ana.call('PATCH', `/api/tasks/${taskId}`, { title: 'After the endpoint' });
    expect(later.status).toBe(200);
    await eventually(() => at('/since').find((r) => r.body.includes('After the endpoint')));
    await eventually(
      async () =>
        (await pool.query('select relayed_at from app.domain_events where id = $1', [before]))
          .rows[0]?.relayed_at ?? undefined,
    );
    // Both went to the subscriber's queue together: give the earlier one time to fan out.
    await new Promise((r) => setTimeout(r, 1500));
    expect(at('/since').filter((r) => r.body.includes(before))).toEqual([]);
    expect(
      await count('select count(*) n from app.integration_deliveries where event_id = $1', [
        before,
      ]),
    ).toBe(0);
  });
});
