// The integration bus (B10): webhook endpoints and connections managed through the write path,
// signed outbound deliveries projected for each endpoint, retries and the delivery log, the
// egress guard at send time, and inbound webhooks verified, stored once and handled as the
// business's system principal. The fixture's features/integrations supplies a field policy
// (a task's due date), a write hook, an opted-out entity, an HMAC sender and handlers.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signWebhook, verifyWebhook } from '@hykr/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveriesService } from '../../dist/features/integrations/deliveries.service.js';
import { InboundService } from '../../dist/features/integrations/inbound.service.js';
import { checkSettings } from '../../dist/features/integrations/settings.js';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { handled, integrationsApp } from '../fixture/dist/features/integrations/index.js';

// Read when used: set before the app boots.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.INTEGRATIONS_ALLOWED_HOSTS = '127.0.0.1';
process.env.INTEGRATIONS_RETRY_SCHEDULE = '100ms,100ms,100ms';
process.env.INTEGRATIONS_TIMEOUT_MS = '3000';

/* ── A receiver: records each request; answers per path ────────────────────── */

type Received = { path: string; headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
/** Statuses a path answers with, in order; the last repeats. Default 200. */
const answers = new Map<string, number[]>();
/** What a path answers with. Default `answer <status>`. */
const bodies = new Map<string, string>();
let receiver: Server;
let base = '';

const at = (path: string) => received.filter((r) => r.path === path);
const answer = (path: string, ...statuses: number[]) => answers.set(path, statuses);

/* ── People ─────────────────────────────────────────────────────────────────── */

const ana = new Person('Ana Bus'); // owner: integrations.manage and fixture.tasks.dates
const ada = new Person('Ada Bus'); // admin in Ana's business: integrations.manage only
const sam = new Person('Sam Bus'); // staff in Ana's business: neither
const ravi = new Person('Ravi Bus'); // owner of another business
let anaTenant = '';
let raviTenant = '';
const inAna = { 'x-tenant-id': '' };

const asAda = (method: string, path: string, body?: unknown) => ada.call(method, path, body, inAna);
const asSam = (method: string, path: string, body?: unknown) => sam.call(method, path, body, inAna);

async function endpoint(person: Person, body: object, headers: Record<string, string> = {}) {
  const res = await person.call('POST', '/api/integrations/endpoints', body, headers);
  if (res.status !== 201) throw new Error(`endpoint: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.value?.id as string, secret: res.body.secret as string, res };
}

const task = async (person: Person, body: object) => {
  const res = await person.call('POST', '/api/tasks', body);
  if (res.status !== 201) throw new Error(`task: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.value as { id: string; title: string };
};

const deliveryRows = async (endpointId: string) =>
  (
    await pool.query(
      `select id, status, attempts, event_name, last_status, last_error
         from app.integration_deliveries where endpoint_id = $1 order by created_at`,
      [endpointId],
    )
  ).rows;

const auditOf = async (action: string, resourceId?: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, actor_id, channel, run_id, after
         from audit.events where action = $1 and ($2::text is null or resource_id = $2) order by at`,
      [action, resourceId ?? null],
    )
  ).rows;

const parse = (r: Received) => JSON.parse(r.body);

const sweeper = () => server.app?.get(DeliveriesService, { strict: false }) as DeliveriesService;

/** A delivery of a visit event, stored as a worker would have left it. */
const storedDelivery = async (
  endpointId: string,
  set: { status: string; attempts: number; leaseUntil: string },
) =>
  (
    await pool.query(
      `insert into app.integration_deliveries
         (tenant_id, endpoint_id, event_id, event_name, resource_type, body, status, attempts,
          lease_until, next_attempt_at, queues)
       values ($1, $2, $3, 'visit.created', 'visit', $4, $5, $6, now() + $7::interval,
               now() - interval '5 minutes', $8)
       returning id`,
      [
        anaTenant,
        endpointId,
        `evt-${randomUUID()}`,
        JSON.stringify({ type: 'visit.created', data: { row: { id: 'v' } } }),
        set.status,
        set.attempts,
        set.leaseUntil,
        process.env.BULL_PREFIX,
      ],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const path = req.url ?? '/';
      received.push({ path, headers: req.headers, body });
      const list = answers.get(path) ?? [200];
      const status = list.length > 1 ? (list.shift() as number) : list[0];
      res
        .writeHead(status, { 'content-type': 'text/plain' })
        .end(bodies.get(path) ?? `answer ${status}`);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  await boot(integrationsApp);
  for (const p of [ana, ada, sam, ravi]) await p.signUp();
  anaTenant = (await me(ana)).tenantId;
  raviTenant = (await me(ravi)).tenantId;
  inAna['x-tenant-id'] = anaTenant;
  await addMember(ada, anaTenant, ['admin']);
  await addMember(sam, anaTenant, ['staff']);
});

afterAll(async () => {
  await shutdown();
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('who manages integrations', () => {
  it('staff without integrations.manage are refused, and the refused write is audited', async () => {
    expect((await asSam('GET', '/api/integrations/endpoints')).status).toBe(403);
    const res = await asSam('POST', '/api/integrations/endpoints', {
      url: `${base}/ok/staff`,
      events: ['*'],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'integrations_manage_needed' });
    const refused = await auditOf('integrations.endpoint.create');
    expect(refused).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'integrations_manage_needed' }),
    );
    expect(at('/ok/staff')).toHaveLength(0);
  });

  it('the assistant cannot reach the routes at all', async () => {
    const res = await asAssistant(`user:${ana.id}`)('GET', '/api/integrations/endpoints');
    expect(res.status).toBe(403);
  });

  it('owners and admins can; the connectors are listed', async () => {
    expect((await asAda('GET', '/api/integrations/endpoints')).status).toBe(200);
    const list = await ana.call('GET', '/api/integrations/connectors');
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['standard-webhooks', 'fixture-sender']),
    );
  });
});

describe('endpoints', () => {
  it('the signing secret is returned once and stored sealed', async () => {
    const { id, secret, res } = await endpoint(ana, {
      url: `${base}/ok/sealed`,
      events: ['visit.created'],
      description: 'Sealed',
    });
    expect(secret).toMatch(/^whsec_/);
    expect(res.body.value).toMatchObject({ id, status: 'active', events: ['visit.created'] });
    expect(JSON.stringify(res.body.value)).not.toContain(secret);
    const got = await ana.call('GET', `/api/integrations/endpoints/${id}`);
    expect(got.body).toMatchObject({ id, url: `${base}/ok/sealed`, description: 'Sealed' });
    expect(JSON.stringify(got.body)).not.toContain('whsec_');
    const { rows } = await pool.query(
      'select secret_sealed from app.integration_endpoints where id = $1',
      [id],
    );
    expect(rows[0].secret_sealed).toMatch(/^v1\./);
    expect(rows[0].secret_sealed).not.toContain(secret.slice(6));
    const created = await auditOf('integration_endpoint.create', id);
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0].after)).not.toContain('v1.');
  });

  it.each([
    ['https://localhost/hook', 'not a public host name'],
    ['https://10.0.0.7/hook', 'not a public address'],
    ['https://169.254.169.254/latest', 'not a public address'],
    ['http://example.com/hook', 'only https'],
    ['https://user:pw@example.com/hook', 'user name or password'],
    ['http://127.0.0.2:9/hook', 'not a public address'],
  ])('refuses %s', async (url, reason) => {
    const res = await ana.call('POST', '/api/integrations/endpoints', { url, events: ['*'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(reason);
  });

  it('refuses unknown fields, bad patterns and unknown capabilities', async () => {
    const url = `${base}/ok/x`;
    for (const body of [
      { url, events: [] },
      { url, events: ['task created'] },
      { url, events: ['*'], capabilities: ['nobody.defines.this'] },
      { url, events: ['*'], secret: 'mine' },
    ])
      expect((await ana.call('POST', '/api/integrations/endpoints', body)).status).toBe(400);
  });

  it('a person can give an endpoint only capabilities they hold', async () => {
    const res = await asAda('POST', '/api/integrations/endpoints', {
      url: `${base}/ok/ada`,
      events: ['task.*'],
      capabilities: ['fixture.tasks.dates'],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ rule: 'capability_not_held' });
    // Nor point an endpoint that has one somewhere else.
    const { id } = await endpoint(ana, {
      url: `${base}/ok/dates-held`,
      events: ['visit.updated'],
      capabilities: ['fixture.tasks.dates'],
    });
    const moved = await asAda('PATCH', `/api/integrations/endpoints/${id}`, {
      url: `${base}/ok/elsewhere`,
    });
    expect(moved.status).toBe(403);
    expect(moved.body).toMatchObject({ rule: 'capability_not_held' });
    // Pausing it sends nothing new anywhere: allowed.
    const paused = await asAda('PATCH', `/api/integrations/endpoints/${id}`, { status: 'paused' });
    expect(paused.body).toMatchObject({ status: 'done', value: { status: 'paused' } });
  });

  it('another business gets 404 for an endpoint, its log, a delivery and a retry', async () => {
    const { id } = await endpoint(ana, { url: `${base}/ok/private`, events: ['task.*'] });
    const made = await task(ana, { title: 'Private delivery' });
    const [delivery] = await eventually(async () => {
      const rows = (await deliveryRows(id)).filter((r) => r.status === 'delivered');
      return rows.length ? rows : undefined;
    });
    expect(made.id).toBeTruthy();
    for (const [method, path] of [
      ['GET', `/api/integrations/endpoints/${id}`],
      ['PATCH', `/api/integrations/endpoints/${id}`],
      ['DELETE', `/api/integrations/endpoints/${id}`],
      ['POST', `/api/integrations/endpoints/${id}/rotate`],
      ['GET', `/api/integrations/endpoints/${id}/deliveries`],
      ['GET', `/api/integrations/deliveries/${delivery.id}`],
      ['POST', `/api/integrations/deliveries/${delivery.id}/retry`],
    ])
      expect(
        (await ravi.call(method, path, method === 'PATCH' ? { status: 'paused' } : undefined))
          .status,
      ).toBe(404);
    expect((await ravi.call('GET', '/api/integrations/endpoints')).body).not.toContainEqual(
      expect.objectContaining({ id }),
    );
  });
});

describe('outbound webhooks', () => {
  let plain: { id: string; secret: string };
  let dated: { id: string; secret: string };

  beforeAll(async () => {
    plain = await endpoint(ana, { url: `${base}/ok/plain`, events: ['task.*'] });
    dated = await endpoint(ana, {
      url: `${base}/ok/dated`,
      events: ['task.created'],
      capabilities: ['fixture.tasks.dates'],
    });
  });

  it('a task’s event reaches the endpoint signed, without internal columns or the hidden date', async () => {
    const made = await task(ana, { title: 'Order paper', dueOn: '2030-05-01' });
    const r = await eventually(() =>
      at('/ok/plain').find((x) => parse(x).data.resourceId === made.id),
    );
    const verified = verifyWebhook({ secret: plain.secret, headers: r.headers, body: r.body });
    expect(verified.ok).toBe(true);
    expect(r.headers['content-type']).toBe('application/json');
    const body = parse(r);
    expect(body).toMatchObject({
      type: 'task.created',
      data: { tenantId: anaTenant, resourceType: 'task', resourceId: made.id },
    });
    expect(body.data.row).toMatchObject({ id: made.id, title: 'Order paper', done: false });
    expect(body.data.row).not.toHaveProperty('dueOn');
    for (const internal of ['tenantId', 'ownerId', 'customerId', 'updatedAt'])
      expect(body.data.row).not.toHaveProperty(internal);
    // The webhook-id is the delivery's id. The worker marks it delivered once the receiver has
    // answered, so the receiver can see the request before the row says so.
    expect(r.headers['webhook-id']).toBeTruthy();
    const delivery = await eventually(async () =>
      (await deliveryRows(plain.id)).find(
        (d) => d.id === r.headers['webhook-id'] && d.status === 'delivered',
      ),
    );
    expect(delivery.event_name).toBe('task.created');
  });

  it('an endpoint given the capability gets the date', async () => {
    const made = await task(ana, { title: 'Book hall', dueOn: '2030-06-01' });
    const r = await eventually(() =>
      at('/ok/dated').find((x) => parse(x).data.resourceId === made.id),
    );
    expect(verifyWebhook({ secret: dated.secret, headers: r.headers, body: r.body }).ok).toBe(true);
    expect(parse(r).data.row).toMatchObject({ title: 'Book hall', dueOn: '2030-06-01' });
  });

  it('the delivery log projects the payload again for whoever reads it', async () => {
    const made = await task(ana, { title: 'Log check', dueOn: '2030-07-01' });
    const delivery = await eventually(async () => {
      const list = await ana.call('GET', `/api/integrations/endpoints/${dated.id}/deliveries`);
      return list.body.items.find(
        (d: { resourceId: string; status: string }) =>
          d.resourceId === made.id && d.status === 'delivered',
      );
    });
    expect(delivery).toMatchObject({ eventName: 'task.created', attempts: 1, lastStatus: 200 });
    const asOwner = await ana.call('GET', `/api/integrations/deliveries/${delivery.id}`);
    expect(asOwner.body.payload.data.row).toMatchObject({ dueOn: '2030-07-01' });
    expect(asOwner.body.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: 200, error: null, response: 'answer 200' }),
    ]);
    const asAdmin = await asAda('GET', `/api/integrations/deliveries/${delivery.id}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.payload.data.row).toMatchObject({ title: 'Log check' });
    expect(asAdmin.body.payload.data.row).not.toHaveProperty('dueOn');
    expect(asAdmin.body).not.toHaveProperty('body');
  });

  it('the delivery log pages back by `before`, and refuses a time Postgres cannot store', async () => {
    // V1 read `before` through storableInstant; a random endpoint answered 404 before reading it.
    const path = `/api/integrations/endpoints/${dated.id}/deliveries`;
    await eventually(async () => {
      const all = await ana.call('GET', path);
      return all.body.items.length >= 2 ? all : undefined;
    });
    for (const before of ['99999', '-100000-01-01T00:00:00Z', 'not-a-date']) {
      const res = await ana.call('GET', `${path}?before=${encodeURIComponent(before)}`);
      expect(res.status, `${before}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid', message: 'before is not a time' });
    }
    const first = await ana.call('GET', `${path}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextBefore).toBeTruthy();
    const older = await ana.call(
      'GET',
      `${path}?limit=1&before=${encodeURIComponent(first.body.nextBefore)}`,
    );
    expect(older.status, JSON.stringify(older.body)).toBe(200);
    expect(older.body.items).toHaveLength(1);
    expect(older.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it('an update carries the record before; patterns choose the events', async () => {
    const made = await task(ana, { title: 'Before and after' });
    await ana.call('PATCH', `/api/tasks/${made.id}`, { title: 'After' });
    const r = await eventually(() =>
      at('/ok/plain').find(
        (x) => parse(x).type === 'task.updated' && parse(x).data.resourceId === made.id,
      ),
    );
    expect(parse(r).data).toMatchObject({
      row: { title: 'After' },
      before: { title: 'Before and after' },
    });
    // The dated endpoint wants task.created only.
    await new Promise((res) => setTimeout(res, 1500));
    expect(
      at('/ok/dated').filter(
        (x) => parse(x).type === 'task.updated' && parse(x).data.resourceId === made.id,
      ),
    ).toHaveLength(0);
  });

  it('another business’s endpoint gets nothing of this one, a paused one nothing at all', async () => {
    const theirs = await endpoint(ravi, { url: `${base}/ok/ravi`, events: ['*'] });
    const paused = await endpoint(ana, { url: `${base}/ok/paused`, events: ['*'] });
    await ana.call('PATCH', `/api/integrations/endpoints/${paused.id}`, { status: 'paused' });
    const mine = await task(ana, { title: 'Not for Ravi' });
    const raviTask = await task(ravi, { title: 'Ravi only' });
    await eventually(() => at('/ok/ravi').find((x) => parse(x).data.resourceId === raviTask.id));
    await eventually(() => at('/ok/plain').find((x) => parse(x).data.resourceId === mine.id));
    expect(at('/ok/ravi').map((x) => parse(x).data.tenantId)).not.toContain(anaTenant);
    expect(at('/ok/paused')).toHaveLength(0);
    expect(theirs.id).toBeTruthy();
    expect(raviTenant).not.toBe(anaTenant);
  });

  it('an entity that opts out sends nothing, even to "*"', async () => {
    const all = await endpoint(ana, { url: `${base}/ok/all`, events: ['*'] });
    const memo = await ana.call('POST', '/api/memos', { title: 'Inside only' });
    expect(memo.status).toBe(201);
    const made = await task(ana, { title: 'After the memo' });
    await eventually(() => at('/ok/all').find((x) => parse(x).data.resourceId === made.id));
    expect(at('/ok/all').map((x) => parse(x).data.resourceType)).not.toContain('memo');
    expect(all.id).toBeTruthy();
  });
});

describe('retries', () => {
  it('a failing receiver is retried until it answers; every try is logged', async () => {
    answer('/flaky', 500, 503, 200);
    const { id } = await endpoint(ana, { url: `${base}/flaky`, events: ['task.created'] });
    const made = await task(ana, { title: 'Flaky' });
    const [d] = await eventually(async () => {
      const rows = (await deliveryRows(id)).filter((r) => r.status === 'delivered');
      return rows.length ? rows : undefined;
    });
    expect(d).toMatchObject({ attempts: 3, last_status: 200, last_error: null });
    const log = await ana.call('GET', `/api/integrations/deliveries/${d.id}`);
    expect(log.body.attempts.map((a: { status: number }) => a.status)).toEqual([500, 503, 200]);
    // The same webhook-id on every try.
    const ids = new Set(at('/flaky').map((r) => r.headers['webhook-id']));
    expect([...ids]).toEqual([d.id]);
    expect(made.id).toBeTruthy();
  });

  it('one that keeps failing ends failed; a manual retry sends it again with the same id', async () => {
    answer('/down', 500);
    const { id } = await endpoint(ana, { url: `${base}/down`, events: ['task.created'] });
    await task(ana, { title: 'Down' });
    const [d] = await eventually(async () => {
      const rows = (await deliveryRows(id)).filter((r) => r.status === 'failed');
      return rows.length ? rows : undefined;
    });
    expect(d).toMatchObject({ attempts: 4, last_status: 500 });
    expect(at('/down')).toHaveLength(4);

    answer('/down', 200);
    expect((await asSam('POST', `/api/integrations/deliveries/${d.id}/retry`)).status).toBe(403);
    const retried = await ana.call('POST', `/api/integrations/deliveries/${d.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'done', value: { status: 'retrying' } });
    await eventually(async () =>
      (await deliveryRows(id)).find((r) => r.id === d.id && r.status === 'delivered'),
    );
    expect(at('/down')).toHaveLength(5);
    expect(at('/down').at(-1)?.headers['webhook-id']).toBe(d.id);
    expect(await auditOf('integration_delivery.update', d.id)).toHaveLength(1);
  });
});

describe('an endpoint reads as it is now', () => {
  let owned: { id: string; secret: string };
  let made: { id: string; title: string };
  let first: { id: string };

  beforeAll(async () => {
    owned = await endpoint(ana, {
      url: `${base}/ok/replay-owner`,
      events: ['task.created'],
      capabilities: ['fixture.tasks.dates'],
    });
    made = await task(ana, { title: 'Replay me', dueOn: '2030-08-01' });
    const sent = await eventually(() =>
      at('/ok/replay-owner').find((x) => parse(x).data.resourceId === made.id),
    );
    expect(parse(sent).data.row).toMatchObject({ dueOn: '2030-08-01' });
    [first] = await eventually(async () => {
      const rows = (await deliveryRows(owned.id)).filter((r) => r.status === 'delivered');
      return rows.length ? rows : undefined;
    });
  });

  it('someone without its capability can neither empty it, point it elsewhere, nor send it again', async () => {
    for (const body of [
      { url: `${base}/ok/replay-thief`, capabilities: [] },
      { capabilities: [] },
      { url: `${base}/ok/replay-thief` },
    ]) {
      const res = await asAda('PATCH', `/api/integrations/endpoints/${owned.id}`, body);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ rule: 'capability_not_held' });
    }
    const replay = await asAda('POST', `/api/integrations/deliveries/${first.id}/retry`);
    expect(replay.status).toBe(403);
    expect(replay.body).toMatchObject({ rule: 'capability_not_held' });
    expect(await auditOf('integrations.delivery.retry', first.id)).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'capability_not_held' }),
    );
    const got = await ana.call('GET', `/api/integrations/endpoints/${owned.id}`);
    expect(got.body).toMatchObject({
      url: `${base}/ok/replay-owner`,
      capabilities: ['fixture.tasks.dates'],
    });
    expect(at('/ok/replay-thief')).toHaveLength(0);
  });

  it('a capability taken away leaves every later try, a redelivery included, and the log', async () => {
    // Its owner takes the capability away; then an admin without it may move the endpoint.
    const emptied = await ana.call('PATCH', `/api/integrations/endpoints/${owned.id}`, {
      capabilities: [],
    });
    expect(emptied.body).toMatchObject({ status: 'done', value: { capabilities: [] } });
    const moved = await asAda('PATCH', `/api/integrations/endpoints/${owned.id}`, {
      url: `${base}/ok/replay-thief`,
    });
    expect(moved.body).toMatchObject({ status: 'done', value: { url: `${base}/ok/replay-thief` } });

    // The old delivery, built with the date, is sent again without it.
    const again = await asAda('POST', `/api/integrations/deliveries/${first.id}/retry`);
    expect(again.body).toMatchObject({ status: 'done', value: { status: 'retrying' } });
    const r = await eventually(() =>
      at('/ok/replay-thief').find((x) => x.headers['webhook-id'] === first.id),
    );
    expect(verifyWebhook({ secret: owned.secret, headers: r.headers, body: r.body }).ok).toBe(true);
    expect(parse(r).data.row).toMatchObject({ id: made.id, title: 'Replay me' });
    expect(parse(r).data.row).not.toHaveProperty('dueOn');
    await eventually(async () =>
      (await deliveryRows(owned.id)).find(
        (x) => x.id === first.id && x.status === 'delivered' && x.attempts === 2,
      ),
    );
    // The log keeps what was sent: the date is gone from it, for its owner too.
    const log = await ana.call('GET', `/api/integrations/deliveries/${first.id}`);
    expect(log.body.payload.data.row).toMatchObject({ title: 'Replay me' });
    expect(log.body.payload.data.row).not.toHaveProperty('dueOn');
    const { rows } = await pool.query('select body from app.integration_deliveries where id = $1', [
      first.id,
    ]);
    expect(rows[0].body).not.toContain('2030-08-01');

    // A delivery still waiting, built when the endpoint had the capability, leaves without it too.
    const waiting = JSON.stringify({
      type: 'task.created',
      timestamp: new Date().toISOString(),
      data: {
        eventId: `evt-${randomUUID()}`,
        tenantId: anaTenant,
        resourceType: 'task',
        resourceId: made.id,
        row: { id: made.id, title: 'Waiting', done: false, dueOn: '2030-09-01' },
      },
    });
    const { rows: queued } = await pool.query(
      `insert into app.integration_deliveries
         (tenant_id, endpoint_id, event_id, event_name, resource_type, resource_id, body, status,
          next_attempt_at, queues)
       values ($1, $2, $3, 'task.created', 'task', $4, $5, 'pending', now() - interval '2 minutes', $6)
       returning id`,
      [anaTenant, owned.id, `evt-${randomUUID()}`, made.id, waiting, process.env.BULL_PREFIX],
    );
    await sweeper().sweep();
    const w = await eventually(() =>
      at('/ok/replay-thief').find((x) => x.headers['webhook-id'] === queued[0].id),
    );
    expect(parse(w).data.row).toMatchObject({ title: 'Waiting' });
    expect(parse(w).data.row).not.toHaveProperty('dueOn');
    expect(w.body).not.toContain('2030-09-01');
  });

  it('a delivery whose record may no longer leave is cancelled, not sent', async () => {
    // A memo opts out of webhooks: a stored body for one (an entity that opted out since) stays.
    const memo = JSON.stringify({
      type: 'memo.created',
      timestamp: new Date().toISOString(),
      data: { resourceType: 'memo', row: { id: 'm', title: 'Inside only' } },
    });
    const { rows } = await pool.query(
      `insert into app.integration_deliveries
         (tenant_id, endpoint_id, event_id, event_name, resource_type, body, status,
          next_attempt_at, queues)
       values ($1, $2, $3, 'memo.created', 'memo', $4, 'pending', now() - interval '2 minutes', $5)
       returning id`,
      [anaTenant, owned.id, `evt-${randomUUID()}`, memo, process.env.BULL_PREFIX],
    );
    await sweeper().sweep();
    const d = await eventually(async () =>
      (await deliveryRows(owned.id)).find((x) => x.id === rows[0].id && x.status === 'cancelled'),
    );
    expect(d).toMatchObject({
      attempts: 0,
      last_error: 'The record may no longer leave the platform',
    });
    expect(at('/ok/replay-thief').map((x) => x.headers['webhook-id'])).not.toContain(rows[0].id);
  });
});

describe('the sweeper', () => {
  it('a due delivery whose job was lost is sent', async () => {
    const { id, secret } = await endpoint(ana, {
      url: `${base}/ok/swept`,
      events: ['visit.created'],
    });
    const body = JSON.stringify({ type: 'visit.created', data: { row: { id: 'v' } } });
    const { rows } = await pool.query(
      `insert into app.integration_deliveries
         (tenant_id, endpoint_id, event_id, event_name, resource_type, body, status, next_attempt_at, queues)
       values ($1, $2, $3, 'visit.created', 'visit', $4, 'pending', now() - interval '2 minutes', $5)
       returning id`,
      [anaTenant, id, `evt-${randomUUID()}`, body, process.env.BULL_PREFIX],
    );
    expect(await sweeper().sweep()).toBeGreaterThanOrEqual(1);
    const r = await eventually(() => at('/ok/swept')[0]);
    expect(r.headers['webhook-id']).toBe(rows[0].id);
    expect(verifyWebhook({ secret, headers: r.headers, body: r.body }).ok).toBe(true);
    await eventually(async () =>
      (await deliveryRows(id)).find((d) => d.status === 'delivered' && d.attempts === 1),
    );
  });
});

describe('a try that goes wrong after the send', () => {
  it('a receiver that answers 200 with a NUL byte gets one request; the delivery ends delivered', async () => {
    bodies.set('/ok/nul', 'ok\u0000!');
    const { id } = await endpoint(ana, { url: `${base}/ok/nul`, events: ['task.created'] });
    await task(ana, { title: 'Binary answer' });
    const [d] = await eventually(async () => {
      const rows = (await deliveryRows(id)).filter((r) => r.status === 'delivered');
      return rows.length ? rows : undefined;
    });
    expect(d).toMatchObject({ attempts: 1, last_status: 200, last_error: null });
    // The log keeps the answer without the NUL, which Postgres text cannot hold.
    const log = await ana.call('GET', `/api/integrations/deliveries/${d.id}`);
    expect(log.body.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: 200, error: null, response: 'ok!' }),
    ]);
    // Nothing is left for the sweeper to send again.
    await sweeper().sweep();
    await new Promise((r) => setTimeout(r, 500));
    expect(at('/ok/nul')).toHaveLength(1);
    expect((await deliveryRows(id))[0]).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('a try whose lease ran out counts: it is logged, and the next try is sent', async () => {
    const { id } = await endpoint(ana, { url: `${base}/ok/lost`, events: ['visit.created'] });
    const lost = await storedDelivery(id, {
      status: 'sending',
      attempts: 1,
      leaseUntil: '-1 minute',
    });
    // A try still within its lease is left alone.
    const held = await storedDelivery(id, {
      status: 'sending',
      attempts: 1,
      leaseUntil: '1 hour',
    });
    expect(await sweeper().sweep()).toBeGreaterThanOrEqual(1);
    await eventually(async () =>
      (await deliveryRows(id)).find(
        (d) => d.id === lost && d.status === 'delivered' && d.attempts === 2,
      ),
    );
    expect(at('/ok/lost').map((r) => r.headers['webhook-id'])).toEqual([lost]);
    const log = await ana.call('GET', `/api/integrations/deliveries/${lost}`);
    expect(log.body.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: null,
        error: expect.stringContaining('did not finish'),
      }),
      expect.objectContaining({ attempt: 2, status: 200, error: null }),
    ]);
    expect((await deliveryRows(id)).find((d) => d.id === held)).toMatchObject({
      status: 'sending',
      attempts: 1,
    });
  });

  it('at the end of the schedule a try that did not finish ends the delivery failed, unsent', async () => {
    const { id } = await endpoint(ana, { url: `${base}/ok/lost-last`, events: ['visit.created'] });
    // The schedule has 3 waits: try 4 is the last.
    const lost = await storedDelivery(id, {
      status: 'sending',
      attempts: 4,
      leaseUntil: '-1 minute',
    });
    await sweeper().sweep();
    const [d] = await deliveryRows(id);
    expect(d).toMatchObject({ id: lost, status: 'failed', attempts: 4, last_status: null });
    expect(d.last_error).toContain('did not finish');
    // Swept again, it stays failed; nothing was sent.
    await sweeper().sweep();
    await new Promise((r) => setTimeout(r, 500));
    expect((await deliveryRows(id))[0]).toMatchObject({ status: 'failed', attempts: 4 });
    expect(at('/ok/lost-last')).toHaveLength(0);
    const log = await ana.call('GET', `/api/integrations/deliveries/${lost}`);
    expect(log.body.attempts).toEqual([
      expect.objectContaining({ attempt: 4, error: expect.stringContaining('did not finish') }),
    ]);
  });

  it('a retry schedule that does not parse stops the feature at start', () => {
    const was = process.env.INTEGRATIONS_RETRY_SCHEDULE;
    process.env.INTEGRATIONS_RETRY_SCHEDULE = '5s,soon';
    try {
      expect(() => checkSettings()).toThrow(
        'INTEGRATIONS_RETRY_SCHEDULE: "soon" is not a duration',
      );
    } finally {
      process.env.INTEGRATIONS_RETRY_SCHEDULE = was;
    }
    expect(() => checkSettings()).not.toThrow();
  });
});

describe('the egress guard at send time', () => {
  it('an address changed behind the API’s back is blocked when sent, for good', async () => {
    const { id } = await endpoint(ana, { url: `${base}/ok/moved`, events: ['task.created'] });
    const port = new URL(base).port;
    await pool.query('update app.integration_endpoints set url = $1 where id = $2', [
      `http://127.0.0.2:${port}/ok/moved`,
      id,
    ]);
    await task(ana, { title: 'Moved' });
    const [d] = await eventually(async () => {
      const rows = (await deliveryRows(id)).filter((r) => r.status === 'failed');
      return rows.length ? rows : undefined;
    });
    expect(d.attempts).toBe(1);
    expect(d.last_error).toContain('not a public address');
    expect(at('/ok/moved')).toHaveLength(0);
  });
});

describe('rotation', () => {
  it('a rotated endpoint signs with both secrets for a while; both verify', async () => {
    const first = await endpoint(ana, { url: `${base}/ok/rotate`, events: ['task.created'] });
    const rotated = await ana.call('POST', `/api/integrations/endpoints/${first.id}/rotate`);
    expect(rotated.status).toBe(200);
    const second = rotated.body.secret as string;
    expect(second).toMatch(/^whsec_/);
    expect(second).not.toBe(first.secret);
    expect(rotated.body.value.previousSecretUntil).toBeTruthy();
    const made = await task(ana, { title: 'Rotated' });
    const r = await eventually(() =>
      at('/ok/rotate').find((x) => parse(x).data.resourceId === made.id),
    );
    expect(String(r.headers['webhook-signature']).split(' ')).toHaveLength(2);
    expect(verifyWebhook({ secret: first.secret, headers: r.headers, body: r.body }).ok).toBe(true);
    expect(verifyWebhook({ secret: second, headers: r.headers, body: r.body }).ok).toBe(true);
  });
});

describe('a parked write', () => {
  it('a write hook parks an endpoint; the card holds no sealed secret; approving creates it', async () => {
    const res = await ana.call('POST', '/api/integrations/endpoints', {
      url: `${base}/ok/asked`,
      events: ['task.created'],
      description: '[ask] Accounts feed',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'fixture_endpoint_asks', action: 'integrations.endpoint.create' },
    });
    const secret = res.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const approvalId = res.body.approval.id as string;
    expect(res.body.approval.input).not.toHaveProperty('sealed');
    const card = await ana.call('GET', `/api/approvals/${approvalId}`);
    expect(card.body.input).toMatchObject({ url: `${base}/ok/asked` });
    expect(card.body.input).not.toHaveProperty('sealed');
    expect(JSON.stringify(card.body)).not.toContain('v1.');
    expect(await auditOf('integrations.endpoint.create')).toContainEqual(
      expect.objectContaining({ outcome: 'needs_approval', rule: 'fixture_endpoint_asks' }),
    );
    expect(
      (await ana.call('GET', '/api/integrations/endpoints')).body.map(
        (e: { url: string }) => e.url,
      ),
    ).not.toContain(`${base}/ok/asked`);

    const approved = await ana.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const made = await task(ana, { title: 'After approval' });
    const r = await eventually(() =>
      at('/ok/asked').find((x) => parse(x).data.resourceId === made.id),
    );
    expect(verifyWebhook({ secret, headers: r.headers, body: r.body }).ok).toBe(true);
  });
});

