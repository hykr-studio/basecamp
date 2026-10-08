// Voice notes and handoff: a voice note is heard (its words kept, never the audio); a person
// takes over when the customer asks, when the assistant asks, or after two failed turns; staff
// answer from the back office and hand the conversation back.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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

type Sent = { to: string; type?: string; text?: { body: string }; template?: { name: string } };
const sent: Sent[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n && s.type);
const textsTo = (n: string) => toNumber(n).flatMap((s) => (s.text ? [s.text.body] : []));
/** Voice notes the stand-in serves, by media id. */
const media = new Map<string, string>();

let stub: Server;
let stubUrl = '';
const secret = 'test-app-secret';
const NUMBER = `pn-ho-${Date.now()}`;
const ana = new Person('Ana Backoffice');
const ravi = new Person('Ravi Backoffice');
let tenantId = '';
let seq = 0;
const phone = () => `9155${String(Date.now()).slice(-6)}${seq++ % 10}`;

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
                  id: `m-ho-${Date.now()}-${seq++}`,
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
const say = (from: string, body: string) => deliver(from, { type: 'text', text: { body } });
const voiceNote = (from: string, bytes: string) => {
  const id = `media-${Date.now()}-${seq++}`;
  media.set(id, bytes);
  return deliver(from, { type: 'audio', audio: { id, mime_type: 'audio/ogg; codecs=opus' } });
};
const heard = (n: string, words: RegExp, ms = 10_000) =>
  eventually(() => textsTo(n).find((t) => words.test(t)), ms);

