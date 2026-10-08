// Notifications: scheduled from what happens to records, sent as approved templates, moved
// to email when WhatsApp can't be used or fails for good. A stand-in Cloud API, Mailpit for
// email, the real queues (inline).
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { contentHash, templates } from '@app/notifications';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
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

type Sent = { to: string; type?: string; template?: { name: string; language: { code: string } } };
const sent: Sent[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n && s.type);
/** Numbers the stand-in refuses: "not on WhatsApp" (permanent), or one 429 then fine. */
const notOnWhatsApp = new Set<string>();
const throttledOnce = new Set<string>();
const attempts = new Map<string, number>();

let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-ntf-${Date.now()}`;
const ana = new Person('Ana Notify');
const ravi = new Person('Ravi Notify');
let tenantId = '';
let seq = 0;
const phone = () => `9177${String(Date.now()).slice(-6)}${seq++ % 10}`;

const dispatch = () =>
  server.app?.get(getQueueToken('notify-dispatch'), { strict: false }) as Queue;
/** When the app has a notification scheduled for (null: not scheduled). */
const latest = async (dedupe: string): Promise<string | null> => {
  // Imported late: the app's config must see the stand-in's URL first.
  const { NotifyService } = await import('../../dist/channels/notify/notify.service.js');
  return server.app?.get(NotifyService).scheduledFor(dedupe);
};
const jobFor = async (dedupe: string) => {
  const at = await latest(dedupe);
  return at ? dispatch().getJob(`${dedupe}@${at}`.replaceAll(':', '_')) : undefined;
};
/** Run a scheduled notification now, instead of waiting for its time. */
const fire = async (dedupe: string) => {
  const job = await eventually(() => jobFor(dedupe));
  await job.promote();
};

/** Mailpit's messages to one address. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const body = (await res.json()) as { messages: { Subject: string }[] };
  return body.messages;
}

async function newMeeting(
  call: (
    m: string,
    p: string,
    b?: unknown,
  ) => Promise<{ body: { id: string } & Record<string, unknown> }>,
  title: string,
  inMinutes = 120,
) {
  const startsAt = new Date(Date.now() + inMinutes * 60_000);
  const res = await call('POST', '/api/meetings', {
    title,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
  });
  return res.body.value as { id: string; startsAt: string };
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
      const body = JSON.parse(data) as Sent;
      if (body.type) attempts.set(body.to, (attempts.get(body.to) ?? 0) + 1);
      if (body.type && notOnWhatsApp.has(body.to)) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } }));
        return;
      }
      if (body.type && throttledOnce.delete(body.to)) {
        res
          .writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
          .end(JSON.stringify({ error: { code: 130429, message: 'Rate limit hit' } }));
        return;
      }
      sent.push(body);
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
  await ravi.signUp();
  tenantId = (await me(ana)).tenantId;
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  // Never quiet, so the tests don't depend on the hour they run at.
  await pool.query(
    `update app.tenants set settings = settings || '{"quietHours":{"from":"00:00","to":"00:00"}}' where id = $1`,
    [tenantId],
  );
  // Every template approved, as templates:sync leaves them once Meta has reviewed them.
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

/** A contact for Ana's own number, linked to her account (one number per person). */
async function linkAna(address: string) {
  await pool.query('update channel.contacts set user_id = null where user_id = $1', [ana.id]);
  const c = await seedContact(tenantId, 'Ana', address);
  await pool.query('update channel.contacts set user_id = $1, linked_at = now() where id = $2', [
    ana.id,
    c.contactId,
  ]);
  return c;
}

describe('notifications', () => {
  it('a meeting schedules its reminder; a reschedule moves it; deleting cancels it', async () => {
    const meeting = await newMeeting(ana.call.bind(ana), 'Tile review');
    const dedupe = `meeting.reminder:${meeting.id}`;
    const first = await eventually(() => jobFor(dedupe));
    const startsAt = new Date(meeting.startsAt as string).getTime();
    expect(first.timestamp + (first.opts.delay ?? 0)).toBeCloseTo(startsAt - 30 * 60_000, -4);

    const later = new Date(startsAt + 60 * 60_000);
    await ana.call('POST', `/api/meetings/${meeting.id}/reschedule`, {
      startsAt: later.toISOString(),
      endsAt: new Date(later.getTime() + 30 * 60_000).toISOString(),
    });
    const moved = await eventually(async () => {
      const j = await jobFor(dedupe);
      return j && j.id !== first.id ? j : undefined;
    });
    expect(moved.timestamp + (moved.opts.delay ?? 0)).toBeCloseTo(
      later.getTime() - 30 * 60_000,
      -4,
    );
    // The first one is gone, not left to fire.
    expect(await dispatch().getJob(first.id ?? '')).toBeUndefined();

    await ana.call('DELETE', `/api/meetings/${meeting.id}`);
    await eventually(async () => ((await latest(dedupe)) === null ? true : undefined));
    expect(await dispatch().getJob(moved.id ?? '')).toBeUndefined();
  });

  it("a customer's reminder goes as a template on WhatsApp; the owner's by email", async () => {
    const address = phone();
    const customer = await seedContact(tenantId, 'Kavya', address);
    const meeting = await newMeeting(asAssistant(`contact:${customer.contactId}`), 'Kitchen visit');
    await fire(`meeting.reminder:${meeting.id}`);

    const [template] = await eventually(() =>
      toNumber(address).length ? toNumber(address) : undefined,
    );
    expect(template.type).toBe('template');
    expect(template.template?.name).toBe('meeting_reminder_v1');
    // Ana has no WhatsApp linked: her reminder is an email.
    const mail = await eventually(async () => {
      const m = await mailTo(ana.email);
      return m.find((x) => x.Subject.includes('Kitchen visit'));
    });
    expect(mail.Subject).toBe('Reminder: Kitchen visit');
  });

  it('Snooze on the reminder schedules it again in 15 minutes', async () => {
    const address = phone();
    const customer = await seedContact(tenantId, 'Meena', address);
    const meeting = await newMeeting(asAssistant(`contact:${customer.contactId}`), 'Snag list');
    const dedupe = `meeting.reminder:${meeting.id}`;
    await fire(dedupe);
    await eventually(() => (toNumber(address).length ? true : undefined));

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
                    from: address,
                    id: `m-snooze-${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'button',
                    button: { payload: 'ntf:meeting.reminder:snooze_15', text: 'Snooze 15 min' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    await fetch(`${server.base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    const reply = await eventually(() =>
      (toNumber(address) as (Sent & { text?: { body: string } })[]).find((s) =>
        s.text?.body.includes('15 minutes'),
      ),
    );
    expect(reply.text?.body).toMatch(/remind you again in 15 minutes/);
    const at = await latest(dedupe);
    expect(new Date(at ?? 0).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it('after STOP for reminders, the reminder goes by email instead', async () => {
    const address = phone();
    const { contactId } = await linkAna(address);
    await pool.query(
      `insert into channel.consents (contact_id, topic, granted, source) values ($1, 'reminders', false, 'test')`,
      [contactId],
    );
    const meeting = await newMeeting(ana.call.bind(ana), 'Plumber call');
    await fire(`meeting.reminder:${meeting.id}`);
    await eventually(async () =>
      (await mailTo(ana.email)).find((m) => m.Subject.includes('Plumber call')),
    );
    expect(toNumber(address)).toEqual([]);
  });

  it('a template not approved in any language goes by email', async () => {
    await pool.query(
      `update channel.templates set status = 'REJECTED' where name = 'meeting_reminder_v1'`,
    );
    try {
      const address = phone();
      await linkAna(address);
      const meeting = await newMeeting(ana.call.bind(ana), 'Electrician');
      await fire(`meeting.reminder:${meeting.id}`);
      await eventually(async () =>
        (await mailTo(ana.email)).find((m) => m.Subject.includes('Electrician')),
      );
      expect(toNumber(address)).toEqual([]);
    } finally {
      await pool.query(
        `update channel.templates set status = 'APPROVED' where name = 'meeting_reminder_v1'`,
      );
    }
  });

  it('a number not on WhatsApp fails once, without retries: email, and marked unreachable', async () => {
    const address = phone();
    notOnWhatsApp.add(address);
    const { contactId } = await linkAna(address);
    const meeting = await newMeeting(ana.call.bind(ana), 'Painter');
    await fire(`meeting.reminder:${meeting.id}`);
    await eventually(async () =>
      (await mailTo(ana.email)).find((m) => m.Subject.includes('Painter')),
    );
    expect(attempts.get(address)).toBe(1);
    const { rows } = await pool.query(
      'select unreachable_at is not null as unreachable from channel.contacts where id = $1',
      [contactId],
    );
    expect(rows).toEqual([{ unreachable: true }]);
  });

  it('a 429 is retried, and the template arrives', async () => {
    const address = phone();
    throttledOnce.add(address);
    const customer = await seedContact(tenantId, 'Arjun', address);
    const meeting = await newMeeting(asAssistant(`contact:${customer.contactId}`), 'Carpenter');
    await fire(`meeting.reminder:${meeting.id}`);
    await eventually(() => (toNumber(address).length ? true : undefined), 15_000);
    expect(attempts.get(address)).toBe(2);
  });

  it('staff send a customer a service template; marketing waits for approval; customers cannot', async () => {
    const address = phone();
    const customer = await seedContact(tenantId, 'Divya', address);
    const send = asAssistant(`user:${ana.id}`, { 'x-channel': 'app' });
    const ok = await send('POST', '/api/notify/send', {
      customerId: customer.customerId,
      template: 'todo_due_v1',
      params: { title: 'Pay the deposit' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('done');
    const [msg] = await eventually(() =>
      toNumber(address).length ? toNumber(address) : undefined,
    );
    expect(msg.template?.name).toBe('todo_due_v1');

    const marketing = await send('POST', '/api/notify/send', {
      customerId: customer.customerId,
      template: 'monthly_update_v1',
      params: Object.fromEntries(
        Object.keys(templates.find((t) => t.name === 'monthly_update_v1')?.params.shape ?? {}).map(
          (k) => [k, 'x'],
        ),
      ),
    });
    expect(marketing.body.status).toBe('needs_approval');

    const asCustomer = await asAssistant(`contact:${customer.contactId}`)(
      'POST',
      '/api/notify/send',
      {
        customerId: customer.customerId,
        template: 'todo_due_v1',
        params: { title: 'x' },
      },
    );
    expect(asCustomer.status).toBe(403);
    // Someone from another business can't reach this customer at all.
    const other = await ravi.call('POST', '/api/notify/send', {
      customerId: customer.customerId,
      template: 'todo_due_v1',
      params: { title: 'x' },
    });
    expect(other.status).toBe(404);
  });
});
