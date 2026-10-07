// WhatsApp: a channel without a screen. Same agent, surfaces ['text'], replies in words.
// Domain-free: it asks about saved pages, the framework's own entity.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, Person, server, shutdown } from '../support.js';

/** A stand-in for the Cloud API: records what the adapter sends. */
const sent: { path: string; body: { to: string; text: { body: string } } }[] = [];
let stub: Server;
const secret = 'test-app-secret';
const phone = `9198${String(Date.now()).slice(-8)}`;
const ana = new Person('Ana WhatsApp');

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      sent.push({ path: req.url ?? '', body: JSON.parse(data) });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":[{"id":"w1"}]}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  const port = (stub.address() as { port: number }).port;
  process.env.WHATSAPP_API_BASE_URL = `http://localhost:${port}`;
  process.env.WHATSAPP_APP_SECRET = secret;
  process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify';
  await boot();
  await ana.signUp();
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

const delivery = (from: string, body: string) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '573542517421694' },
              messages: [{ from, id: `m-${Math.random()}`, type: 'text', text: { body } }],
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

async function nextReply(count: number) {
  for (let i = 0; i < 100 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 50));
  return sent[count - 1];
}

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

  it('refuses a delivery without a valid signature', async () => {
    const raw = delivery(phone, 'open my Focus board page');
    expect((await post(raw)).status).toBe(403);
    expect((await post(raw, sign(`${raw} `))).status).toBe(403);
  });

  it('tells an unknown number to link itself', async () => {
    const raw = delivery('15550001111', 'open my Focus board page');
    expect((await post(raw, sign(raw))).status).toBe(200);
    const reply = await nextReply(1);
    expect(reply.body.to).toBe('15550001111');
    expect(reply.body.text.body).toContain("isn't linked");
  });

  it('a linked number gets the answer as a plain list, never a screen', async () => {
    const link = await ana.call('POST', '/api/channels/whatsapp', {
      phone: `+${phone}`,
      timeZone: 'Asia/Kolkata',
    });
    expect(link.status).toBe(201);
    const raw = delivery(phone, 'open my Focus board page');
    expect((await post(raw, sign(raw))).status).toBe(200);
    const reply = await nextReply(2);
    expect(reply.path).toBe('/v21.0/573542517421694/messages');
    expect(reply.body.to).toBe(phone);
    expect(reply.body.text.body).toContain('• Focus board');
    expect(reply.body.text.body).not.toMatch(/canvas|screen|opened/i);
  });

  it('a number belongs to one person', async () => {
    const bob = new Person('Bob WhatsApp');
    await bob.signUp();
    const taken = await bob.call('POST', '/api/channels/whatsapp', { phone });
    expect(taken.status).toBe(409);
  });
});
