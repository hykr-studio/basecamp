// Web push (W1): a person's browsers register their push subscriptions for the business, and a
// notification that lists `webpush` (or `push`, which tries phones, then browsers) reaches each
// of them, encrypted for it (RFC 8291) and signed with the deployment's VAPID key. A stand-in
// push service on localhost (WEB_PUSH_ALLOWED_HOSTS) plays the browsers' push services; Mailpit
// takes the email fallback; the real queues run inline.
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
// @ts-expect-error: http_ece has no types.
import ece from 'http_ece';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  boot,
  eventually,
  me,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { webPushApp } from '../fixture/dist/features/webpush/index.js';

process.env.SECRETS_KEY ||= 'test-secrets-key-0123456789abcdef0123456789';

/** What the stand-in Expo push service received: one message per phone. */
const toPhones: { to: string; title: string; data: Record<string, string> }[] = [];
let expo: Server;

/** What the stand-in push service received: one POST per browser. */
type Received = { path: string; headers: IncomingHttpHeaders; body: Buffer };
const received: Received[] = [];
let stub: Server;
let base = '';

/** A browser: its keys (the push service never has them) and its subscription. */
type Browser = {
  name: string;
  ecdh: ReturnType<typeof createECDH>;
  auth: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
};
function browser(name: string): Browser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return {
    name,
    ecdh,
    auth,
    subscription: {
      endpoint: `${base}/push/${name}-${stamp}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth },
    },
  };
}
/** What a browser reads: the message decrypted with its own keys. */
const open = (b: Browser, m: Received) =>
  JSON.parse(
    (
      ece.decrypt(m.body, {
        version: 'aes128gcm',
        privateKey: b.ecdh,
        authSecret: b.auth,
      }) as Buffer
    ).toString('utf8'),
  ) as { title: string; body: string; url?: string; notification: string };
const to = (b: Browser) => received.filter((m) => m.path === `/push/${b.name}-${stamp}`);

const owner = new Person('Olu Webpush');
const staff = new Person('Sam Webpush');
const admin = new Person('Adi Webpush');
const cara = new Person('Cara Webpush');
const gil = new Person('Gil Webpush');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const register = (who: Person, b: Browser, headers: Record<string, string> = {}) =>
  who.call('POST', '/api/push/tokens', { platform: 'web', subscription: b.subscription }, headers);
/** The person is using the app in this browser (or on this phone) now. */
const activeIn = (who: Person, device: Browser | string, headers: Record<string, string> = {}) =>
  who.call(
    'POST',
    '/api/push/tokens/active',
    typeof device === 'string' ? { token: device } : { endpoint: device.subscription.endpoint },
    headers,
  );
const chore = async (who: Person, body: object, headers: Record<string, string> = {}) =>
  (await who.call('POST', '/api/chores', body, headers)).body as {
    value: { id: string };
    undo?: { id: string };
  };
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { Subject: string }[] }).messages.map((m) => m.Subject);
}
const ticketsOf = async (userId: string) =>
  (
    await pool.query(
      `select platform, status, error, notification from channel.push_tickets
        where user_id = $1 order by created_at`,
      [userId],
    )
  ).rows as { platform: string; status: string; error: string | null; notification: string }[];
const subscriptions = async (userId: string) =>
  (
    await pool.query(
      'select endpoint, p256dh, auth, user_agent from channel.web_push_subscriptions where user_id = $1',
      [userId],
    )
  ).rows as { endpoint: string; p256dh: string; auth: string; user_agent: string | null }[];

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url?.includes('gone')) return void res.writeHead(410).end();
    if (req.url?.includes('busy')) return void res.writeHead(429).end();
    res.writeHead(201).end();
  });
  await new Promise<void>((r) => stub.listen(0, r));
  base = `http://localhost:${(stub.address() as { port: number }).port}`;
  // Phones, for the one-place cases: every message accepted, every receipt fine.
  expo = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(
      (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'),
    );
    const reply = (v: unknown) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.url?.endsWith('/push/send')) {
      toPhones.push(...body);
      return reply({ data: body.map((_: unknown, i: number) => ({ status: 'ok', id: `r${i}` })) });
    }
    reply({ data: {} });
  });
  await new Promise<void>((r) => expo.listen(0, r));
  process.env.EXPO_BASE_URL = `http://localhost:${(expo.address() as { port: number }).port}`;
  // The deployment's VAPID pair, read when used.
  const vapid = createECDH('prime256v1');
  vapid.generateKeys();
  process.env.WEB_PUSH_PUBLIC_KEY = vapid.getPublicKey().toString('base64url');
  process.env.WEB_PUSH_PRIVATE_KEY = vapid.getPrivateKey().toString('base64url');
  process.env.WEB_PUSH_SUBJECT = 'mailto:ops@example.com';
  process.env.WEB_PUSH_ALLOWED_HOSTS = 'localhost';
  await boot(webPushApp);
  for (const p of [owner, staff, admin, cara, gil]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
  // Never quiet, so the tests don't depend on the hour they run at.
  await setTenantSettings(tenantId, { quietHours: { from: '00:00', to: '00:00' } });
  await setTenantSettings((await me(cara)).tenantId, {
    quietHours: { from: '00:00', to: '00:00' },
  });
  await setTenantSettings((await me(gil)).tenantId, { quietHours: { from: '00:00', to: '00:00' } });
});
afterAll(async () => {
  stub.close();
  expo.close();
  await shutdown();
});