/** A new customer who has already been welcomed (so replies are the answer, not the notice). */
async function customer(name: string) {
  const address = phone();
  const c = await seedContact(tenantId, name, address);
  await pool.query('update channel.contacts set welcomed_at = now() where id = $1', [c.contactId]);
  return { address, ...c };
}
const openHandoff = (contactId: string) =>
  eventually(async () => {
    const { rows } = await pool.query(
      `select id, reason, state from channel.handoffs where contact_id = $1 and state <> 'closed'`,
      [contactId],
    );
    return rows[0] as { id: string; reason: string; state: string } | undefined;
  }, 25_000);

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET') {
        // The media file itself, then its metadata (/<version>/<media id>).
        const file = /\/files\/(.+)$/.exec(path)?.[1];
        if (file) {
          res.writeHead(200, { 'content-type': 'audio/ogg' }).end(media.get(file) ?? '');
          return;
        }
        const id = path.split('/').at(-1) ?? '';
        if (media.has(id)) {
          json({ url: `${stubUrl}/files/${id}`, mime_type: 'audio/ogg' });
          return;
        }
        json({ data: [] });
        return;
      }
      sent.push(JSON.parse(data) as Sent);
      json({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  stubUrl = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_GRAPH_URL = stubUrl;
  process.env.WA_APP_SECRET = secret;
  // Only the fake notes are heard: no calls to Sarvam from the tests.
  process.env.SARVAM_API_KEY = '';
  await boot();
  await ana.signUp();
  await ravi.signUp();
  tenantId = (await me(ana)).tenantId;
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  for (const t of templates)
    for (const lang of ['en', 'hi', 'te'] as const)
      await pool.query(
        `insert into channel.templates (name, language, category, content_hash, status)
         values ($1, $2, $3, $4, 'APPROVED')
         on conflict (name, language) do update set status = 'APPROVED'`,
        [t.name, lang, t.category, contentHash(t, lang)],
      );
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

describe('voice notes', () => {
  it('a Hindi voice note is heard and answered in Hindi; only its words are kept', async () => {
    const { address, customerId } = await customer('Sita');
    await voiceNote(address, 'FAKE-STT:hi:जोड़ो Pay the electrician');
    await heard(address, /[ऀ-ॿ]/);
    const { rows } = await pool.query(
      'select title from app.todos where customer_id = $1 and tenant_id = $2',
      [customerId, tenantId],
    );
    expect(rows).toEqual([{ title: 'Pay the electrician' }]);
    const { rows: kept } = await pool.query(
      `select m.kind, m.body from channel.messages m join channel.contacts c on c.id = m.contact_id
       where c.address = $1 and m.direction = 'in'`,
      [address],
    );
    expect(kept).toEqual([{ kind: 'text', body: null }]);
  });

  it("a voice note that can't be heard is said so, and nothing is guessed", async () => {
    const { address } = await customer('Ravi');
    await voiceNote(address, 'OggS-not-a-fake-note');
    await heard(address, /couldn't make out that voice note/);
  });
});

describe('handoff', () => {
  it('two failed turns in a row: a person takes over, and the assistant goes quiet', async () => {
    const { address, contactId } = await customer('Lata');
    await say(address, 'FAIL THIS TURN');
    await heard(address, /went wrong|try again/i, 25_000);
    await say(address, 'FAIL THIS TURN');
    const handoff = await openHandoff(contactId);
    expect(handoff.reason).toBe('agent_failed');
    await heard(address, /Someone from the team will reply here/, 10_000);

    // Silent now: the message waits for staff, in the thread.
    const before = textsTo(address).length;
    await say(address, 'hello?');
    const thread = await eventually(async () => {
      const t = (await ana.call('GET', `/api/backoffice/handoffs/${handoff.id}`)).body;
      return t.messages?.some((m: { text: string }) => m.text === 'hello?') ? t : undefined;
    });
    expect(thread.contact.address).toBe(address);
    expect(textsTo(address).length).toBe(before);
  }, 60_000);

  it('the assistant can hand over when asked for a person', async () => {
    const { address, contactId } = await customer('Gopal');
    await say(address, 'I want to talk to the manager');
    await heard(address, /asked the team/);
    expect((await openHandoff(contactId)).reason).toBe('agent_tool');
    // Only in a WhatsApp conversation.
    const fromApp = await asAssistant(`user:${ana.id}`, { 'x-channel': 'app' })(
      'POST',
      '/api/handoff',
      { reason: 'test' },
    );
    expect(fromApp.status).toBe(403);
  });

  it('staff take it, draft, reply, and hand it back; the assistant answers again', async () => {
    const { address, contactId } = await customer('Imran');
    await say(address, 'talk to a person');
    const handoff = await openHandoff(contactId);

    // Only this business's staff see it.
    const inbox = (await ana.call('GET', '/api/backoffice/inbox')).body;
    expect(inbox.open.map((h: { id: string }) => h.id)).toContain(handoff.id);
    expect((await ravi.call('GET', `/api/backoffice/handoffs/${handoff.id}`)).status).toBe(404);
    const asCustomer = await asAssistant(`contact:${contactId}`)('GET', '/api/backoffice/inbox');
    expect(asCustomer.status).toBe(403);

    expect((await ana.call('POST', `/api/backoffice/handoffs/${handoff.id}/take`)).status).toBe(
      200,
    );
    const mine = (await ana.call('GET', '/api/backoffice/inbox')).body.mine;
    expect(mine.map((h: { id: string }) => h.id)).toContain(handoff.id);

    const draft = (await ana.call('POST', `/api/backoffice/handoffs/${handoff.id}/draft`)).body;
    expect(draft.text).toMatch(/Thank you/);
    const reply = await ana.call('POST', `/api/backoffice/handoffs/${handoff.id}/reply`, {
      text: 'Hi Imran, your tiles arrive on Friday.',
    });
    expect(reply.body).toEqual({ sent: 'text' });
    await heard(address, /tiles arrive on Friday/);

    // Outside the 24 hours, the same reply goes as the approved template.
    await pool.query(
      `update channel.messages set at = now() - interval '25 hours' where contact_id = $1 and direction = 'in'`,
      [contactId],
    );
    const late = await ana.call('POST', `/api/backoffice/handoffs/${handoff.id}/reply`, {
      text: 'Also, the invoice is ready.',
    });
    expect(late.body).toEqual({ sent: 'template' });
    await eventually(() => toNumber(address).find((s) => s.template?.name === 'handoff_reply_v1'));

    const back = await ana.call('POST', `/api/backoffice/handoffs/${handoff.id}/return`, {
      resolution: 'Told them the delivery date',
    });
    expect(back.body).toEqual({ state: 'closed' });
    await say(address, 'list');
    await eventually(() => (textsTo(address).length > 2 ? true : undefined));
    const { rows } = await pool.query(
      `select action from audit.events where resource_id = $1 order by at`,
      [handoff.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'handoff.opened',
      'handoff.taken',
      'handoff.replied',
      'handoff.replied',
      'handoff.returned',
    ]);
  });

  it("staff see a linked person's WhatsApp conversation, never their app chats", async () => {
    const { address, contactId } = await customer('Ana herself');
    await pool.query('update channel.contacts set user_id = $1, linked_at = now() where id = $2', [
      ana.id,
      contactId,
    ]);
    await ana.call('POST', '/api/chat/once', { message: 'my private app question' });
    await say(address, 'talk to a person');
    const handoff = await openHandoff(contactId);
    const thread = (await ana.call('GET', `/api/backoffice/handoffs/${handoff.id}`)).body;
    const texts = thread.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain('talk to a person');
    expect(texts).not.toContain('my private app question');
  });

  it('a handoff nobody takes for a day is flagged first in the inbox', async () => {
    const { address, contactId } = await customer('Neha');
    await say(address, 'talk to a person');
    const handoff = await openHandoff(contactId);
    await pool.query(
      `update channel.handoffs set opened_at = now() - interval '25 hours' where id = $1`,
      [handoff.id],
    );
    const { MaintenanceProcessor } = await import(
      '../../dist/channels/maintenance/maintenance.processor.js'
    );
    await server.app?.get(MaintenanceProcessor).flagStale();
    const inbox = (await ana.call('GET', '/api/backoffice/inbox')).body;
    expect(inbox.open[0]).toMatchObject({ id: handoff.id, flagged: true });
  });

  it('staff record consent given on the phone; it is audited', async () => {
    const { contactId } = await customer('Farah');
    const res = await ana.call('POST', `/api/backoffice/contacts/${contactId}/consent`, {
      topic: 'marketing',
      granted: true,
      note: 'said yes on the phone',
    });
    expect(res.body).toEqual({ topic: 'marketing', granted: true });
    const { rows } = await pool.query(
      `select granted, source from channel.consents where contact_id = $1 and topic = 'marketing'`,
      [contactId],
    );
    expect(rows).toEqual([{ granted: true, source: `staff:${ana.id}` }]);
    const asRavi = await ravi.call('POST', `/api/backoffice/contacts/${contactId}/consent`, {
      topic: 'marketing',
      granted: false,
    });
    expect(asRavi.status).toBe(404);
  });
});
