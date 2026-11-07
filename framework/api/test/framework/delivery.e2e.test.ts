// Delivery channels, inbound hooks and personal-data contributors (F5): a notification without a
// WhatsApp template reaches a registered channel and falls back to email; WhatsApp messages pass
// the inbound hooks; "delete my data" runs the erasure contributors in its transaction. A
// stand-in Cloud API, Mailpit for email, the real queues (inline).
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as api from '../../dist/index.js';
import {
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  shutdown,
} from '../../dist/testing.js';
import { runtimeApp, seen } from '../fixture/dist/features/runtime/index.js';

type Sent = { to: string; type?: string; text?: { body: string } };
const sent: Sent[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n && s.type);
let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-dlv-${Date.now()}`;
const ana = new Person('Ana Delivery');
const ravi = new Person('Ravi Delivery');
let tenantId = '';
let seq = 0;
const phone = () => `9166${String(Date.now()).slice(-6)}${seq++ % 10}`;

/** Mailpit's messages to one address. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { Subject: string }[] }).messages;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push(JSON.parse(data));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  await boot(runtimeApp);
  await ana.signUp();
  await ravi.signUp();
  tenantId = (await me(ana)).tenantId;
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

// Imported late: the app's configuration must see the stand-in's URL and secret first.
const internals = async () => ({
  ...(await import('../../dist/testing-internals.js')),
  ...(await import('../../dist/channels/maintenance/erasure.service.js')),
});

const task = async (who: Person, title: string) =>
  (await who.call('POST', '/api/tasks', { title })).body.value as { id: string };
const pagesOf = (id: string) => seen.deliveries.filter((d) => d.row.id === id);

describe('delivery channels', () => {
  it('a notification without a template reaches the registered channel, for its recipient', async () => {
    const t = await task(ana, 'Page ok');
    const [page] = await eventually(() => (pagesOf(t.id).length ? pagesOf(t.id) : undefined));
    expect(page).toMatchObject({
      tenantId,
      to: { userId: ana.id },
      reader: { lang: 'en' },
      row: { id: t.id, title: 'Page ok' },
      dedupe: `task.paged:${t.id}`,
      meta: { key: 'task.paged', recipient: { userId: ana.id }, next: ['email'] },
    });
    expect(page.notification.key).toBe('task.paged');
  });

  it('another business’s notification goes to that business’s person only', async () => {
    const t = await task(ravi, 'Page ravi');
    const [page] = await eventually(() => (pagesOf(t.id).length ? pagesOf(t.id) : undefined));
    expect(page.to).toEqual({ userId: ravi.id });
    expect(page.tenantId).not.toBe(tenantId);
  });

  it('unavailable, or failed for good: the next channel (email), at once', async () => {
    const away = await task(ana, 'Page away');
    const broken = await task(ana, 'Page broken');
    const mail = await eventually(async () => {
      const subjects = (await mailTo(ana.email)).map((m) => m.Subject);
      return subjects.includes('Paged: Page away') && subjects.includes('Paged: Page broken')
        ? subjects
        : undefined;
    });
    expect(mail).not.toContain('Paged: Page ok');
    expect(pagesOf(away.id)).toHaveLength(1);
    expect(pagesOf(broken.id)).toHaveLength(1);
  });

  it('failed for now: the same channel again later, and no email', async () => {
    const t = await task(ana, 'Page flaky');
    await eventually(() => (pagesOf(t.id).length >= 2 ? true : undefined), 20_000);
    expect((await mailTo(ana.email)).map((m) => m.Subject)).not.toContain('Paged: Page flaky');
  }, 30_000);

  it('the release check skips a notification that has no template', async () => {
    const { DB, TemplateSync } = await internals();
    const db = server.app?.get(DB, { strict: false });
    const problems = await new TemplateSync(db, {} as never, 'http://app').check();
    expect(problems.join(' ')).not.toContain('paged');
  });

  it('the names whatsapp and email are the dispatcher’s own', async () => {
    const { NotifyService } = await internals();
    api.deliveryChannels.register({
      name: 'email',
      deliver: async () => ({ status: 'sent' }),
    });
    const notify = server.app?.get(NotifyService, { strict: false }) as {
      onApplicationBootstrap(): void;
    };
    expect(() => notify.onApplicationBootstrap()).toThrow('"email" is built in');
  });
});

describe('inbound hooks', () => {
  let n = 0;
  /** One webhook delivery from one sender: its messages are one burst. */
  const webhook = (from: string, messages: object[]) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: NUMBER },
                contacts: [{ wa_id: from, profile: { name: 'Lakshmi' } }],
                messages,
              },
            },
          ],
        },
      ],
    });
  const message = (from: string, body: object) => ({
    from,
    id: `m-dlv-${Date.now()}-${n++}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...body,
  });
  const photo = (from: string, caption?: string) => {
    const mediaId = `media-dlv-${Date.now()}-${n++}`;
    return {
      mediaId,
      message: message(from, {
        type: 'image',
        image: { id: mediaId, mime_type: 'image/jpeg', caption },
      }),
    };
  };
  const image = (from: string, caption?: string) => {
    const { mediaId, message } = photo(from, caption);
    return { mediaId, raw: webhook(from, [message]) };
  };
  const post = (raw: string) =>
    fetch(`${server.base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });

  it('a hook adds context the turn reads: a photo becomes words the assistant answers', async () => {
    const from = phone();
    const { raw, mediaId } = image(from);
    expect((await post(raw)).status).toBe(200);
    const reply = await eventually(() =>
      toNumber(from).find((s) => s.text?.body.includes(`Got your photo ${mediaId}`)),
    );
    expect(reply).toBeDefined();
    const info = seen.inbound.find((i) => i.message.from === from);
    expect(info).toMatchObject({ tenantId, message: { body: { kind: 'media', mediaId } } });
    expect(info?.contactId).toBeTruthy();
  });

  it('a hook that handles a message keeps it out of the turn', async () => {
    const from = phone();
    const { raw, mediaId } = image(from, 'keep');
    await post(raw);
    await eventually(() =>
      seen.inbound.find(
        (i) => i.message.body.kind === 'media' && i.message.body.mediaId === mediaId,
      ),
    );
    // Only the welcome: no turn ran for a message the hook took.
    await new Promise((r) => setTimeout(r, 1500));
    expect(toNumber(from).some((s) => s.text?.body.includes('Got your photo'))).toBe(false);
    const { rows } = await pool.query(
      `select count(*)::int as n from app.threads t join channel.contacts c on c.id = t.contact_id
       where c.address = $1`,
      [from],
    );
    expect(rows[0].n).toBe(0);
  });

  it('a burst that asks for erasure passes no hook: a photo sent with it is never kept', async () => {
    const from = phone();
    const { mediaId, message: picture } = photo(from);
    const ask = message(from, { type: 'text', text: { body: 'DELETE MY DATA' } });
    expect((await post(webhook(from, [picture, ask]))).status).toBe(200);
    // Erased, and told so.
    await eventually(() =>
      toNumber(from).find(
        (s) => s.text?.body === 'Your data here has been deleted. Thank you for talking to us.',
      ),
    );
    const { rows } = await pool.query(
      `select count(*)::int as n from channel.contacts where address = $1`,
      [from],
    );
    expect(rows[0].n).toBe(0);
    // The burst is done before the hooks: nothing stored the photo, before or after.
    await new Promise((r) => setTimeout(r, 1000));
    expect(
      seen.inbound.some(
        (i) =>
          i.message.from === from ||
          (i.message.body.kind === 'media' && i.message.body.mediaId === mediaId),
      ),
    ).toBe(false);
    expect(toNumber(from).some((s) => s.text?.body.includes('Got your photo'))).toBe(false);
  });
});

describe('a refused turn on WhatsApp', () => {
  it('is answered with the refusal, in the person’s language, and not retried', async () => {
    const from = phone();
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
                    id: `m-refuse-${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'refuse me' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await fetch(`${server.base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
    const said = await eventually(() =>
      toNumber(from).find((s) => s.text?.body === 'Your credits are used up.'),
    );
    expect(said).toBeDefined();
    const { rows } = await pool.query(
      `select error from channel.inbound_events where "from" = $1`,
      [from],
    );
    expect(rows).toEqual([{ error: null }]);
  });
});

describe('personal data contributors', () => {
  it('"delete my data" runs them in its transaction, and audits their counts', async () => {
    const { ErasureService } = await internals();
    const { contactId } = await seedContact(tenantId, 'Erase Me', phone());
    await server.app?.get(ErasureService, { strict: false }).erase(contactId);
    expect(seen.erased).toContainEqual({ subject: { kind: 'contact', contactId }, tenantId });
    const { rows } = await pool.query(
      `select after from audit.events where action = 'channel.contact.erased' and resource_id = $1`,
      [contactId],
    );
    // The framework's own (files, jobs, parties, push) run too: a contact has no files, no jobs,
    // no party memberships and no devices.
    expect(rows).toEqual([
      {
        after: {
          contributors: { files: 0, jobs: 0, parties: 0, push: 0, 'fixture.runtime.erase': 1 },
        },
      },
    ]);
  });

  it('export collects by kind, and refuses two contributors with one kind', async () => {
    const { DB } = await internals();
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: ana.id };
    expect(await api.exportPersonalData({ subject, tenantId, db })).toEqual({
      documents: [],
      files: [],
      jobs: [],
      // The framework's parties feature: Ana is no party's member.
      parties: [],
      // The framework's push feature: Ana registered no device.
      pushDevices: [],
      fixtureNotes: [{ about: subject }],
    });
    api.exportContributors.register({
      name: 'fixture.other',
      export: async () => ({ fixtureNotes: [] }),
    });
    await expect(api.exportPersonalData({ subject, db })).rejects.toThrow(
      'Both fixture.runtime.export and fixture.other export "fixtureNotes"',
    );
  });
});