describe('inbound webhooks', () => {
  let conn: { id: string; secret: string; path: string };

  const post = (path: string, raw: string, headers: Record<string, string>) =>
    fetch(`${server.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });

  const signed = (secret: string, body: object, id = `msg_${randomUUID()}`, timestamp?: number) => {
    const raw = JSON.stringify(body);
    return { raw, id, headers: signWebhook({ secrets: [secret], id, body: raw, timestamp }) };
  };

  const inboundRows = async (connectionId: string) =>
    (
      await pool.query(
        `select id, external_id, sender_id, type, status, handled, error
           from app.integration_inbound where connection_id = $1 order by received_at`,
        [connectionId],
      )
    ).rows;

  beforeAll(async () => {
    const res = await ana.call('POST', '/api/integrations/connections', {
      connector: 'standard-webhooks',
      label: 'Their system',
    });
    expect(res.status).toBe(201);
    conn = {
      id: res.body.value.id,
      secret: res.body.credentials.secret,
      path: res.body.value.inboundPath,
    };
  });

  it('credentials are returned once, stored sealed and never read back', async () => {
    expect(conn.secret).toMatch(/^whsec_/);
    expect(conn.path).toBe(`/webhooks/standard-webhooks/${conn.id}`);
    const got = await ana.call('GET', `/api/integrations/connections/${conn.id}`);
    expect(got.body).toMatchObject({
      id: conn.id,
      connector: 'standard-webhooks',
      label: 'Their system',
    });
    expect(JSON.stringify(got.body)).not.toContain('whsec_');
    const { rows } = await pool.query(
      'select credentials_sealed from app.integration_connections where id = $1',
      [conn.id],
    );
    expect(rows[0].credentials_sealed).toMatch(/^v1\./);
    expect(rows[0].credentials_sealed).not.toContain(conn.secret.slice(6));
  });

  it('a signed event is stored once and handled as the business’s system principal', async () => {
    const made = await task(ana, { title: 'Done elsewhere' });
    const event = signed(conn.secret, { type: 'task.complete', data: { taskId: made.id } });
    const res = await post(conn.path, event.raw, event.headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // A redelivery of the same event is a no-op.
    expect((await post(conn.path, event.raw, event.headers)).status).toBe(200);

    const [row] = await eventually(async () => {
      const rows = (await inboundRows(conn.id)).filter(
        (r) => r.external_id === event.id && r.status === 'processed',
      );
      return rows.length ? rows : undefined;
    });
    expect(row.handled).toEqual({ 'fixture.complete-task': 'done' });
    expect((await inboundRows(conn.id)).filter((r) => r.external_id === event.id)).toHaveLength(1);
    expect((await ana.call('GET', `/api/tasks/${made.id}`)).body).toMatchObject({ done: true });
    const [audit] = (await auditOf('task.update', made.id)).filter(
      (a) => a.actor_kind === 'system',
    );
    expect(audit).toMatchObject({
      actor_id: 'integrations.standard-webhooks',
      channel: 'background',
      run_id: row.id,
      outcome: 'committed',
    });
    expect(handled.calls).toContainEqual(
      expect.objectContaining({
        handler: 'fixture.complete-task',
        actor: 'system:integrations.standard-webhooks',
        runId: row.id,
      }),
    );
  });

  it('the log shows what came in, to people who manage integrations', async () => {
    const log = await ana.call('GET', `/api/integrations/connections/${conn.id}/inbound`);
    expect(log.status).toBe(200);
    // Standard Webhooks signs its ids: the sender's id is the key, nothing else is kept.
    expect(log.body[0]).toMatchObject({
      type: 'task.complete',
      status: 'processed',
      senderId: null,
    });
    expect((await asSam('GET', `/api/integrations/connections/${conn.id}/inbound`)).status).toBe(
      403,
    );
    expect(
      (await ravi.call('GET', `/api/integrations/connections/${conn.id}/inbound`)).status,
    ).toBe(404);
    expect((await ravi.call('GET', `/api/integrations/connections/${conn.id}`)).status).toBe(404);
    expect(
      (await ravi.call('PATCH', `/api/integrations/connections/${conn.id}`, { label: 'x' })).status,
    ).toBe(404);
    expect((await ravi.call('DELETE', `/api/integrations/connections/${conn.id}`)).status).toBe(
      404,
    );
  });

  it('a bad or stale signature is 401, and nothing is stored', async () => {
    const before = (await inboundRows(conn.id)).length;
    const wrong = signed('whsec_d3JvbmctMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3', { type: 'x' });
    expect((await post(conn.path, wrong.raw, wrong.headers)).status).toBe(401);
    const stale = signed(
      conn.secret,
      { type: 'x' },
      undefined,
      Math.floor(Date.now() / 1000) - 3600,
    );
    expect((await post(conn.path, stale.raw, stale.headers)).status).toBe(401);
    const good = signed(conn.secret, { type: 'x' });
    expect((await post(conn.path, `${good.raw} `, good.headers)).status).toBe(401);
    expect((await post(conn.path, good.raw, {})).status).toBe(401);
    expect((await inboundRows(conn.id)).length).toBe(before);
  });

  it('an unknown connector or connection, or one of another connector, is 404', async () => {
    const e = signed(conn.secret, { type: 'x' });
    expect((await post(`/webhooks/nothing/${conn.id}`, e.raw, e.headers)).status).toBe(404);
    expect(
      (await post(`/webhooks/standard-webhooks/${randomUUID()}`, e.raw, e.headers)).status,
    ).toBe(404);
    expect((await post('/webhooks/standard-webhooks/not-a-uuid', e.raw, e.headers)).status).toBe(
      404,
    );
    expect((await post(`/webhooks/fixture-sender/${conn.id}`, e.raw, e.headers)).status).toBe(404);
  });

  it('a GET challenge is refused when the connector has none', async () => {
    const res = await fetch(`${server.base}${conn.path}?challenge=1`);
    expect(res.status).toBe(403);
  });

  it('a handler reaching another business’s record fails for good and changes nothing', async () => {
    const theirs = await task(ravi, { title: 'Ravi’s task' });
    const e = signed(conn.secret, { type: 'task.complete', data: { taskId: theirs.id } });
    expect((await post(conn.path, e.raw, e.headers)).status).toBe(200);
    const [row] = await eventually(async () => {
      const rows = (await inboundRows(conn.id)).filter(
        (r) => r.external_id === e.id && r.status === 'failed',
      );
      return rows.length ? rows : undefined;
    });
    expect(row.handled['fixture.complete-task']).toMatch(/^failed/);
    expect((await ravi.call('GET', `/api/tasks/${theirs.id}`)).body).toMatchObject({ done: false });
  });

  it('an event no handler takes is ignored; a handler that fails for now is retried', async () => {
    const e = signed(conn.secret, { type: 'nobody.listens', data: {} });
    expect((await post(conn.path, e.raw, e.headers)).status).toBe(200);
    await eventually(async () =>
      (await inboundRows(conn.id)).find((r) => r.external_id === e.id && r.status === 'ignored'),
    );
    const flaky = signed(conn.secret, { type: 'flaky.once', data: {} });
    expect((await post(conn.path, flaky.raw, flaky.headers)).status).toBe(200);
    await eventually(
      async () =>
        (await inboundRows(conn.id)).find(
          (r) => r.external_id === flaky.id && r.status === 'processed',
        ),
      15_000,
    );
    expect(handled.flaky).toBe(2);
  });

  it('a stored event whose job was lost is handled on the next sweep', async () => {
    const made = await task(ana, { title: 'Swept in' });
    const { rows } = await pool.query(
      `insert into app.integration_inbound
         (tenant_id, connection_id, connector, external_id, type, data, received_at, queues)
       values ($1, $2, 'standard-webhooks', $3, 'task.complete', $4, now() - interval '2 minutes', $5)
       returning id`,
      [anaTenant, conn.id, `lost-${randomUUID()}`, { taskId: made.id }, process.env.BULL_PREFIX],
    );
    const sweeper = server.app?.get(InboundService, { strict: false }) as InboundService;
    expect(await sweeper.sweep()).toBeGreaterThanOrEqual(1);
    await eventually(async () =>
      (await inboundRows(conn.id)).find((r) => r.id === rows[0].id && r.status === 'processed'),
    );
    expect((await ana.call('GET', `/api/tasks/${made.id}`)).body).toMatchObject({ done: true });
  });

  it('a sealed credential copied to another connection does not open there', async () => {
    const res = await ravi.call('POST', '/api/integrations/connections', {
      connector: 'standard-webhooks',
    });
    const theirs = res.body.value.id as string;
    await pool.query(
      `update app.integration_connections set credentials_sealed =
         (select credentials_sealed from app.integration_connections where id = $1) where id = $2`,
      [conn.id, theirs],
    );
    const e = signed(conn.secret, { type: 'task.complete', data: { taskId: randomUUID() } });
    expect((await post(`/webhooks/standard-webhooks/${theirs}`, e.raw, e.headers)).status).toBe(
      401,
    );
  });

  it('the HMAC connector verifies its header; credentials given are checked against its schema', async () => {
    const short = await ana.call('POST', '/api/integrations/connections', {
      connector: 'fixture-sender',
      credentials: { secret: 'short' },
    });
    expect(short.status).toBe(400);
    const secret = 'fixture-sender-secret-0123456789abcdef';
    const res = await ana.call('POST', '/api/integrations/connections', {
      connector: 'fixture-sender',
      credentials: { secret },
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('credentials');
    const path = res.body.value.inboundPath as string;
    const made = await task(ana, { title: 'Sender says done' });
    const raw = JSON.stringify({ type: 'done', taskId: made.id });
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    expect((await post(path, raw, { 'x-fixture-signature': 'sha256=00' })).status).toBe(401);
    // fixture.sender-done reads { taskId } from the whole body.
    const ok = await post(path, raw, {
      'x-fixture-signature': signature,
      'x-fixture-event': 'ev-1',
    });
    expect(ok.status).toBe(200);
    await eventually(async () => {
      const t = await ana.call('GET', `/api/tasks/${made.id}`);
      return t.body.done ? t : undefined;
    });
  });

  it('a captured request posted again under a fresh id header is still one event', async () => {
    // fixture-sender signs the body only; its x-fixture-event header is nobody's proof.
    const secret = 'fixture-replay-secret-0123456789abcdef';
    const res = await ana.call('POST', '/api/integrations/connections', {
      connector: 'fixture-sender',
      credentials: { secret },
    });
    expect(res.status).toBe(201);
    const id = res.body.value.id as string;
    const path = res.body.value.inboundPath as string;
    const made = await task(ana, { title: 'Signed once' });
    const raw = JSON.stringify({ type: 'done', taskId: made.id });
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    // One genuine request, then whoever saw it sends it again under ids of their own, and as is.
    for (const event of ['ev-1', 'ev-attacker-2', 'ev-attacker-3', 'ev-1']) {
      const r = await post(path, raw, {
        'x-fixture-signature': signature,
        'x-fixture-event': event,
      });
      expect(r.status).toBe(200);
    }
    const rows = await eventually(async () => {
      const r = await inboundRows(id);
      return r.length === 1 && r[0].status === 'processed' ? r : undefined;
    });
    const key = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    expect(rows[0]).toMatchObject({ external_id: key, sender_id: 'ev-1' });
    const runs = handled.calls.filter(
      (c) => c.handler === 'fixture.sender-done' && c.runId === rows[0].id,
    );
    expect(runs).toHaveLength(1);
    expect(await inboundRows(id)).toHaveLength(1);
    const log = await ana.call('GET', `/api/integrations/connections/${id}/inbound`);
    expect(log.body).toEqual([
      expect.objectContaining({ externalId: key, senderId: 'ev-1', status: 'processed' }),
    ]);
    expect((await ravi.call('GET', `/api/integrations/connections/${id}/inbound`)).status).toBe(
      404,
    );
  });

  it('a sender that signs its id and a timestamp: its ids are keys, a fresh id or a stale request is refused', async () => {
    const secret = 'fixture-signed-secret-0123456789abcdef';
    const res = await ana.call('POST', '/api/integrations/connections', {
      connector: 'fixture-signed',
      credentials: { secret },
    });
    expect(res.status).toBe(201);
    const id = res.body.value.id as string;
    const path = res.body.value.inboundPath as string;
    const made = await task(ana, { title: 'Signed with its id' });
    const raw = JSON.stringify({ type: 'done', taskId: made.id });
    const now = () => Math.floor(Date.now() / 1000);
    const headers = (event: string, ts = now()): Record<string, string> => ({
      'x-fixture-event': event,
      'x-fixture-timestamp': String(ts),
      'x-fixture-signature': `sha256=${createHmac('sha256', secret)
        .update(`${ts}.${event}.${raw}`)
        .digest('hex')}`,
    });
    const first = headers('ev-1');
    expect((await post(path, raw, first)).status).toBe(200);
    // The signature covers the id: under a fresh one it is not the sender's.
    const replay = { ...first, 'x-fixture-event': 'ev-attacker-2' };
    expect((await post(path, raw, replay)).status).toBe(401);
    // The sender's own redelivery, signed again a moment later: the same event.
    expect((await post(path, raw, headers('ev-1', now() + 1))).status).toBe(200);
    // Signed six minutes ago, or with no time at all: refused.
    expect((await post(path, raw, headers('ev-3', now() - 360))).status).toBe(401);
    const { 'x-fixture-timestamp': _ts, ...untimed } = headers('ev-4');
    expect((await post(path, raw, untimed)).status).toBe(401);
    // Another signed id is another event, even with the same body.
    expect((await post(path, raw, headers('ev-5'))).status).toBe(200);
    const rows = await eventually(async () => {
      const r = await inboundRows(id);
      return r.length === 2 && r.every((x) => x.status === 'processed') ? r : undefined;
    });
    expect(rows.map((r) => [r.external_id, r.sender_id])).toEqual([
      ['ev-1', null],
      ['ev-5', null],
    ]);
    const runs = handled.calls.filter(
      (c) => c.handler === 'fixture.signed-done' && rows.some((r) => r.id === c.runId),
    );
    expect(runs).toHaveLength(2);
    expect((await ana.call('GET', `/api/tasks/${made.id}`)).body).toMatchObject({ done: true });
  });

  it('a disabled connection takes nothing; deleting one removes its log', async () => {
    await ana.call('PATCH', `/api/integrations/connections/${conn.id}`, { status: 'disabled' });
    const e = signed(conn.secret, { type: 'x' });
    expect((await post(conn.path, e.raw, e.headers)).status).toBe(404);
    expect((await ana.call('DELETE', `/api/integrations/connections/${conn.id}`)).status).toBe(200);
    expect(await inboundRows(conn.id)).toHaveLength(0);
    expect(await auditOf('integration_connection.delete', conn.id)).toHaveLength(1);
  });
});
