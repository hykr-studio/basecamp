// Approvals on WhatsApp: a signed button decides once, only before it expires, and only from
// the number it was sent to. A customer's request goes to the business; the customer hears
// the outcome. A stand-in Cloud API; the queues run inline.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { signApproval } from '@hykr/channels';
import { contentHash } from '@hykr/notifications';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
// The framework's fixture application, compiled (Nest's DI needs the decorator metadata).
import { fixture } from '../fixture/dist/index.js';

const { templates } = fixture.notifications;

type Button = { sub_type: string; parameters: { payload?: string }[] };
type Sent = {
  to: string;
  type?: string;
  text?: { body: string };
  template?: { name: string; components?: ({ type: string } & Partial<Button>)[] };
  interactive?: {
    body?: { text?: string };
    action: { buttons?: { reply: { id: string; title: string } }[] };
  };
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
  await boot(fixture);
  await ana.signUp();
  tenantId = (await me(ana)).tenantId;
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await setTenantSettings(tenantId, { quietHours: { from: '00:00', to: '00:00' } });
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

/** A customer's task, and their assistant's request to delete it (parked for the business). */
async function customerAsksToDelete(title: string) {
  const address = phone();
  const customer = await seedContact(tenantId, 'Kavya', address);
  const as = asAssistant(`contact:${customer.contactId}`);
  const task = (await as('POST', '/api/tasks', { title })).body.value as { id: string };
  const parked = await as('DELETE', `/api/tasks/${task.id}`);
  expect(parked.body.status).toBe('needs_approval');
  return { address, customer, task, approvalId: parked.body.approval.id as string };
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
    const { address, task, approvalId } = await customerAsksToDelete('Return the samples');
    const { approve } = await requestButtons(anaPhone, approvalId);
    expect(approve).toMatch(/^apr:/);

    await tap(anaPhone, approve);
    await heard(anaPhone, /Done: Delete/);
    expect((await ana.call('GET', `/api/tasks/${task.id}`)).status).toBe(404);
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
    const { address, task, approvalId } = await customerAsksToDelete('Keep the samples');
    const { reject } = await requestButtons(anaPhone, approvalId);
    await tap(anaPhone, reject);
    await heard(anaPhone, /Rejected: Delete/);
    expect((await ana.call('GET', `/api/tasks/${task.id}`)).status).toBe(200);
    const outcome = await eventually(() =>
      toNumber(address).find((s) => s.template?.name === 'approval_outcome_v1'),
    );
    expect(JSON.stringify(outcome.template)).toContain('not approved');
  });

  it('a forwarded button is refused: it only works from the number it was sent to', async () => {
    const { address, task, approvalId } = await customerAsksToDelete('Forwarded one');
    const { approve } = await requestButtons(anaPhone, approvalId);
    await tap(address, approve);
    await heard(address, /isn't for this number/);
    expect((await ana.call('GET', `/api/tasks/${task.id}`)).status).toBe(200);
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
    await ana.call('POST', '/api/tasks', { title: 'Order tiles' });
    await ana.call('POST', '/api/tasks', { title: 'Order grout' });
    const isPick = (m: Sent) => JSON.stringify(m.interactive?.action ?? '').includes('pick:');
    // A list that is the answer (nothing changed after it), to tap: headed by the view's title,
    // not its first row (V7).
    const listedFrom = toNumber(anaPhone).length;
    await say(anaPhone, 'delete Order nothing');
    const listed = await eventually(() => {
      const picks = toNumber(anaPhone).slice(listedFrom).filter(isPick);
      return picks.length ? picks : undefined;
    });
    for (const m of listed) expect(m.interactive?.body?.text).toBe('Tasks');
    const before = textsTo(anaPhone).length;
    const sentBefore = toNumber(anaPhone).length;
    await say(anaPhone, 'delete Order tiles');
    const buttons = await eventually(() =>
      toNumber(anaPhone).find((s) =>
        s.interactive?.action.buttons?.some((b) => b.reply.id.startsWith('apr:')),
      ),
    );
    const approve = buttons.interactive?.action.buttons?.[0].reply.id ?? '';
    // Hers to decide: her approval, asked once (V7).
    await heard(anaPhone, /I've asked for your approval: Delete "Order tiles"/);
    // The tasks it looked through to find this one are no answer: not shown beside it (V13).
    expect(toNumber(anaPhone).slice(sentBefore).filter(isPick)).toEqual([]);
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
    await asAssistant(`contact:${customer.contactId}`)('POST', '/api/tasks', {
      title: 'Order tiles',
    });
    await say(address, 'delete Order tiles');
    // The business decides: the customer is told the team was asked, once, and never asked to
    // approve it themselves (V7).
    const told = await heard(address, /asked the team/);
    expect(told).toContain(`I've asked the team for approval: Delete "Order tiles"`);
    expect(told).not.toMatch(/your approval|until you approve/);
    expect(told.match(/asked the team/g)).toHaveLength(1);
    expect(
      toNumber(address).some((s) => JSON.stringify(s.interactive ?? '').includes('apr:')),
    ).toBe(false);
  });

  it('the run goes on where it came from: on WhatsApp, once decided (A7)', async () => {
    // Ana's own request, decided with the button: the assistant's run goes on in her chat.
    await ana.call('POST', '/api/tasks', { title: 'Order paint' });
    await say(anaPhone, 'delete Order paint');
    const buttons = await eventually(() =>
      toNumber(anaPhone).find(
        (s) =>
          s.interactive?.body?.text?.includes('Order paint') &&
          s.interactive?.action.buttons?.some((b) => b.reply.id.startsWith('apr:')),
      ),
    );
    await tap(anaPhone, buttons.interactive?.action.buttons?.[0].reply.id ?? '');
    await heard(anaPhone, /Done: Delete "Order paint"/);
    await heard(anaPhone, /That was approved and is done: Delete "Order paint"/);

    // A customer's request, decided by the business in the app: the customer hears it go on.
    const address = phone();
    const customer = await seedContact(tenantId, 'Leela', address);
    await asAssistant(`contact:${customer.contactId}`)('POST', '/api/tasks', {
      title: 'Return tiles',
    });
    await say(address, 'delete Return tiles');
    await heard(address, /asked the team/);
    const { rows } = await pool.query(
      `select id from app.approvals where requester_contact_id = $1 and status = 'pending'`,
      [customer.contactId],
    );
    expect(rows).toHaveLength(1);
    const rejected = await ana.call('POST', `/api/approvals/${rows[0].id}/reject`);
    expect(rejected.body.status).toBe('rejected');
    await heard(address, /That was rejected, so nothing changed: Delete "Return tiles"/);
  });

  it("the business's own roles count: a role it made, or one it gave approvals.decide, is asked", async () => {
    // Bea holds a role the business made; Cal is staff, a role it gave approvals.decide.
    const bea = new Person('Bea Approves');
    const cal = new Person('Cal Approves');
    const numbers = new Map<Person, string>();
    for (const [person, roles] of [
      [bea, ['deputy']],
      [cal, ['staff']],
    ] as const) {
      await person.signUp();
      await addMember(person, tenantId, [...roles]);
      const number = phone();
      const c = await seedContact(tenantId, person.name, number);
      await pool.query(
        'update channel.contacts set user_id = $1, linked_at = now(), welcomed_at = now() where id = $2',
        [person.id, c.contactId],
      );
      numbers.set(person, number);
    }
    const roles = {
      defined: [{ name: 'deputy', label: { en: 'Deputy' }, capabilities: ['approvals.decide'] }],
      edits: { staff: { capabilities: ['approvals.decide', 'backoffice.use'] } },
    };
    await setTenantSettings(tenantId, { roles });

    const { approvalId } = await customerAsksToDelete('Fetch the ladder');
    for (const number of [anaPhone, numbers.get(bea) ?? '', numbers.get(cal) ?? ''])
      await requestButtons(number, approvalId);
  });

  it('a contact given approvals.decide is told the team was asked, and never decides its own (V7)', async () => {
    // The roles the test above left, plus approvals.decide for every contact.
    const before = {
      defined: [{ name: 'deputy', label: { en: 'Deputy' }, capabilities: ['approvals.decide'] }],
      edits: { staff: { capabilities: ['approvals.decide', 'backoffice.use'] } },
    };
    const customer = { capabilities: ['approvals.decide'] };
    await setTenantSettings(tenantId, {
      roles: { ...before, edits: { ...before.edits, customer } },
    });
    try {
      const address = phone();
      const rani = await seedContact(tenantId, 'Rani', address);
      await asAssistant(`contact:${rani.contactId}`)('POST', '/api/tasks', {
        title: 'Sweep the porch',
      });
      await say(address, 'delete Sweep the porch');
      const told = await heard(address, /asked the team/);
      expect(told).not.toMatch(/your approval|until you approve/);
      expect(
        toNumber(address).some((s) => JSON.stringify(s.interactive ?? '').includes('apr:')),
      ).toBe(false);
      const { rows } = await pool.query(
        `select id from app.approvals where requester_contact_id = $1 and status = 'pending'`,
        [rani.contactId],
      );
      expect(rows).toHaveLength(1);
      // Even a genuine button for it, sent to this number, does not decide it.
      const approve = signApproval(
        process.env.APPROVAL_SECRET ?? '',
        { approvalId: rows[0].id, approve: true, expiresAt: Date.now() + 60_000 },
        rani.contactId,
      );
      await tap(address, approve);
      await heard(address, /isn't for this number/);
      const after = await pool.query('select status from app.approvals where id = $1', [
        rows[0].id,
      ]);
      expect(after.rows[0].status).toBe('pending');
    } finally {
      await setTenantSettings(tenantId, { roles: before });
    }
  });
});
