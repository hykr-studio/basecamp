// Share links that last and are sent (B23): a link with no end where the declaration says
// `lasting` and the business allows it (still open a year on, ended at once by revoke); renew
// keeps the address; reissue makes a new one like it; a lasting form link's hourly limits and
// trap field; the framework sends a link to its recipient on WhatsApp (the template's URL button
// carrying the token) or by email, once, its token sealed on the send and wiped after, never in
// an event, an audit row, a message log or the assistant's answers; the assistant's draft waits
// for approval; a business's verified domain in the address an email or plain message carries.
// The fixture's inquiries (fixture/src/features/share).
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  type Res,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { InquiryLinkTemplate, shareApp } from '../fixture/dist/features/share/index.js';

const owner = new Person('Owner Lasting');
let tenantId = '';
const NUMBER = `pn-share-${Date.now()}`;
const DOMAIN = `https://studio-${Date.now()}.example.com`;
const APP_URL = process.env.APP_URL ?? '';
let seq = 0;
const phone = () => `9177${String(Date.now()).slice(-6)}${seq++ % 10}`;

/* ── A stand-in WhatsApp Cloud API ─────────────────────────────────────────── */

type Sent = {
  to: string;
  type?: string;
  text?: { body: string };
  template?: { name: string; components: Json[] };
};
const sent: Sent[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n);
let stub: Server;

