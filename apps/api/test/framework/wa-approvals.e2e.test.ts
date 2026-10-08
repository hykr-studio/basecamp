// Approvals on WhatsApp: a signed button decides once, only before it expires, and only from
// the number it was sent to. A customer's request goes to the business; the customer hears
// the outcome. A stand-in Cloud API; the queues run inline.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { signApproval } from '@app/channels';
import { contentHash, templates } from '@app/notifications';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  shutdown,
} from '../support.js';

type Button = { sub_type: string; parameters: { payload?: string }[] };
type Sent = {
  to: string;
  type?: string;
  text?: { body: string };
  template?: { name: string; components?: ({ type: string } & Partial<Button>)[] };
  interactive?: { action: { buttons?: { reply: { id: string; title: string } }[] } };
};
const sent: Sent[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n && s.type);
const textsTo = (n: string) => toNumber(n).flatMap((s) => (s.text ? [s.text.body] : []));

let stub: Server;
const secret = 'test-app-secret';
process.env.APPROVAL_SECRET ||= 'test-approval-secret-0123456789abcdef0123';
const NUMBER = `pn-apr-${Date.now()}`;
const ana = new Person('Ana Approves');
let tenantId = '';
let seq = 0;
const phone = () => `9166${String(Date.now()).slice(-6)}${seq++ % 10}`;
const anaPhone = phone();

