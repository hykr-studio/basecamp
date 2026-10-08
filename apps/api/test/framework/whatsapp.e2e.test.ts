// WhatsApp: a channel without a screen. Same agent, surfaces ['text'], replies in words.
// Domain-free: it asks about saved pages, the framework's own entity.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, boot, eventually, me, Person, pool, server, shutdown } from '../support.js';

/** A stand-in for the Cloud API: records what the adapter sends. */
type Sent = {
  path: string;
  body: { to: string; type?: string; status?: string; text: { body: string } };
};
const sent: Sent[] = [];
/** Messages to one number (read receipts aside). */
const to = (n: string) => sent.filter((s) => s.body.to === n && s.body.type);
let stub: Server;
const secret = 'test-app-secret';
const phone = `9198${String(Date.now()).slice(-8)}`;
const ana = new Person('Ana WhatsApp');

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      // Template listing (the status job): none here.
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push({ path: req.url ?? '', body: JSON.parse(data) });
      // Unique across runs, as WhatsApp's own ids are.
      const id = `wamid.${Date.now()}.${sent.length}`;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id }], success: true }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  const port = (stub.address() as { port: number }).port;
  process.env.WA_GRAPH_URL = `http://localhost:${port}`;
  process.env.WA_APP_SECRET = secret;
  process.env.WA_VERIFY_TOKEN = 'test-verify';
  await boot();
  await ana.signUp();
  // The business number is Ana's business's: messages to it are her business's conversations.
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await ana.call('POST', '/api/pages', {
    name: 'Focus board',
    spec: {
      title: 'Numbers',
      layout: 'stack',
      blocks: [{ id: 'k', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
    },
  });
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

const NUMBER = `pn-${Date.now()}`;
let seq = 0;
const delivery = (from: string, body: string, id = `m-${Date.now()}-${seq++}`) =>
  JSON.stringify({
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
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });

const post = (raw: string, signature?: string) =>
  fetch(`${server.base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body: raw,
  });
const sign = (raw: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('whatsapp', () => {
  it('answers the verify challenge only with the right token', async () => {
    const ok = await fetch(
      `${server.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=42`,
    );
    expect(await ok.text()).toBe('42');
    const bad = await fetch(
      `${server.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`,
    );
    expect(bad.status).toBe(403);
  });

  it('refuses a delivery without a valid signature: 401', async () => {
    const raw = delivery(phone, 'open my Focus board page');
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw, sign(`${raw} `))).status).toBe(401);
  });

  it('a new number is a customer: welcomed once, then answered', async () => {
    const stranger = `1555${String(Date.now()).slice(-7)}`;
    const raw = delivery(stranger, 'open my Focus board page');
    expect((await post(raw, sign(raw))).status).toBe(200);
    const replies = await eventually(() => (to(stranger).length >= 2 ? to(stranger) : undefined));
    expect(replies[0].body.text.body).toContain('privacy notice');
    // A customer sees only their own records: Ana's page is not theirs to find.
    expect(replies[1].body.text.body).toMatch(/couldn't find a page/);
    const { rows } = await pool.query(
      `select c.customer_id is not null as customer, c.welcomed_at is not null as welcomed
       from channel.contacts c join channel.numbers n on n.tenant_id = c.tenant_id
       where n.phone_number_id = $1 and c.address = $2`,
      [NUMBER, stranger],
    );
    expect(rows).toEqual([{ customer: true, welcomed: true }]);
  });

  it('linking takes the code sent to the number; a wrong code is refused', async () => {
    const asked = await ana.call('POST', '/api/channels/whatsapp/code', {
      phone: `+${phone}`,
      timeZone: 'Asia/Kolkata',
    });
    expect(asked.status).toBe(201);
    const sentCode = await eventually(() =>
      to(phone).find((s) => s.body.template?.name === 'login_code_v1'),
    );
    const code = sentCode.body.template?.components[0].parameters[0].text ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await ana.call('POST', '/api/channels/whatsapp/verify', {
      phone,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);
    const linked = await ana.call('POST', '/api/channels/whatsapp/verify', { phone, code });
    expect(linked.status).toBe(201);
    expect((await ana.call('GET', '/api/channels/whatsapp')).body).toEqual({
      address: phone,
      timeZone: 'Asia/Kolkata',
    });
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events where action = 'channel.contact.linked' and actor_id = $1`,
      [ana.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a linked number acts as its person: a plain list, never a screen', async () => {
    const raw = delivery(phone, 'open my Focus board page');
    expect((await post(raw, sign(raw))).status).toBe(200);
    const texts = () => to(phone).filter((s) => s.body.type === 'text');
    const [reply] = await eventually(() => (texts().length ? texts() : undefined));
    expect(reply.path).toBe(`/v25.0/${NUMBER}/messages`);
    expect(reply.body.text.body).toContain('• Focus board');
    expect(reply.body.text.body).not.toMatch(/canvas|screen|opened/i);
    // It was read (blue ticks) while the agent worked.
    expect(sent.some((s) => s.body.status === 'read')).toBe(true);
  });

  it('the same message delivered twice runs one turn', async () => {
    const before = to(phone).length;
    const raw = delivery(phone, 'open my Focus board page', `dup-${Date.now()}`);
    expect((await post(raw, sign(raw))).status).toBe(200);
    expect((await post(raw, sign(raw))).status).toBe(200);
    await eventually(() => (to(phone).length > before ? true : undefined));
    await new Promise((r) => setTimeout(r, 2500));
    expect(to(phone).length).toBe(before + 1);
  });

  it('a number belongs to one person in a business', async () => {
    const bob = new Person('Bob WhatsApp');
    await bob.signUp();
    await addMember(bob, (await me(ana)).tenantId, ['ops']);
    const taken = await bob.call(
      'POST',
      '/api/channels/whatsapp/code',
      { phone },
      {
        'x-tenant-id': (await me(ana)).tenantId,
      },
    );
    expect(taken.status).toBe(409);
  });

  describe('keywords, handled by code before the agent', () => {
    const customer = `1556${String(Date.now()).slice(-7)}`;
    const say = async (text: string) => {
      const before = to(customer).length;
      const raw = delivery(customer, text);
      expect((await post(raw, sign(raw))).status).toBe(200);
      return eventually(() =>
        to(customer).length > before ? to(customer).slice(before) : undefined,
      );
    };
    const contactRow = async () =>
      (
        await pool.query(
          `select c.id from channel.contacts c join channel.numbers n on n.tenant_id = c.tenant_id
           where n.phone_number_id = $1 and c.address = $2`,
          [NUMBER, customer],
        )
      ).rows[0] as { id: string } | undefined;

    it('STOP turns reminders and offers off, START turns reminders back on', async () => {
      await say('hello'); // welcome + answer: the contact exists now
      await new Promise((r) => setTimeout(r, 400));
      const [stopped] = await say('STOP');
      expect(stopped.body.text.body).toContain("won't get reminders");
      const { id } = (await contactRow()) as { id: string };
      const latest = async () =>
        (
          await pool.query(
            `select distinct on (topic) topic, granted from channel.consents
             where contact_id = $1 order by topic, at desc, id desc`,
            [id],
          )
        ).rows;
      expect(await latest()).toEqual([
        { topic: 'marketing', granted: false },
        { topic: 'reminders', granted: false },
        { topic: 'service', granted: true },
      ]);
      const [started] = await say('start');
      expect(started.body.text.body).toContain('Reminders are on again');
      expect((await latest()).find((r: { topic: string }) => r.topic === 'reminders')).toEqual({
        topic: 'reminders',
        granted: true,
      });
    });

    it('HELP says what the assistant does and whom to ask about data', async () => {
      const [help] = await say('help');
      expect(help.body.text.body).toContain('privacy@example.in');
    });

    it('a person: a handoff opens, and the assistant stays silent after', async () => {
      const [handoff] = await say('talk to a person');
      expect(handoff.body.text.body).toContain('Someone from the team will reply here');
      const before = to(customer).length;
      const raw = delivery(customer, 'are you there?');
      await post(raw, sign(raw));
      await new Promise((r) => setTimeout(r, 3000));
      expect(to(customer).length).toBe(before);
      const { rows } = await pool.query(
        `select h.state, m.text from channel.handoffs h
         join app.thread_messages m on m.thread_id = h.thread_id
         where h.contact_id = $1 order by m.seq desc limit 1`,
        [(await contactRow())?.id],
      );
      expect(rows).toEqual([{ state: 'open', text: 'are you there?' }]);
    });

    it('"delete my data": confirmed by message, then gone', async () => {
      const { id } = (await contactRow()) as { id: string };
      const before = to(customer).length;
      const raw = delivery(customer, 'delete my data');
      await post(raw, sign(raw));
      const [confirm] = await eventually(() =>
        to(customer).length > before ? to(customer).slice(before) : undefined,
      );
      expect(confirm.body.text.body).toContain('has been deleted');
      await eventually(async () => ((await contactRow()) ? undefined : true));
      const left = await pool.query(
        `select (select count(*)::int from channel.consents where contact_id = $1) as consents,
                (select count(*)::int from channel.messages where contact_id = $1) as messages,
                (select count(*)::int from app.threads where contact_id = $1) as threads,
                (select count(*)::int from channel.inbound_events where "from" = $2) as events,
                (select count(*)::int from audit.events where action = 'channel.contact.erased' and resource_id = $1) as audited`,
        [id, customer],
      );
      expect(left.rows[0]).toEqual({ consents: 0, messages: 0, threads: 0, events: 0, audited: 1 });
    });
  });
});