/** A call with no session: what someone holding a link has. */
async function guest(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const open = (token: string) => guest('GET', `/api/share/${token}`);
const submit = (token: string, values: Json, extra: Json = { hp: '' }) =>
  guest('POST', `/api/share/${token}/submit`, { values, ...extra });

const share = (body: object) => owner.call('POST', '/api/shares', body);
async function made(body: object) {
  const res = await share(body);
  expect(res.status).toBe(201);
  return res.body.value as Json;
}
const inquiry = async (name: string) => {
  const res = await owner.call('POST', '/api/inquiries', { name });
  expect(res.status).toBe(201);
  return res.body.value as Json;
};
const sendRow = async (linkId: string) =>
  eventually(async () => {
    const { rows } = await pool.query(
      `select * from app.share_sends where link_id = $1 and status in ('sent', 'failed')`,
      [linkId],
    );
    return rows[0];
  });

/** Mailpit's messages to one address, with their text. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return Promise.all(
    messages.map(async (m) => {
      const one = await fetch(`http://localhost:8025/api/v1/message/${m.ID}`);
      return { ...m, Text: ((await one.json()) as { Text: string }).Text };
    }),
  );
}

/** Rows of these tables whose text holds this string. */
async function holding(text: string) {
  const out: Record<string, number> = {};
  for (const [name, sql] of [
    [
      'audit',
      `select count(*) from audit.events where tenant_id = $1 and position($2 in coalesce(before::text, '') || coalesce(after::text, '')) > 0`,
    ],
    [
      'events',
      `select count(*) from app.domain_events where tenant_id = $1 and position($2 in row::text) > 0`,
    ],
    [
      'messages',
      `select count(*) from channel.messages where tenant_id = $1 and position($2 in coalesce(body::text, '') || coalesce(meta::text, '')) > 0`,
    ],
    [
      'approvals',
      `select count(*) from app.approvals where tenant_id = $1 and position($2 in coalesce(payload::text, '') || coalesce(summary, '')) > 0`,
    ],
    [
      'idempotency',
      `select count(*) from app.idempotency where position($2 in response::text) > 0 and $1 = $1`,
    ],
  ] as const)
    out[name] = Number((await pool.query(sql, [tenantId, text])).rows[0].count);
  return out;
}
const none = { audit: 0, events: 0, messages: 0, approvals: 0, idempotency: 0 };

async function approve(name: string, lang: string, status: string) {
  await pool.query(
    `insert into channel.templates (name, language, category, content_hash, status)
     values ($1, $2, 'utility', 'test', $3)
     on conflict (name, language) do update set status = excluded.status`,
    [name, lang, status],
  );
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'GET') return json({ data: [] });
      sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Sent);
      json({ messages: [{ id: `wamid.share.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = 'test-app-secret';
  await boot(shareApp);
  await owner.signUp();
  tenantId = (await me(owner)).tenantId;
  expect(
    (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await approve(InquiryLinkTemplate.name, 'en', 'APPROVED');
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

/* ── Links without an end ──────────────────────────────────────────────────── */

describe('a link with no end', () => {
  it('is refused too_long unless the business allows it and the declaration is lasting', async () => {
    const i = await inquiry('Lasting');
    const refused = await share({ target: { entity: 'inquiry', id: i.id }, expiresInDays: null });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('too_long');
    await setTenantSettings(tenantId, { shares: { allowLasting: true } });
    // An inquiry form is not lasting: its links end.
    const form = await share({ target: { form: 'inquiries.inquiry' }, expiresInDays: null });
    expect(form.status).toBe(403);
    expect(form.body.rule).toBe('too_long');
    const kinds = await owner.call('GET', '/api/shares/kinds');
    expect(kinds.body.allowLasting).toBe(true);
    expect(kinds.body.entities.find((e: Json) => e.entity === 'inquiry').lasting).toBe(true);
  });

  it('still opens a year later; revoked, it ends at once', async () => {
    const i = await inquiry('A year on');
    const lasting = await made({ target: { entity: 'inquiry', id: i.id }, expiresInDays: null });
    const ending = await made({ target: { entity: 'inquiry', id: i.id }, expiresInDays: 7 });
    expect(lasting.expiresAt).toBeNull();
    expect(lasting.status).toBe('active');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 400 * 24 * 60 * 60 * 1000 });
    try {
      expect((await open(lasting.token)).status).toBe(200);
      const ended = await open(ending.token);
      expect(ended.status).toBe(410);
      expect(ended.body.error).toBe('link_expired');
    } finally {
      vi.useRealTimers();
    }
    const list = await owner.call('GET', `/api/shares?entity=inquiry&id=${i.id}`);
    expect(list.body.items.find((l: Json) => l.id === lasting.id).expiresAt).toBeNull();
    await owner.call('POST', `/api/shares/${lasting.id}/revoke`);
    expect((await open(lasting.token)).body.error).toBe('link_revoked');
  });
});

/* ── Renew and reissue ─────────────────────────────────────────────────────── */

describe('renewing and reissuing', () => {
  it('renew moves the end and keeps the address; audited; a revoked link is not renewed', async () => {
    const i = await inquiry('Renewed');
    const link = await made({ target: { entity: 'inquiry', id: i.id }, expiresInDays: 2 });
    const renewed = await owner.call('POST', `/api/shares/${link.id}/renew`, { expiresInDays: 30 });
    expect(renewed.status).toBe(200);
    const days = (Date.parse(renewed.body.value.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect((await open(link.token)).status).toBe(200);
    const forever = await owner.call('POST', `/api/shares/${link.id}/renew`, {
      expiresInDays: null,
    });
    expect(forever.body.value.expiresAt).toBeNull();
    const { rows } = await pool.query(
      `select count(*) from audit.events where tenant_id = $1 and action = 'share.renew' and resource_id = $2`,
      [tenantId, link.id],
    );
    expect(Number(rows[0].count)).toBe(2);
    await owner.call('POST', `/api/shares/${link.id}/revoke`);
    const again = await owner.call('POST', `/api/shares/${link.id}/renew`, { expiresInDays: 5 });
    expect(again.status).toBe(403);
    expect(again.body.rule).toBe('link_revoked');
  });

  it('reissue ends the old link and makes a new token with the same settings', async () => {
    const i = await inquiry('Reissued');
    const old = await made({
      target: { entity: 'inquiry', id: i.id },
      expiresInDays: 10,
      label: 'For the client',
    });
    const res = await owner.call('POST', `/api/shares/${old.id}/reissue`, {});
    expect(res.status).toBe(201);
    const fresh = res.body.value as Json;
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.label).toBe('For the client');
    expect(fresh.url).toBe(`${APP_URL}/share/${fresh.token}`);
    expect(Math.round((Date.parse(fresh.expiresAt) - Date.now()) / 86_400_000)).toBe(10);
    expect((await open(old.token)).body.error).toBe('link_revoked');
    expect((await open(fresh.token)).status).toBe(200);
  });
});

/* ── A lasting form link ───────────────────────────────────────────────────── */

describe('a lasting form link', () => {
  it('takes 5 answers an hour from one address, then 429; its trap must come back empty', async () => {
    const link = await made({ target: { form: 'inquiries.website' }, expiresInDays: null });
    const filled = await submit(link.token, { name: 'Bot' }, { hp: 'http://spam.example' });
    expect(filled.status).toBe(400);
    expect(filled.body.error).toBe('spam_suspected');
    expect((await submit(link.token, { name: 'Bot' }, {})).body.error).toBe('spam_suspected');
    for (let n = 1; n <= 5; n++)
      expect((await submit(link.token, { name: `P${n}` })).status).toBe(201);
    const sixth = await submit(link.token, { name: 'P6' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too_many_answers');
  });

  it('takes 20 answers an hour from the link, then 429', async () => {
    const link = await made({ target: { form: 'inquiries.busy' }, expiresInDays: null });
    for (let n = 1; n <= 20; n++)
      expect((await submit(link.token, { name: `B${n}` })).status).toBe(201);
    expect((await submit(link.token, { name: 'B23' })).status).toBe(429);
  });

  it('a form link that ends asks for no trap (as before)', async () => {
    const link = await made({ target: { form: 'inquiries.website' }, expiresInDays: 3 });
    expect((await submit(link.token, { name: 'Plain' }, {})).status).toBe(201);
  });
});

/* ── Sending a link ────────────────────────────────────────────────────────── */

describe('sending a link', () => {
  it('on WhatsApp: the template with the token in its URL button, once; logs keep no token', async () => {
    const number = phone();
    const asha = await seedContact(tenantId, 'Asha Rao', number);
    const i = await inquiry('Rao residence');
    const link = await made({
      target: { entity: 'inquiry', id: i.id },
      to: { contactId: asha.contactId },
      expiresInDays: null,
      send: {},
    });
    expect(link.sends).toHaveLength(1);
    expect(link.sends[0].status).toBe('queued');
    const row = await sendRow(link.id);
    expect(row).toMatchObject({ status: 'sent', channel: 'whatsapp', token_sealed: null });
    const [message] = await eventually(() =>
      toNumber(number).length ? toNumber(number) : undefined,
    );
    expect(message.template?.name).toBe(InquiryLinkTemplate.name);
    expect(message.template?.components).toContainEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: link.token }],
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(toNumber(number)).toHaveLength(1);
    await eventually(async () => ((await holding(link.token)).messages === 0 ? true : undefined));
    expect(await holding(link.token)).toEqual(none);
    const list = await owner.call('GET', `/api/shares?entity=inquiry&id=${i.id}`);
    const sends = list.body.items.find((l: Json) => l.id === link.id).sends;
    expect(sends[0]).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    expect(sends[0].sentTo).not.toBe(number);
    const events = await pool.query(
      `select name from app.domain_events where tenant_id = $1 and resource_id = $2 order by seq`,
      [tenantId, row.id],
    );
    expect(events.rows.map((e) => e.name)).toEqual(['share.send_requested', 'share.sent']);
  });

  it('by email when WhatsApp cannot take it, on the business’s verified domain', async () => {
    await pool.query(
      `insert into app.tenant_domains (tenant_id, origin, token, verified_at, created_by)
       values ($1, $2, 'tok', now(), $3)`,
      [tenantId, DOMAIN, owner.id],
    );
    const email = `client-${Date.now()}@test.local`;
    const i = await inquiry('By email');
    const link = await made({ target: { entity: 'inquiry', id: i.id }, to: { email }, send: {} });
    expect(link.url).toBe(`${DOMAIN}/share/${link.token}`);
    expect(await sendRow(link.id)).toMatchObject({ status: 'sent', channel: 'email' });
    const [mail] = await eventually(async () => {
      const m = await mailTo(email);
      return m.length ? m : undefined;
    });
    expect(mail.Text).toContain(`${DOMAIN}/share/${link.token}`);
    expect(await holding(link.token)).toEqual(none);
  });

  it('inside the 24-hour window without a template: a plain message on the domain', async () => {
    const number = phone();
    const ravi = await seedContact(tenantId, 'Ravi', number);
    await pool.query(
      `insert into channel.messages (tenant_id, contact_id, channel, direction, kind, status)
       values ($1, $2, 'whatsapp', 'in', 'text', 'received')`,
      [tenantId, ravi.contactId],
    );
    const link = await made({
      target: { form: 'inquiries.inquiry' },
      to: { contactId: ravi.contactId },
      send: { channel: 'whatsapp' },
    });
    expect(await sendRow(link.id)).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    const [message] = await eventually(() =>
      toNumber(number).length ? toNumber(number) : undefined,
    );
    expect(message.text?.body).toContain(`${DOMAIN}/share/${link.token}`);
    await eventually(async () => ((await holding(link.token)).messages === 0 ? true : undefined));
  });

  it('a link with no recipient cannot be sent (no_recipient)', async () => {
    const res = await share({ target: { form: 'inquiries.inquiry' }, send: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_recipient');
  });

  it('reissue sends the new link', async () => {
    const email = `again-${Date.now()}@test.local`;
    const i = await inquiry('Lost phone');
    const old = await made({ target: { entity: 'inquiry', id: i.id }, to: { email } });
    const res = await owner.call('POST', `/api/shares/${old.id}/reissue`, { send: {} });
    expect(res.status).toBe(201);
    expect(await sendRow(res.body.value.id)).toMatchObject({ status: 'sent', channel: 'email' });
    const [mail] = await eventually(async () => {
      const m = await mailTo(email);
      return m.length ? m : undefined;
    });
    expect(mail.Text).toContain(res.body.value.token);
    expect(mail.Text).not.toContain(old.token);
  });
});

describe('a send leaves at most once', () => {
  type Sender = { send(id: string, t: { by: string; lastTry: boolean }): Promise<string> };
  let sender: Sender;
  let linkId = '';
  beforeAll(async () => {
    const { ShareSender } = await import('../../dist/features/share/sender.js');
    if (!server.app) throw new Error('The app is not booted');
    sender = server.app.get(ShareSender, { strict: false }) as Sender;
    const i = await inquiry('Once');
    linkId = (
      await made({ target: { entity: 'inquiry', id: i.id }, to: { email: 'x@test.local' } })
    ).id;
  });

  async function rowOf(extra: Json) {
    const cols = Object.keys(extra);
    const { rows } = await pool.query(
      `insert into app.share_sends (tenant_id, link_id, recipient${cols.map((c) => `, ${c}`).join('')})
       values ($1, $2, $3${cols.map((_, n) => `, $${n + 4}`).join('')}) returning id`,
      [tenantId, linkId, JSON.stringify({ email: 'x@test.local' }), ...Object.values(extra)],
    );
    return rows[0].id as string;
  }

  it('a worker stopped mid-send leaves it failed, interrupted: never sent twice', async () => {
    const id = await rowOf({ status: 'sending', claimed_by: 'job-x', claimed_at: new Date() });
    expect(await sender.send(id, { by: 'job-y', lastTry: false })).toBe('claimed by another job');
    expect(await sender.send(id, { by: 'job-x', lastTry: false })).toBe('failed: interrupted');
    const stale = await rowOf({
      status: 'sending',
      claimed_by: 'job-x',
      claimed_at: new Date(Date.now() - 10 * 60_000),
    });
    expect(await sender.send(stale, { by: 'job-z', lastTry: false })).toBe('failed: interrupted');
  });

  it('two jobs at once: one sends, the other does nothing; no sealed token: failed', async () => {
    const id = await rowOf({});
    const outcomes = await Promise.all([
      sender.send(id, { by: 'job-a', lastTry: true }),
      sender.send(id, { by: 'job-b', lastTry: true }),
    ]);
    // A row made by hand has no sealed token: whichever claims it fails it, once.
    expect(outcomes.filter((o) => o === 'failed: token_unavailable')).toHaveLength(1);
  });
});

/* ── The assistant ─────────────────────────────────────────────────────────── */

describe('the assistant', () => {
  const agent = () => asAssistant(`user:${owner.id}`);

  it('cannot make a plain link (people only)', async () => {
    const i = await inquiry('Plain');
    const res = await agent()('POST', '/api/shares', { target: { entity: 'inquiry', id: i.id } });
    expect(res.status).toBe(403);
  });

  it('drafts a link and its send: it waits; approved, the link is made and sent', async () => {
    const email = `drafted-${Date.now()}@test.local`;
    const i = await inquiry('Mrs Rao');
    const parked = await agent()('POST', '/api/shares/drafts', {
      target: { entity: 'inquiry', id: i.id },
      to: { email },
      channel: 'email',
    });
    expect(parked.status).toBe(201);
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval.summary).toBe(
      `Send a link to inquiry "Mrs Rao" to ${email} on email`,
    );
    const before = await pool.query('select count(*) from app.share_links where tenant_id = $1', [
      tenantId,
    ]);
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    expect(JSON.stringify(approved.body)).not.toMatch(/\/share\//);
    const after = await pool.query('select count(*) from app.share_links where tenant_id = $1', [
      tenantId,
    ]);
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count) + 1);
    const [mail] = await eventually(async () => {
      const m = await mailTo(email);
      return m.length ? m : undefined;
    });
    const token = /\/share\/([A-Za-z0-9_-]{43})/.exec(mail.Text)?.[1] ?? '';
    expect(token).not.toBe('');
    expect((await open(token)).status).toBe(200);
    expect(await holding(token)).toEqual(none);
  });

  it('rejected, nothing is made', async () => {
    const i = await inquiry('Not now');
    const parked = await agent()('POST', '/api/shares/drafts', {
      target: { entity: 'inquiry', id: i.id },
      to: { email: 'no@test.local' },
    });
    const count = async () =>
      Number(
        (
          await pool.query(
            `select count(*) from app.share_links where tenant_id = $1 and resource_id = $2`,
            [tenantId, i.id],
          )
        ).rows[0].count,
      );
    await owner.call('POST', `/api/approvals/${parked.body.approval.id}/reject`);
    expect(await count()).toBe(0);
  });

  it('the scripted model drafts it and says what is waiting, never the link', async () => {
    const i = await inquiry('Scripted');
    const nobody = await owner.chat(`send the inquiry ${i.id} link to its customer`);
    // No customer on it: nobody to send it to, said by the engine from the refusal.
    expect(nobody.body.reply).toMatch(/no recipient/);
    const meera = await seedContact(tenantId, 'Meera', phone());
    await pool.query('update app.fixture_inquiries set customer_id = $2 where id = $1', [
      i.id,
      meera.customerId,
    ]);
    const said = await owner.chat(`send the inquiry ${i.id} link to its customer`);
    expect(said.body.reply).toContain('Send a link to inquiry "Scripted" to Meera');
    expect(said.body.reply).not.toMatch(/\/share\//);
  });
});