/** A customer's (or Ana's) message or button tap, as Meta delivers it. */
async function deliver(from: string, message: Record<string, unknown>) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: NUMBER },
              messages: [
                {
                  from,
                  id: `m-apr-${Date.now()}-${seq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await fetch(`${server.base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  expect(res.status).toBe(200);
}
const tap = (from: string, payload: string) =>
  deliver(from, { type: 'button', button: { payload, text: 'Approve' } });
const say = (from: string, body: string) => deliver(from, { type: 'text', text: { body } });

/** Wait for a text to this number containing these words. */
const heard = (n: string, words: RegExp) => eventually(() => textsTo(n).find((t) => words.test(t)));

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push(JSON.parse(data) as Sent);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  await boot();
  await ana.signUp();
  tenantId = (await me(ana)).tenantId;
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await pool.query(
    `update app.tenants set settings = settings || '{"quietHours":{"from":"00:00","to":"00:00"}}' where id = $1`,
    [tenantId],
  );
  for (const t of templates)
    for (const lang of ['en', 'hi', 'te'] as const)
      await pool.query(
        `insert into channel.templates (name, language, category, content_hash, status)
         values ($1, $2, $3, $4, 'APPROVED')
         on conflict (name, language) do update set status = 'APPROVED'`,
        [t.name, lang, t.category, contentHash(t, lang)],
      );
  // Ana's own number, linked to her account: she decides on WhatsApp.
  const c = await seedContact(tenantId, 'Ana', anaPhone);
  await pool.query(
    'update channel.contacts set user_id = $1, linked_at = now(), welcomed_at = now() where id = $2',
    [ana.id, c.contactId],
  );
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

/** A customer's to-do, and their assistant's request to delete it (parked for the business). */
async function customerAsksToDelete(title: string) {
  const address = phone();
  const customer = await seedContact(tenantId, 'Kavya', address);
  const as = asAssistant(`contact:${customer.contactId}`);
  const todo = (await as('POST', '/api/todos', { title })).body.value as { id: string };
  const parked = await as('DELETE', `/api/todos/${todo.id}`);
  expect(parked.body.status).toBe('needs_approval');
  return { address, customer, todo, approvalId: parked.body.approval.id as string };
}

/** The Approve / Reject payloads on the request template sent to this number. */
async function requestButtons(n: string, approvalId: string) {
  const template = await eventually(() =>
    toNumber(n).find(
      (s) =>
        s.template?.name === 'approval_request_v1' &&
        JSON.stringify(s.template).includes(approvalId),
    ),
  );
  const payloads = (template.template?.components ?? [])
    .filter((c) => c.type === 'button')
    .map((c) => c.parameters?.[0]?.payload ?? '');
  return { approve: payloads[0], reject: payloads[1] };
}

describe('approvals on WhatsApp', () => {
  it("a customer's request reaches the owner with buttons; Approve does it, once", async () => {
    const { address, todo, approvalId } = await customerAsksToDelete('Return the samples');
    const { approve } = await requestButtons(anaPhone, approvalId);
    expect(approve).toMatch(/^apr:/);

    await tap(anaPhone, approve);
    await heard(anaPhone, /Done: Delete/);
    expect((await ana.call('GET', `/api/todos/${todo.id}`)).status).toBe(404);
    // The customer hears how it ended.
    const outcome = await eventually(() =>
      toNumber(address).find((s) => s.template?.name === 'approval_outcome_v1'),
    );
    expect(JSON.stringify(outcome.template)).toContain('approved');

    // A double tap changes nothing.
    await tap(anaPhone, approve);
    await heard(anaPhone, /already decided/);
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events where action = 'approval.approved' and resource_id = $1`,
      [approvalId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('Reject leaves the record; the customer hears it was not approved', async () => {
    const { address, todo, approvalId } = await customerAsksToDelete('Keep the samples');
    const { reject } = await requestButtons(anaPhone, approvalId);
    await tap(anaPhone, reject);
    await heard(anaPhone, /Rejected: Delete/);
    expect((await ana.call('GET', `/api/todos/${todo.id}`)).status).toBe(200);
    const outcome = await eventually(() =>
      toNumber(address).find((s) => s.template?.name === 'approval_outcome_v1'),
    );
    expect(JSON.stringify(outcome.template)).toContain('not approved');
  });

  it('a forwarded button is refused: it only works from the number it was sent to', async () => {
    const { address, todo, approvalId } = await customerAsksToDelete('Forwarded one');
    const { approve } = await requestButtons(anaPhone, approvalId);
    await tap(address, approve);
    await heard(address, /isn't for this number/);
    expect((await ana.call('GET', `/api/todos/${todo.id}`)).status).toBe(200);
  });

  it('an expired button is refused, and points to the app', async () => {
    const { approvalId } = await customerAsksToDelete('Too late');
    const { rows } = await pool.query(
      'select id from channel.contacts where tenant_id = $1 and address = $2',
      [tenantId, anaPhone],
    );
    const stale = signApproval(
      process.env.APPROVAL_SECRET ?? '',
      { approvalId, approve: true, expiresAt: Date.now() - 1000 },
      rows[0].id,
    );
    await tap(anaPhone, stale);
    await heard(anaPhone, /expired/);
    const { rows: status } = await pool.query('select status from app.approvals where id = $1', [
      approvalId,
    ]);
    expect(status).toEqual([{ status: 'pending' }]);
  });

  it('in the conversation: her own request gets buttons; a customer is told the team was asked', async () => {
    await ana.call('POST', '/api/todos', { title: 'Order tiles' });
    const before = textsTo(anaPhone).length;
    await say(anaPhone, 'delete Order tiles');
    const buttons = await eventually(() =>
      toNumber(anaPhone).find((s) =>
        s.interactive?.action.buttons?.some((b) => b.reply.id.startsWith('apr:')),
      ),
    );
    const approve = buttons.interactive?.action.buttons?.[0].reply.id ?? '';
    await tap(anaPhone, approve);
    await heard(anaPhone, /Done: Delete "Order tiles"/);
    // The buttons are the approval: no "approve it in the app" beside them.
    expect(
      textsTo(anaPhone)
        .slice(before)
        .some((t) => t.includes('in the app')),
    ).toBe(false);

    const address = phone();
    const customer = await seedContact(tenantId, 'Meena', address);
    await asAssistant(`contact:${customer.contactId}`)('POST', '/api/todos', {
      title: 'Order tiles',
    });
    await say(address, 'delete Order tiles');
    await heard(address, /asked the team/);
    expect(
      toNumber(address).some((s) => JSON.stringify(s.interactive ?? '').includes('apr:')),
    ).toBe(false);
  });
});
