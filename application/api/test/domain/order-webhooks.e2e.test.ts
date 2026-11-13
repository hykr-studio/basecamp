// The orders module on the integration bus (B10, H5): accepting an order places it
// (`order.placed`, its lines with it), sent signed to each of the business's webhook endpoints that
// wants it, every line's cost only to an endpoint given orders.cost.read (the module's costHidden
// projector). The supplier's own system reports back through the module's connector,
// `orders-supplier`: a signed `order.fulfilled` fulfils an accepted order its party supplies, as
// the business's system principal through runWrite; a bad signature is 401 and stores nothing.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '@hykr/api/testing';
import { verifyWebhook } from '@hykr/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

// Read when used: set before the app boots.
process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';
process.env.INTEGRATIONS_ALLOWED_HOSTS = '127.0.0.1';
process.env.INTEGRATIONS_RETRY_SCHEDULE = '100ms,100ms,100ms';
process.env.INTEGRATIONS_TIMEOUT_MS = '3000';

/* ── A receiver: records each request ──────────────────────────────────────── */

type Received = { path: string; headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
let receiver: Server;
let base = '';
const at = (path: string) => received.filter((r) => r.path === path);
const parse = (r: Received) => JSON.parse(r.body);

/* ── People ─────────────────────────────────────────────────────────────────── */

const owner = new Person('Owner Order Hooks'); // integrations.manage and orders.cost.read
const customer = new Person('Customer Order Hooks');
const stranger = new Person('Stranger Order Hooks'); // owner of another business
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const items = [
  { ref: 'k', kind: 'group', title: 'Kitchen' },
  { ref: 'k1', parent: 'k', title: 'Cabinet', quantity: 2, unitPrice: '1500.00', taxRateBp: 1800 },
  { ref: 'k2', parent: 'k', title: 'Sink', quantity: 1, unitPrice: '800.00', taxRateBp: 1800 },
];
/** What each line costs the business: only it, and an endpoint it gives orders.cost.read, see. */
const COST: Record<string, string> = { Cabinet: '900.00', Sink: '500.00' };

const move = (p: Person, id: string, name: string, headers: Record<string, string> = {}) =>
  p.call('POST', `/api/transitions/orders/${id}/${name}`, {}, headers);

async function endpoint(person: Person, body: object) {
  const res = await person.call('POST', '/api/integrations/endpoints', body);
  if (res.status !== 201) throw new Error(`endpoint: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.value.id as string, secret: res.body.secret as string };
}

/** A PDF of the order, made (the owner asks for it). */
async function pdf(id: string) {
  const asked = await owner.call('POST', '/api/documents', { document: 'orders.order', id });
  expect(asked.status).toBe(200);
  return eventually(async () => {
    const got = await owner.call('GET', `/api/documents/${asked.body.value.id}`);
    return got.body?.status === 'ready' ? (got.body as Json) : undefined;
  });
}

async function mails(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return messages.filter((m) => /verification code/.test(m.Subject)).map((m) => m.ID);
}

/** The customer accepts the order's PDF with the code emailed to them. */
async function accept(documentId: string) {
  const before = new Set(await mails(customer.email));
  const asked = await customer.call(
    'POST',
    '/api/acceptances/challenges',
    { documentId },
    inTenant(),
  );
  expect(asked.status).toBe(200);
  const code = await eventually(async () => {
    const fresh = (await mails(customer.email)).find((id) => !before.has(id));
    if (!fresh) return undefined;
    const body = (await (await fetch(`http://localhost:8025/api/v1/message/${fresh}`)).json()) as {
      Text: string;
    };
    return /(\d{6}) is your verification code/.exec(body.Text)?.[1];
  });
  const res = await customer.call(
    'POST',
    '/api/acceptances',
    { challengeId: asked.body.value.id, code },
    inTenant(),
  );
  expect(res.status).toBe(200);
  return res.body.value as Json;
}

