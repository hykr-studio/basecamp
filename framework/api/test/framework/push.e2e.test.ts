// Push notifications (A9): devices register for the person and business, a notification that
// lists push first reaches them through the push service, and falls back to email when there is
// no device, when the push service refuses, or when a receipt reports a failure later. A
// stand-in push service (EXPO_BASE_URL), Mailpit for email, the real queues (inline).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  server,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { pushApp } from '../fixture/dist/features/push/index.js';

type Message = { to: string; title: string; body: string; data: Record<string, string> };
const sent: Message[] = [];
/** Receipt ids whose receipt says the message failed. */
const failing = new Set<string>();
let stub: Server;
let n = 0;

/** A request's JSON body; the SDK gzips large ones. */
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  return JSON.parse(
    (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'),
  );
}

/** By the token: "gone" is not registered any more, "busy" is rate limited, the rest are fine. */
function ticketFor(m: Message) {
  if (m.to.includes('gone'))
    return { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } };
  if (m.to.includes('busy'))
    return { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } };
  const id = `rcpt-${m.to.slice(18, -1)}-${n++}`;
  if (m.to.includes('late')) failing.add(id);
  return { status: 'ok', id };
}

const token = (name: string) => `ExponentPushToken[${name}-${stamp}]`;
const ana = new Person('Ana Push');
const ravi = new Person('Ravi Push');
const cara = new Person('Cara Push');
const dev = new Person('Dev Push');
const eve = new Person('Eve Push');
const bo = new Person('Bo Push');

async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { Subject: string }[] }).messages.map((m) => m.Subject);
}
const task = async (who: Person, title: string) =>
  (await who.call('POST', '/api/tasks', { title })).body.value as { id: string };
const to = (t: string) => sent.filter((m) => m.to === t);
const register = (who: Person, t: string, platform = 'ios') =>
  who.call('POST', '/api/push/tokens', { token: t, platform });
const ticketsOf = async (userId: string) =>
  (
    await pool.query(
      'select status, error, notification from channel.push_tickets where user_id = $1 order by created_at',
      [userId],
    )
  ).rows as { status: string; error: string | null; notification: string }[];