describe('keys and browsers', () => {
  it('anyone reads the public key', async () => {
    const res = await new Person('Nobody').call('GET', '/api/push/web/key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: process.env.WEB_PUSH_PUBLIC_KEY });
  });

  it('a browser registers; its keys are sealed and its User-Agent shortened', async () => {
    const b = browser('olu-mac');
    const res = await register(owner, b, { 'user-agent': CHROME_MAC });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ platform: 'web', browser: 'Chrome on macOS' });
    expect(res.body.token).toMatch(/^localhost:\d+\/olu-ma…$/);
    const [row] = await subscriptions(owner.id);
    expect(row.user_agent).toBe('Chrome on macOS');
    expect(row.p256dh).not.toContain(b.subscription.keys.p256dh);
    expect(row.auth).not.toContain(b.auth);
    expect(row.p256dh).toMatch(/^v1\./);
    const listed = (await owner.call('GET', '/api/push/tokens')).body as { platform: string }[];
    expect(listed.map((d) => d.platform)).toEqual(['web']);
  });

  it('an endpoint on an unknown host, or over http, is refused', async () => {
    const b = browser('bad');
    for (const endpoint of [
      'https://push.example.com/send/abc',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    ]) {
      const res = await owner.call('POST', '/api/push/tokens', {
        platform: 'web',
        subscription: { ...b.subscription, endpoint },
      });
      expect(res.status, endpoint).toBe(400);
      expect(res.body.error).toBe('bad_endpoint');
    }
    // A known push service is fine.
    const ok = await owner.call('POST', '/api/push/tokens', {
      platform: 'web',
      subscription: {
        ...b.subscription,
        endpoint: `https://fcm.googleapis.com/fcm/send/x-${stamp}`,
      },
    });
    expect(ok.status).toBe(201);
    await owner.call('POST', '/api/push/tokens/forget', {
      endpoint: `https://fcm.googleapis.com/fcm/send/x-${stamp}`,
    });
  });

  it('a subscription held by someone else moves to the new person', async () => {
    const b = browser('shared');
    expect((await register(cara, b)).status).toBe(201);
    expect((await register(gil, b)).status).toBe(201);
    expect(await subscriptions(cara.id)).toEqual([]);
    expect(await subscriptions(gil.id)).toHaveLength(1);
    // Forgetting needs no session.
    const res = await new Person('Anon').call('POST', '/api/push/tokens/forget', {
      endpoint: b.subscription.endpoint,
    });
    expect(res.status).toBe(204);
    expect(await subscriptions(gil.id)).toEqual([]);
  });
});