/** An order the owner saves, submits and approves: approved, not accepted. */
async function approvedOrder(title: string) {
  const saved = await owner.call('POST', '/api/orders/save', { title, items });
  expect(saved.status).toBe(200);
  const order = saved.body.value.order as Json;
  expect((await move(owner, order.id, 'submit')).status).toBe(200);
  expect((await move(owner, order.id, 'approve')).status).toBe(200);
  return order;
}

const orderOf = async (person: Person, id: string) =>
  (await person.call('GET', `/api/orders/${id}`)).body as Json;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '/', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  await boot(application);
  for (const p of [owner, customer, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await setTenantSettings(tenantId, { money: { currency: 'INR', fyStartMonth: 4 } });
  // The customer has an account and is this business's customer.
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, customer.name, customer.id],
  );
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, $3, $4, false)`,
    [tenantId, customer.id, ['customer'], rows[0].id],
  );
});

afterAll(async () => {
  await shutdown();
  await new Promise<void>((r) => receiver.close(() => r()));
});

describe('an accepted order is placed: order.placed to the business’s endpoints', () => {
  let supplier: { id: string; secret: string };
  let books: { id: string; secret: string };
  let order: Json;
  let doc: Json;

  beforeAll(async () => {
    // Its supplier's system reads what it is to deliver, never what it costs; the books do.
    supplier = await endpoint(owner, { url: `${base}/supplier`, events: ['order.placed'] });
    books = await endpoint(owner, {
      url: `${base}/books`,
      events: ['order.placed'],
      capabilities: ['orders.cost.read'],
    });
    await endpoint(stranger, { url: `${base}/stranger`, events: ['*'] });

    const saved = await customer.call(
      'POST',
      '/api/orders/save',
      { title: 'Flat 2A', items },
      inTenant(),
    );
    expect(saved.status).toBe(200);
    order = saved.body.value.order;
    // The business sets what each line costs it.
    const costed = await owner.call('POST', '/api/orders/save', {
      orderId: order.id,
      version: order.version,
      title: 'Flat 2A',
      items: (saved.body.value.items as Json[]).map((i) => ({
        ref: i.id,
        id: i.id,
        ...(i.parentItemId ? { parent: i.parentItemId } : {}),
        kind: i.kind,
        title: i.title,
        ...(i.kind === 'line'
          ? {
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              taxRateBp: i.taxRateBp,
              cost: COST[i.title],
            }
          : {}),
      })),
    });
    expect(costed.status).toBe(200);
    order = costed.body.value.order;
    expect((await move(customer, order.id, 'submit', inTenant())).status).toBe(200);
    expect((await move(owner, order.id, 'approve')).status).toBe(200);
    doc = await pdf(order.id);
  });

  it('nothing is placed before the customer accepts', async () => {
    expect((await orderOf(owner, order.id)).status).toBe('approved');
    expect(at('/supplier')).toHaveLength(0);
    expect(at('/books')).toHaveLength(0);
  });

  it('accepting sends the whole order, signed, to the supplier without any line’s cost', async () => {
    await accept(doc.id);
    expect((await orderOf(owner, order.id)).status).toBe('accepted');
    const r = await eventually(() =>
      at('/supplier').find((x) => parse(x).data.resourceId === order.id),
    );
    expect(verifyWebhook({ secret: supplier.secret, headers: r.headers, body: r.body }).ok).toBe(
      true,
    );
    expect(verifyWebhook({ secret: books.secret, headers: r.headers, body: r.body }).ok).toBe(
      false,
    );
    const body = parse(r);
    expect(body).toMatchObject({
      type: 'order.placed',
      data: { tenantId, resourceType: 'order', resourceId: order.id },
    });
    expect(body.data.row).toMatchObject({
      id: order.id,
      number: order.number,
      status: 'accepted',
      // 2 × 1500 + 800, and 18% tax on it.
      total: { minor: 448_400, currency: 'INR' },
    });
    for (const internal of ['tenantId', 'ownerId', 'customerId'])
      expect(body.data.row).not.toHaveProperty(internal);
    // Its lines, in tree order, as the order's own items: none with its cost.
    const lines = body.data.row.items as Json[];
    expect(lines.map((i) => [i.kind, i.title])).toEqual([
      ['group', 'Kitchen'],
      ['line', 'Cabinet'],
      ['line', 'Sink'],
    ]);
    expect(lines.find((i) => i.title === 'Cabinet')).toMatchObject({
      quantity: 2,
      unitPrice: { minor: 150_000, currency: 'INR' },
      amount: { minor: 300_000, currency: 'INR' },
    });
    for (const line of lines) {
      expect(line).not.toHaveProperty('cost');
      for (const internal of ['tenantId', 'ownerId', 'customerId'])
        expect(line).not.toHaveProperty(internal);
    }
  });

  it('the endpoint given orders.cost.read gets each line’s cost', async () => {
    const r = await eventually(() =>
      at('/books').find((x) => parse(x).data.resourceId === order.id),
    );
    expect(verifyWebhook({ secret: books.secret, headers: r.headers, body: r.body }).ok).toBe(true);
    const lines = parse(r).data.row.items as Json[];
    expect(lines.find((i) => i.title === 'Cabinet')?.cost).toEqual({
      minor: 90_000,
      currency: 'INR',
    });
    expect(lines.find((i) => i.title === 'Sink')?.cost).toEqual({ minor: 50_000, currency: 'INR' });
    expect(lines.find((i) => i.title === 'Kitchen')?.cost).toBeNull();
  });

  it('the delivery log keeps what each endpoint got; another business reaches none of it', async () => {
    const delivered = async (endpointId: string) =>
      eventually(async () => {
        const list = await owner.call(
          'GET',
          `/api/integrations/endpoints/${endpointId}/deliveries`,
        );
        return (list.body.items as Json[]).find(
          (d) => d.resourceId === order.id && d.status === 'delivered',
        );
      });
    const toSupplier = await delivered(supplier.id);
    expect(toSupplier).toMatchObject({ eventName: 'order.placed', attempts: 1, lastStatus: 200 });
    const sent = await owner.call('GET', `/api/integrations/deliveries/${toSupplier.id}`);
    for (const line of sent.body.payload.data.row.items) expect(line).not.toHaveProperty('cost');
    const toBooks = await delivered(books.id);
    const kept = await owner.call('GET', `/api/integrations/deliveries/${toBooks.id}`);
    expect(
      (kept.body.payload.data.row.items as Json[]).find((i) => i.title === 'Cabinet')?.cost,
    ).toEqual({ minor: 90_000, currency: 'INR' });
    expect((await stranger.call('GET', `/api/integrations/deliveries/${toBooks.id}`)).status).toBe(
      404,
    );
    // The other business's endpoint wants every event: it got none of this business's.
    expect(at('/stranger').filter((x) => parse(x).data.tenantId === tenantId)).toHaveLength(0);
  });
});

describe('the supplier reports back: orders-supplier', () => {
  let accepted: Json;
  let approvedOnly: Json;
  let notTheirs: Json;
  let partyId = '';
  let conn: { id: string; path: string };
  const secret = randomBytes(32).toString('hex');

  const sign = (raw: string, key = secret) =>
    `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;
  const post = (path: string, raw: string, headers: Record<string, string>) =>
    fetch(`${server.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });
  /** A signed report, as the supplier's system sends it. */
  const report = (body: object, id = `evt_${randomUUID()}`) => {
    const raw = JSON.stringify(body);
    return {
      id,
      raw,
      headers: { 'x-supplier-signature': sign(raw), 'x-supplier-event': id },
    };
  };
  const inboundRows = async () =>
    (
      await pool.query(
        `select id, external_id, sender_id, type, status, handled, error
          from app.integration_inbound where connection_id = $1 order by received_at`,
        [conn.id],
      )
    ).rows;
  /**
   * The stored event, once its handler has run. `x-supplier-event` is not signed, so it is kept
   * as the sender's id and the event is keyed by its signed body (decisions S2).
   */
  const handledRow = (senderId: string) =>
    eventually(async () =>
      (await inboundRows()).find(
        (r) => r.sender_id === senderId && ['processed', 'failed'].includes(r.status),
      ),
    );

  beforeAll(async () => {
    // The order placed above, accepted by its customer.
    const { rows } = await pool.query(
      `select id from app.orders where tenant_id = $1 and status = 'accepted' and title = 'Flat 2A'`,
      [tenantId],
    );
    accepted = await orderOf(owner, rows[0].id);
    approvedOnly = await approvedOrder('Approved, not accepted');
    notTheirs = await approvedOrder('Placed elsewhere');

    const party = await owner.call('POST', '/api/parties', {
      kind: 'organisation',
      name: 'Clear Glass Co',
    });
    expect(party.status).toBe(200);
    partyId = party.body.value.id;
    for (const o of [accepted, approvedOnly]) {
      const put = await owner.call('POST', '/api/participants', {
        resourceType: 'order',
        resourceId: o.id,
        partyId,
        role: 'supplier',
      });
      expect(put.status).toBe(200);
    }
    const made = await owner.call('POST', '/api/integrations/connections', {
      connector: 'orders-supplier',
      label: 'Clear Glass',
      credentials: { secret, partyId },
    });
    expect(made.status).toBe(201);
    conn = { id: made.body.value.id, path: made.body.value.inboundPath };
    // The party is shown back; the secret never.
    expect(made.body.value).toMatchObject({
      connector: 'orders-supplier',
      public: { partyId },
      inboundPath: `/webhooks/orders-supplier/${conn.id}`,
    });
    expect(made.body).not.toHaveProperty('credentials');
    expect(JSON.stringify(made.body)).not.toContain(secret);
  });

  it('the module’s connector is offered; a connection names its supplier', async () => {
    const list = await owner.call('GET', '/api/integrations/connectors');
    expect(list.body).toContainEqual(
      expect.objectContaining({
        name: 'orders-supplier',
        inbound: true,
        generates: false,
        publicFields: ['partyId'],
      }),
    );
    const noParty = await owner.call('POST', '/api/integrations/connections', {
      connector: 'orders-supplier',
      credentials: { secret },
    });
    expect(noParty.status).toBe(400);
    const shortSecret = await owner.call('POST', '/api/integrations/connections', {
      connector: 'orders-supplier',
      credentials: { secret: 'short', partyId },
    });
    expect(shortSecret.status).toBe(400);
    const got = await owner.call('GET', `/api/integrations/connections/${conn.id}`);
    expect(JSON.stringify(got.body)).not.toContain(secret);
  });

  it('a bad or missing signature is 401, and nothing is stored', async () => {
    const r = report({ type: 'order.fulfilled', data: { orderId: accepted.id } });
    const forged = { ...r.headers, 'x-supplier-signature': sign(r.raw, 'not-the-secret') };
    expect((await post(conn.path, r.raw, forged)).status).toBe(401);
    const { 'x-supplier-signature': _signature, ...unsigned } = r.headers;
    expect((await post(conn.path, r.raw, unsigned)).status).toBe(401);
    expect((await post(conn.path, `${r.raw} `, r.headers)).status).toBe(401);
    // Signed, but with no event id: refused (400) before anything is stored.
    const { 'x-supplier-event': _id, ...anonymous } = r.headers;
    expect((await post(conn.path, r.raw, anonymous)).status).toBe(400);
    expect(await inboundRows()).toEqual([]);
    expect((await orderOf(owner, accepted.id)).status).toBe('accepted');
  });

  it('an order this supplier is not on, or one only approved, fails for good and stays', async () => {
    const other = report({ type: 'order.fulfilled', data: { orderId: notTheirs.id } });
    expect((await post(conn.path, other.raw, other.headers)).status).toBe(200);
    const early = report({ type: 'order.fulfilled', data: { orderId: approvedOnly.id } });
    expect((await post(conn.path, early.raw, early.headers)).status).toBe(200);
    const garbled = report({ type: 'order.fulfilled', data: { order: 'which?' } });
    expect((await post(conn.path, garbled.raw, garbled.headers)).status).toBe(200);
    expect((await handledRow(other.id)).handled['orders.supplier-fulfilled']).toMatch(
      /^failed: not_supplier/,
    );
    expect((await handledRow(early.id)).handled['orders.supplier-fulfilled']).toMatch(
      /^failed: order_not_accepted/,
    );
    expect((await handledRow(garbled.id)).handled['orders.supplier-fulfilled']).toMatch(
      /^failed: supplier_event_invalid/,
    );
    for (const r of [other, early, garbled]) expect((await handledRow(r.id)).status).toBe('failed');
    expect((await orderOf(owner, notTheirs.id)).status).toBe('approved');
    expect((await orderOf(owner, approvedOnly.id)).status).toBe('approved');
  });

  it('another business’s order is never this supplier’s; its connection is not theirs either', async () => {
    const theirs = await stranger.call('POST', '/api/orders/save', {
      title: 'Stranger order',
      items,
    });
    expect(theirs.status).toBe(200);
    const id = theirs.body.value.order.id as string;
    const r = report({ type: 'order.fulfilled', data: { orderId: id } });
    expect((await post(conn.path, r.raw, r.headers)).status).toBe(200);
    expect((await handledRow(r.id)).handled['orders.supplier-fulfilled']).toMatch(
      /^failed: not_supplier/,
    );
    expect((await orderOf(stranger, id)).status).toBe('draft');
    expect((await stranger.call('GET', `/api/integrations/connections/${conn.id}`)).status).toBe(
      404,
    );
    expect(
      (await stranger.call('GET', `/api/integrations/connections/${conn.id}/inbound`)).status,
    ).toBe(404);
  });

  it('a signed order.fulfilled fulfils the accepted order it supplies, as the business’s system', async () => {
    const r = report({ type: 'order.fulfilled', data: { orderId: accepted.id } });
    const res = await post(conn.path, r.raw, r.headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    // A redelivery of the same event is stored once, and so is the same signed body posted
    // again under a fresh (unsigned) event id: it is keyed by the body.
    expect((await post(conn.path, r.raw, r.headers)).status).toBe(200);
    const replay = { ...r.headers, 'x-supplier-event': `evt_${randomUUID()}` };
    expect((await post(conn.path, r.raw, replay)).status).toBe(200);
    const row = await handledRow(r.id);
    expect(row).toMatchObject({ status: 'processed', type: 'order.fulfilled' });
    expect(row.external_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.handled).toEqual({ 'orders.supplier-fulfilled': 'done' });
    expect((await inboundRows()).filter((x) => x.external_id === row.external_id)).toHaveLength(1);
    expect((await orderOf(owner, accepted.id)).status).toBe('fulfilled');
    const { rows: audit } = await pool.query(
      `select outcome, actor_kind, actor_id, channel, run_id from audit.events
        where action = 'order.transition' and resource_id = $1 and actor_kind = 'system'`,
      [accepted.id],
    );
    expect(audit).toEqual([
      {
        outcome: 'committed',
        actor_kind: 'system',
        actor_id: 'integrations.orders-supplier',
        channel: 'background',
        run_id: row.id,
      },
    ]);
    // Reported again (a new event, so a different body), the fulfilled order does not move: it
    // is not accepted now.
    const again = report({
      type: 'order.fulfilled',
      data: { orderId: accepted.id, reportedAt: new Date().toISOString() },
    });
    expect((await post(conn.path, again.raw, again.headers)).status).toBe(200);
    expect((await handledRow(again.id)).handled['orders.supplier-fulfilled']).toMatch(
      /^failed: order_not_accepted/,
    );
  });

  it('the inbound log is the business’s: it shows what came in and what it did', async () => {
    const log = await owner.call('GET', `/api/integrations/connections/${conn.id}/inbound`);
    expect(log.status).toBe(200);
    expect((log.body as Json[]).map((e) => e.status)).toContain('processed');
    expect((log.body as Json[]).every((e) => e.type === 'order.fulfilled')).toBe(true);
  });
});