const poll = async () => {
  const { PushService } = await import('../../dist/features/push/push.service.js');
  return server.app?.get(PushService, { strict: false }).pollReceipts();
};

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const body = (await bodyOf(req)) as Message[] | { ids: string[] };
    const reply = (value: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url?.endsWith('/push/send')) {
      const messages = body as Message[];
      sent.push(...messages);
      reply({ data: messages.map(ticketFor) });
      return;
    }
    if (req.url?.endsWith('/push/getReceipts')) {
      const { ids } = body as { ids: string[] };
      reply({
        data: Object.fromEntries(
          ids.map((id) => [
            id,
            failing.has(id)
              ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok' },
          ]),
        ),
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => stub.listen(0, r));
  // Read by the push SDK when it first loads (the first registration).
  process.env.EXPO_BASE_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.PUSH_RECEIPT_DELAY_MS = '0';
  await boot(pushApp);
  for (const p of [ana, ravi, cara, dev, eve, bo]) await p.signUp();
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

describe('devices', () => {
  it('registers an Expo push token for the person, in their business', async () => {
    expect((await register(ana, 'not-a-token')).status).toBe(400);
    expect((await register(ana, token('ana'), 'web')).status).toBe(400);
    const res = await register(ana, token('ana'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ platform: 'ios' });
    expect(res.body.token).not.toBe(token('ana'));
    expect(res.body.token.endsWith('…')).toBe(true);
    const mine = await ana.call('GET', '/api/push/tokens');
    expect(mine.body).toHaveLength(1);
    const { rows } = await pool.query(
      'select tenant_id, user_id from channel.push_tokens where token = $1',
      [token('ana')],
    );
    expect(rows).toEqual([{ tenant_id: (await me(ana)).tenantId, user_id: ana.id }]);
  });

  it('another business’s person never sees them; the assistant cannot register', async () => {
    expect((await ravi.call('GET', '/api/push/tokens')).body).toEqual([]);
    const agent = await asAssistant(`user:${ana.id}`)('POST', '/api/push/tokens', {
      token: token('agent'),
      platform: 'ios',
    });
    expect(agent.status).toBe(403);
    expect((await fetch(`${server.base}/api/push/tokens`)).status).toBe(401);
  });

  it('a device belongs to one person: registering it moves it', async () => {
    const shared = token('shared');
    await register(ana, shared, 'android');
    expect((await register(ravi, shared, 'android')).status).toBe(201);
    const { rows } = await pool.query('select user_id from channel.push_tokens where token = $1', [
      shared,
    ]);
    expect(rows).toEqual([{ user_id: ravi.id }]);
    expect((await ana.call('GET', '/api/push/tokens')).body).toHaveLength(1);
  });

  it('forgetting a device needs no session and says nothing about whether it existed', async () => {
    const forget = (t: string) =>
      fetch(`${server.base}/api/push/tokens/forget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
    expect((await forget(token('shared'))).status).toBe(204);
    expect((await forget(token('never-seen'))).status).toBe(204);
    expect((await ravi.call('GET', '/api/push/tokens')).body).toEqual([]);
  });
});

describe('the push channel', () => {
  it('reaches the person’s device with the notification’s title, body and link', async () => {
    await register(ravi, token('ravi'));
    const t = await task(ana, 'Push ok');
    const [m] = await eventually(() => (to(token('ana')).length ? to(token('ana')) : undefined));
    expect(m).toMatchObject({
      title: 'Task: Push ok',
      body: 'Push ok was added (en).',
      data: { url: '/tasks', notification: 'task.pushed' },
    });
    expect(to(token('ravi'))).toEqual([]);
    expect(await ticketsOf(ana.id)).toEqual([
      { status: 'pending', error: null, notification: 'task.pushed' },
    ]);
    expect(t.id).toBeTruthy();
  });

  it('no device: email at once', async () => {
    await task(cara, 'Push cara');
    await eventually(async () =>
      (await mailTo(cara.email)).includes('Pushed: Push cara') ? 1 : 0,
    );
  });

  it('the device is gone: the token is forgotten and email goes at once', async () => {
    await register(dev, token('dev-gone'));
    await task(dev, 'Push gone');
    await eventually(async () => ((await mailTo(dev.email)).includes('Pushed: Push gone') ? 1 : 0));
    expect((await dev.call('GET', '/api/push/tokens')).body).toEqual([]);
    expect(await ticketsOf(dev.id)).toEqual([
      { status: 'error', error: 'DeviceNotRegistered', notification: 'task.pushed' },
    ]);
  });

  it('refused for now: push is tried again, not email', async () => {
    await register(bo, token('bo-busy'));
    await task(bo, 'Push busy');
    await eventually(() => (to(token('bo-busy')).length >= 2 ? true : undefined), 20_000);
    expect(await mailTo(bo.email)).not.toContain('Pushed: Push busy');
  }, 30_000);

  it('a receipt that reports a failure moves the notification on; an ok one does not', async () => {
    await register(eve, token('eve-late'));
    await task(eve, 'Push late');
    await eventually(() => (to(token('eve-late')).length ? true : undefined));
    const polled = await poll();
    expect(polled?.fellBack).toBeGreaterThanOrEqual(1);
    await eventually(async () => ((await mailTo(eve.email)).includes('Pushed: Push late') ? 1 : 0));
    expect(await ticketsOf(eve.id)).toEqual([
      { status: 'error', error: 'DeviceNotRegistered', notification: 'task.pushed' },
    ]);
    expect((await eve.call('GET', '/api/push/tokens')).body).toEqual([]);
    // Ana's message was delivered: no email for it.
    expect((await ticketsOf(ana.id)).map((t) => t.status)).toEqual(['ok']);
    expect(await mailTo(ana.email)).not.toContain('Pushed: Push ok');
    // Nothing left to check.
    expect((await poll())?.checked).toBe(0);
  });
});

describe('personal data', () => {
  it('erasing a person deletes their devices and push log; export lists devices, shortened', async () => {
    const { DB } = await import('../../dist/infra/db.module.js');
    const { PushErasure, PushExport } = await import('../../dist/features/push/index.js');
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: ana.id };
    const exported = await PushExport.export({ subject, db });
    expect(exported.pushDevices).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain(token('ana'));
    const { count } = await db.transaction((tx: never) => PushErasure.erase({ subject, tx }));
    expect(count).toBe(2);
    expect((await ana.call('GET', '/api/push/tokens')).body).toEqual([]);
    expect(await ticketsOf(ana.id)).toEqual([]);
    // A contact has no devices.
    const none = await db.transaction((tx: never) =>
      PushErasure.erase({ subject: { kind: 'contact', contactId: 'c1' }, tx }),
    );
    expect(none.count).toBe(0);
  });
});