describe('the webpush channel', () => {
  it('reaches the one browser the person is on, encrypted, with the push words', async () => {
    const one = browser('sam-chrome');
    const two = browser('sam-firefox');
    expect((await register(staff, one, inTenant())).status).toBe(201);
    expect((await register(staff, two, inTenant())).status).toBe(201);
    // Sam works in Chrome; Firefox signed in later but is not where Sam is.
    expect((await activeIn(staff, one, inTenant())).status).toBe(204);
    const made = await chore(staff, { title: 'Web tiles', dueOn: '2030-05-06' }, inTenant());
    await eventually(() => (to(one).length ? true : undefined));
    expect(to(one)).toHaveLength(1);
    const [m] = to(one);
    // Encrypted for the browser: the push service reads none of it.
    expect(m.headers['content-encoding']).toBe('aes128gcm');
    expect(m.body.toString('utf8')).not.toContain('Web tiles');
    expect(m.headers.ttl).toBe('86400');
    expect(m.headers.urgency).toBe('normal');
    expect(String(m.headers.authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    // Without the browser's keys it does not open.
    expect(() => open(browser('other'), m)).toThrow();
    expect(open(one, m)).toEqual({
      title: 'Chore: Web tiles',
      // The due date is hidden from staff: their push never names it.
      body: 'Web tiles is due some day.',
      url: `/chores/${made.value.id}`,
      notification: 'chore.webpushed',
    });
    // The ticket is written from the push service's answer, just after the message lands.
    expect(
      await eventually(async () => {
        const tickets = await ticketsOf(staff.id);
        return tickets.length ? tickets : undefined;
      }),
    ).toEqual([{ platform: 'web', status: 'ok', error: null, notification: 'chore.webpushed' }]);
    // One place: the other browser stays quiet.
    await new Promise((r) => setTimeout(r, 500));
    expect(to(two)).toEqual([]);
    expect(await mailTo(staff.email)).not.toContain('Chore: Web tiles');
  });

  it('the owner of the business reads the due date', async () => {
    const b = browser('olu-due');
    await register(owner, b);
    await chore(owner, { title: 'Web grout', dueOn: '2030-05-06' });
    await eventually(() => (to(b).length ? true : undefined));
    expect(open(b, to(b)[0]).body).toBe('Web grout is due 2030-05-06.');
  });

  it('no browser: email at once', async () => {
    await chore(cara, { title: 'Web nobrowser' });
    await eventually(async () =>
      (await mailTo(cara.email)).includes('Chore: Web nobrowser') ? 1 : 0,
    );
  });

  it('the browser it chose is gone (410): forgotten, and the next browser gets it at once', async () => {
    const fine = browser('gil-fine');
    const gone = browser('gil-gone');
    await register(gil, fine);
    // Signed in last: where Gil was seen most recently, so tried first.
    await register(gil, gone);
    await chore(gil, { title: 'Web first' });
    await eventually(() => (to(fine).length ? true : undefined));
    expect(to(gone)).toHaveLength(1);
    expect((await subscriptions(gil.id)).map((r) => r.endpoint)).toEqual([
      fine.subscription.endpoint,
    ]);
    await chore(gil, { title: 'Web second' });
    await eventually(() => (to(fine).length === 2 ? true : undefined));
    expect(to(gone)).toHaveLength(1);
    // A browser took each: no email.
    expect(await mailTo(gil.email)).not.toContain('Chore: Web first');
  });

  it('every browser gone: email at once', async () => {
    const p = new Person('Hal Webpush');
    await p.signUp();
    await setTenantSettings((await me(p)).tenantId, { quietHours: { from: '00:00', to: '00:00' } });
    await register(p, browser('hal-gone'));
    await chore(p, { title: 'Web allgone' });
    await eventually(async () => ((await mailTo(p.email)).includes('Chore: Web allgone') ? 1 : 0));
    expect(await subscriptions(p.id)).toEqual([]);
  });

  it('a 429 is tried again, then the next channel', async () => {
    const p = new Person('Ivy Webpush');
    await p.signUp();
    await setTenantSettings((await me(p)).tenantId, { quietHours: { from: '00:00', to: '00:00' } });
    const busy = browser('ivy-busy');
    await register(p, busy);
    await chore(p, { title: 'Web busy' });
    await eventually(() => (to(busy).length ? true : undefined));
    // Not email yet: the push service may take it later.
    expect(await mailTo(p.email)).not.toContain('Chore: Web busy');
    await eventually(
      async () => ((await mailTo(p.email)).includes('Chore: Web busy') ? 1 : 0),
      40_000,
    );
    expect(to(busy)).toHaveLength(3);
    // A busy browser is kept.
    expect(await subscriptions(p.id)).toHaveLength(1);
  }, 60_000);

  it('without VAPID settings the channel is unavailable: email at once', async () => {
    const saved = process.env.WEB_PUSH_PRIVATE_KEY;
    const p = new Person('Jo Webpush');
    await p.signUp();
    await setTenantSettings((await me(p)).tenantId, { quietHours: { from: '00:00', to: '00:00' } });
    await register(p, browser('jo'));
    delete process.env.WEB_PUSH_PRIVATE_KEY;
    try {
      expect((await new Person('Nobody').call('GET', '/api/push/web/key')).body).toEqual({
        publicKey: null,
      });
      await chore(p, { title: 'Web nokeys' });
      await eventually(async () => ((await mailTo(p.email)).includes('Chore: Web nokeys') ? 1 : 0));
      expect(to(browser('jo'))).toEqual([]);
      // Nor can a browser register.
      const res = await register(p, browser('jo2'));
      expect(res.status).toBe(503);
    } finally {
      process.env.WEB_PUSH_PRIVATE_KEY = saved;
    }
  });
});

describe('push, the shorthand', () => {
  it('no phone: the browsers get it', async () => {
    const b = browser('olu-both');
    await register(owner, b);
    await chore(owner, { title: 'Both tiles' });
    await eventually(() => (to(b).length ? true : undefined));
    expect(open(b, to(b)[0])).toMatchObject({
      title: 'Chore: Both tiles',
      notification: 'chore.bothpushed',
    });
  });

  it("an approval request reaches the decider's browser, urgently", async () => {
    const b = browser('adi-approvals');
    expect((await register(admin, b, inTenant())).status).toBe(201);
    const made = await chore(owner, { title: 'Review me' });
    const asked = await owner.call('PATCH', `/api/chores/${made.value.id}`, {
      title: 'Review me [review]',
    });
    expect(asked.body.status).toBe('needs_approval');
    await eventually(() => (to(b).length ? true : undefined));
    const [m] = to(b);
    expect(m.headers.urgency).toBe('high');
    expect(open(b, m)).toMatchObject({
      notification: 'approval.request',
      url: `/approvals/${asked.body.approval.id}`,
    });
  });
});

describe('the dispatcher’s rules hold', () => {
  const dispatch = () =>
    server.app?.get(getQueueToken('notify-dispatch'), { strict: false }) as Queue;

  it('quiet hours move a web push later', async () => {
    const p = new Person('Kai Webpush');
    await p.signUp();
    const tenant = (await me(p)).tenantId;
    const b = browser('kai');
    await register(p, b);
    await setTenantSettings(tenant, { quietHours: { from: '00:00', to: '23:59' } });
    const made = await chore(p, { title: 'Web quiet' });
    const { NotifyService } = await import('../../dist/channels/notify/notify.service.js');
    const notify = server.app?.get(NotifyService);
    const dedupe = `chore.webpushed:${made.value.id}`;
    const at = await eventually(() => notify?.scheduledFor(dedupe));
    expect(to(b)).toEqual([]);
    // Quiet hours end: it goes.
    await setTenantSettings(tenant, { quietHours: { from: '00:00', to: '00:00' } });
    const job = await eventually(() => dispatch().getJob(`${dedupe}@${at}`.replaceAll(':', '_')));
    await job.promote();
    await eventually(() => (to(b).length ? true : undefined));
    expect(open(b, to(b)[0]).title).toBe('Chore: Web quiet');
  });

  it('an undone write sends nothing; one not undone sends when its window ends', async () => {
    const b = browser('olu-undo');
    await register(owner, b);
    const kept = await chore(owner, { title: 'Undo kept' });
    const undone = await chore(owner, { title: 'Undo me' });
    const doneKept = await owner.call('PATCH', `/api/chores/${kept.value.id}`, { done: true });
    const doneUndone = await owner.call('PATCH', `/api/chores/${undone.value.id}`, { done: true });
    expect(doneUndone.body.undo?.id).toBeTruthy();
    expect(doneKept.body.undo?.id).toBeTruthy();
    expect((await owner.call('POST', `/api/undo/${doneUndone.body.undo.id}`)).status).toBe(200);
    // Both windows end now.
    await pool.query(
      `update app.domain_events set available_at = now() where resource_id = any($1)`,
      [[kept.value.id, undone.value.id]],
    );
    await eventually(
      () => (to(b).some((m) => open(b, m).title === 'Done: Undo kept') ? true : undefined),
      15_000,
    );
    // A moment more for the undone one, which must not come.
    await new Promise((r) => setTimeout(r, 1500));
    expect(to(b).map((m) => open(b, m).title)).not.toContain('Done: Undo me');
  });
});

describe('one place: the device the person is on', () => {
  const phone = (name: string) => `ExponentPushToken[${name}-${stamp}]`;
  const onPhone = (t: string) => toPhones.filter((m) => m.to === t);

  it('push goes to the phone or the browser, whichever the person used last; never both', async () => {
    const p = new Person('Lea Webpush');
    await p.signUp();
    await setTenantSettings((await me(p)).tenantId, { quietHours: { from: '00:00', to: '00:00' } });
    const laptop = browser('lea-laptop');
    const mobile = phone('lea');
    expect((await register(p, laptop)).status).toBe(201);
    expect(
      (await p.call('POST', '/api/push/tokens', { token: mobile, platform: 'ios' })).status,
    ).toBe(201);

    // Nobody said where: the device seen last (the phone, signed in after the laptop).
    await chore(p, { title: 'Both first' });
    await eventually(() => (onPhone(mobile).length ? true : undefined));
    expect(to(laptop)).toEqual([]);

    // Lea works at the laptop now.
    expect((await activeIn(p, laptop)).status).toBe(204);
    await chore(p, { title: 'Both second' });
    await eventually(() => (to(laptop).length ? true : undefined));
    expect(open(laptop, to(laptop)[0]).title).toBe('Chore: Both second');
    expect(onPhone(mobile)).toHaveLength(1);

    // And picks up the phone again.
    expect((await activeIn(p, mobile)).status).toBe(204);
    await chore(p, { title: 'Both third' });
    await eventually(() => (onPhone(mobile).length === 2 ? true : undefined));
    expect(onPhone(mobile)[1].title).toBe('Chore: Both third');
    await new Promise((r) => setTimeout(r, 500));
    expect(to(laptop)).toHaveLength(1);
  });

  it("saying where only moves one's own device; it needs a session", async () => {
    const p = new Person('Max Webpush');
    await p.signUp();
    const b = browser('max');
    await register(p, b);
    // Someone else naming Max's browser changes nothing, and learns nothing.
    expect((await activeIn(cara, b)).status).toBe(204);
    const row = async () =>
      (
        await pool.query(
          'select active_at from channel.web_push_subscriptions where endpoint = $1',
          [b.subscription.endpoint],
        )
      ).rows[0] as { active_at: Date | null };
    expect((await row()).active_at).toBeNull();
    expect((await activeIn(p, b)).status).toBe(204);
    expect((await row()).active_at).not.toBeNull();
    const anon = await new Person('Nobody').call('POST', '/api/push/tokens/active', {
      endpoint: b.subscription.endpoint,
    });
    expect(anon.status).toBe(401);
  });
});

describe('personal data', () => {
  it('erasing a person deletes their browsers; export lists them, the endpoint masked', async () => {
    const { DB } = await import('../../dist/infra/db.module.js');
    const { PushErasure, PushExport } = await import('../../dist/features/push/index.js');
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: staff.id };
    const exported = await PushExport.export({ subject, db });
    const browsers = exported.pushBrowsers as { endpoint: string; browser: string | null }[];
    expect(browsers).toHaveLength(2);
    expect(browsers[0].endpoint).toMatch(/^localhost:\d+\/sam-..…$/);
    expect(JSON.stringify(exported)).not.toContain(`sam-chrome-${stamp}`);
    const { count } = await db.transaction((tx: never) => PushErasure.erase({ subject, tx }));
    // Two browsers and the one send (to the browser Sam was on).
    expect(count).toBe(3);
    expect(await subscriptions(staff.id)).toEqual([]);
    expect(await ticketsOf(staff.id)).toEqual([]);
  });
});
