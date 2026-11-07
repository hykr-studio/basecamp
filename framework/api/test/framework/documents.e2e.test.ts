// Documents (B2): a record's PDF made from data read as the person who asks, drawn in the worker
// and stored as a file the document holds; reached only through the record by someone who sees at
// least what its requester saw (another business, a hidden field: 404); sent by email with the PDF
// attached, or on WhatsApp as a template with a document header (or a document message inside the
// 24-hour window), at most once even when two jobs run it; a document's sends shown in full only
// to whoever sends to others; the assistant's send to someone else waits for approval. The fixture's `memos`
// (fixture/src/features/documents). The fake engine draws (vitest.config.ts): plain text lines.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { CoreOptions } from '@hykr/core';
import { CORE_OPTIONS } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The API's entry is loaded in beforeAll, once the stand-in's address is in the environment.
type Api = typeof import('../../dist/index.js');
let api: Api;

import {
  addMember,
  asAssistant,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  seedContact,
  server,
  shutdown,
} from '../../dist/testing.js';
import { documentsApp, MemoDocumentTemplate } from '../fixture/dist/features/documents/index.js';

const owner = new Person('Owner Docs');
const staff = new Person('Staff Docs');
const reader = new Person('Reader Docs');
const stranger = new Person('Stranger Docs');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === owner || p === stranger ? {} : inTenant());

/** A provider of the booted app. */
const provider = <T>(token: unknown): T => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(token as string, { strict: false }) as T;
};
const service = () => provider<InstanceType<Api['DocumentsService']>>(api.DocumentsService);

/* ── A stand-in WhatsApp Cloud API: media uploads and messages ─────────────── */

type Sent = {
  to: string;
  type?: string;
  template?: { name: string; language: { code: string }; components: Json[] };
  document?: { id?: string; filename?: string; caption?: string };
};
const sent: Sent[] = [];
const uploads: { id: string; body: string }[] = [];
const toNumber = (n: string) => sent.filter((s) => s.to === n);
let stub: Server;
const NUMBER = `pn-docs-${Date.now()}`;
let seq = 0;
const phone = () => `9188${String(Date.now()).slice(-6)}${seq++ % 10}`;

beforeAll(async () => {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET') return json({ data: [] });
      const body = Buffer.concat(chunks).toString('latin1');
      if (path.endsWith('/media')) {
        const id = `media-${uploads.length + 1}`;
        uploads.push({ id, body });
        return json({ id });
      }
      sent.push(JSON.parse(body) as Sent);
      json({ messages: [{ id: `wamid.docs.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = 'test-app-secret';
  api = await import('../../dist/index.js');
  await boot(documentsApp);
  for (const p of [owner, staff, reader, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(reader, tenantId, ['fixture_reader']);
  expect(
    (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
  await approve(MemoDocumentTemplate.name, 'en', 'APPROVED');
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

/** As if the provider had reviewed the template in this language. */
async function approve(name: string, lang: string, status: string) {
  await pool.query(
    `insert into channel.templates (name, language, category, content_hash, status)
     values ($1, $2, 'utility', 'test', $3)
     on conflict (name, language) do update set status = excluded.status`,
    [name, lang, status],
  );
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const memo = async (p: Person, body: object) => {
  const res = await p.call('POST', '/api/memos', body, as(p));
  expect(res.status).toBe(201);
  return res.body.value as { id: string; title: string };
};
const render = (p: Person, document: string, id: string, lang?: string) =>
  p.call('POST', '/api/documents', { document, id, ...(lang ? { lang } : {}) }, as(p));
const getDoc = (p: Person, id: string) => p.call('GET', `/api/documents/${id}`, undefined, as(p));

/** Render, and wait until it is made. */
async function made(p: Person, document: string, id: string) {
  const res = await render(p, document, id);
  expect(res.status).toBe(200);
  return ready(p, res.body.value.id);
}
const ready = (p: Person, id: string) =>
  eventually(async () => {
    const got = await getDoc(p, id);
    return got.body?.status === 'ready' ? got.body : undefined;
  });

/** The PDF behind a document's URL. */
async function pdf(url: string) {
  const res = await fetch(url.startsWith('/') ? `${server.base}${url}` : url);
  expect(res.status).toBe(200);
  return { type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

const send = (p: Person, documentId: string, body: object) =>
  p.call('POST', `/api/documents/${documentId}/send`, body, as(p));
const sendDone = (p: Person, docId: string, sendId: string) =>
  eventually(async () => {
    const got = await getDoc(p, docId);
    const s = (got.body?.sends ?? []).find((x: { id: string }) => x.id === sendId);
    return s && (s.status === 'sent' || s.status === 'failed') ? s : undefined;
  });

/** Mailpit's messages to one address, and their attachments. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}
async function attachments(id: string) {
  const res = await fetch(`http://localhost:8025/api/v1/message/${id}`);
  return ((await res.json()) as { Attachments: { FileName: string; ContentType: string }[] })
    .Attachments;
}

const audit = async (resourceId: string) =>
  (
    await pool.query(
      'select action, outcome, rule, actor_kind from audit.events where resource_id = $1 order by at',
      [resourceId],
    )
  ).rows as { action: string; outcome: string; rule: string | null; actor_kind: string }[];

let plan: { id: string; title: string };
let ownerCopy: Json;

/* ── Making and reading ────────────────────────────────────────────────────── */

describe('making a document', () => {
  it('pending, then ready: stored as a file the document holds, served through it', async () => {
    plan = await memo(owner, { title: 'Plan', body: 'Pour on Monday', secret: 'S3cret' });
    const asked = await render(owner, 'memos.memo', plan.id);
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({
      status: 'done',
      value: {
        document: 'memos.memo',
        record: { entity: 'memo', id: plan.id },
        version: 1,
        lang: 'en',
        status: 'pending',
        name: 'memo-Plan.pdf',
        createdBy: 'person',
        size: null,
      },
    });
    ownerCopy = await ready(owner, asked.body.value.id);
    expect(ownerCopy).toMatchObject({ status: 'ready', pages: 1, mime: 'application/pdf' });
    expect(ownerCopy.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerCopy.url).toBeTruthy();

    const { type, bytes } = await pdf(ownerCopy.url);
    expect(type).toBe('application/pdf');
    const text = bytes.toString('utf8');
    expect(text.startsWith('%PDF-')).toBe(true);
    for (const words of ['PLAN', 'Pour on Monday', 'Secret: S3cret', 'Page {page} of {pages}'])
      expect(text).toContain(words);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ownerCopy.sha256);
    expect(ownerCopy.size).toBe(bytes.length);

    // The file is the document's: the files routes do not serve it.
    const { rows } = await pool.query(
      `select f.id, f.resource_type, f.resource_id, f.source, f.status
         from app.documents d join app.files f on f.id = d.file_id where d.id = $1`,
      [ownerCopy.id],
    );
    expect(rows[0]).toMatchObject({
      resource_type: 'platform.document',
      resource_id: ownerCopy.id,
      source: 'server',
      status: 'ready',
    });
    expect((await owner.call('GET', `/api/files/${rows[0].id}`)).status).toBe(404);

    // Audited, and stored as events that never carry what the document shows.
    const actions = (await audit(ownerCopy.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['document.create', 'document.rendered']));
    const events = await pool.query(
      'select name, row from app.domain_events where resource_id = $1 order by occurred_at',
      [ownerCopy.id],
    );
    expect(events.rows.map((e) => e.name)).toEqual(['document.requested', 'document.rendered']);
    for (const e of events.rows) {
      expect(e.row).not.toHaveProperty('data');
      expect(JSON.stringify(e.row)).not.toContain('S3cret');
    }
  });

  it('each render is a new version; a record lists its documents, newest first; kinds', async () => {
    const again = await made(owner, 'memos.memo', plan.id);
    expect(again.version).toBe(2);
    const list = await owner.call('GET', `/api/documents?entity=memo&id=${plan.id}`);
    expect(list.body.items.map((d: Json) => [d.document, d.version])).toEqual([
      ['memos.memo', 2],
      ['memos.memo', 1],
    ]);
    const kinds = await owner.call('GET', '/api/documents/kinds?entity=memo');
    expect(kinds.body.items.map((k: Json) => [k.name, k.channels])).toEqual([
      ['memos.memo', ['whatsapp', 'email']],
      ['memos.sheet', []],
      ['memos.card', ['email']],
    ]);
    expect((await owner.call('GET', '/api/documents')).status).toBe(400);
  });

  it('in another language: its words come through ctx (dates in the business’s language)', async () => {
    const asked = await render(owner, 'memos.memo', plan.id, 'hi');
    expect(asked.body.value.lang).toBe('hi');
    const doc = await ready(owner, asked.body.value.id);
    const text = (await pdf(doc.url)).bytes.toString('utf8');
    expect(text).toMatch(
      /Written: .*(जनवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्तूबर|नवंबर|दिसंबर)/,
    );
  });
});

describe('who reaches a document', () => {
  it('another business: 404 on making, reading and sending; its list is empty', async () => {
    expect((await render(stranger, 'memos.memo', plan.id)).status).toBe(404);
    expect((await getDoc(stranger, ownerCopy.id)).status).toBe(404);
    expect((await send(stranger, ownerCopy.id, { to: { self: true } })).status).toBe(404);
    const list = await stranger.call('GET', `/api/documents?entity=memo&id=${plan.id}`);
    expect(list.body.items).toEqual([]);
    expect((await render(owner, 'memos.nothing', plan.id)).status).toBe(404);
  });

  it('a field hidden from staff stays out of their copy, and they never open the owner’s', async () => {
    // The read projector hides the secret line from staff on the record itself.
    const record = await staff.call('GET', `/api/memos/${plan.id}`, undefined, inTenant());
    expect(record.status).toBe(200);
    expect(record.body.title).toBe('Plan');
    expect(record.body).not.toHaveProperty('secret');
    const theirs = await made(staff, 'memos.memo', plan.id);
    const text = (await pdf(theirs.url)).bytes.toString('utf8');
    expect(text).toContain('PLAN');
    expect(text).not.toContain('S3cret');
    // The owner's copy shows the secret: 404 for staff, and left out of their list.
    expect((await getDoc(staff, ownerCopy.id)).status).toBe(404);
    const list = await staff.call(
      'GET',
      `/api/documents?entity=memo&id=${plan.id}`,
      undefined,
      inTenant(),
    );
    expect(list.body.items.map((d: Json) => d.id)).toEqual([theirs.id]);
    // Without `capabilities`, every role counts: the owner (not staff) cannot open staff's copy.
    expect((await getDoc(owner, theirs.id)).status).toBe(404);
  });

  it('a definition names the capability that matters (sheet), or none (card)', async () => {
    const ownersSheet = await made(owner, 'memos.sheet', plan.id);
    expect((await pdf(ownersSheet.url)).bytes.toString('utf8')).toContain('Secret: S3cret');
    expect((await getDoc(staff, ownersSheet.id)).status).toBe(404);
    const staffSheet = await made(staff, 'memos.sheet', plan.id);
    expect((await getDoc(owner, staffSheet.id)).status).toBe(200);
    expect((await getDoc(reader, staffSheet.id)).status).toBe(200);

    const card = await made(owner, 'memos.card', plan.id);
    for (const p of [staff, reader]) expect((await getDoc(p, card.id)).status).toBe(200);
    const text = (await pdf(card.url)).bytes.toString('utf8');
    expect(text).toContain('Group | ');
    expect(text).toContain('  One line | 1');
  });

  it('the assistant makes and reads documents, never with a link', async () => {
    const agent = asAssistant(`user:${owner.id}`);
    const asked = await agent('POST', '/api/documents', { document: 'memos.memo', id: plan.id });
    expect(asked.status).toBe(200);
    expect(asked.body.value).toMatchObject({ status: 'pending', createdBy: 'assistant' });
    await ready(owner, asked.body.value.id);
    const got = await agent('GET', `/api/documents/${asked.body.value.id}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('ready');
    expect(got.body.url).toBeUndefined();
    // Another business's assistant reaches nothing.
    const theirs = asAssistant(`user:${stranger.id}`);
    expect((await theirs('GET', `/api/documents/${asked.body.value.id}`)).status).toBe(404);
  });

  it('through the scripted model: make a PDF of a memo, then ask whether it is ready', async () => {
    const said = await owner.chat('pdf of memo Plan');
    const id = /document ([0-9a-f-]{36})/.exec(said.body.reply)?.[1];
    expect(said.body.reply).toMatch(/^Making memo-Plan\.pdf: document /);
    await ready(owner, id as string);
    expect((await owner.chat(`is document ${id} ready?`)).body.reply).toBe(
      '"memo-Plan.pdf" is ready: 1 page.',
    );
    expect((await stranger.chat(`is document ${id} ready?`)).body.reply).toBe(
      "I couldn't do that: No such document.",
    );
  });
});

/* ── Sending ───────────────────────────────────────────────────────────────── */

describe('sending a document', () => {
  let asha: { contactId: string; customerId: string };
  let ashaPhone = '';

  it('by email to yourself, the PDF attached', async () => {
    const res = await send(owner, ownerCopy.id, { to: { self: true } });
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({ status: 'queued', to: { userId: owner.id } });
    const done = await sendDone(owner, ownerCopy.id, res.body.value.id);
    expect(done).toMatchObject({ status: 'sent', channel: 'email', error: null });
    const mail = await eventually(async () =>
      (await mailTo(owner.email)).find((m) => m.Subject === 'Memo Plan'),
    );
    expect(await attachments(mail.ID)).toEqual([
      expect.objectContaining({ FileName: 'memo-Plan.pdf', ContentType: 'application/pdf' }),
    ]);
    expect((await audit(ownerCopy.id)).map((a) => a.action)).toContain('document.sent');
    // The send row is audited with the write that asked for it.
    expect(await audit(res.body.value.id)).toEqual([
      expect.objectContaining({ action: 'documentSend.create', outcome: 'committed' }),
    ]);
  });

  it('by WhatsApp to a customer: the PDF uploaded, then the template with a document header', async () => {
    ashaPhone = phone();
    asha = await seedContact(tenantId, 'Asha', ashaPhone);
    const res = await send(owner, ownerCopy.id, { to: { customerId: asha.customerId } });
    expect(res.status).toBe(200);
    const done = await sendDone(owner, ownerCopy.id, res.body.value.id);
    expect(done).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    const [message] = await eventually(() =>
      toNumber(ashaPhone).length ? toNumber(ashaPhone) : undefined,
    );
    const upload = uploads.at(-1);
    expect(upload?.body).toContain('application/pdf');
    expect(upload?.body).toContain('filename="memo-Plan.pdf"');
    expect(upload?.body).toContain('%PDF-');
    expect(message).toMatchObject({
      type: 'template',
      template: { name: 'memo_document_v1', language: { code: 'en' } },
    });
    expect(message.template?.components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'document', document: { id: upload?.id, filename: 'memo-Plan.pdf' } }],
    });
    expect(message.template?.components[1]).toMatchObject({
      type: 'body',
      parameters: [{ parameter_name: 'title', text: 'Plan' }],
    });
    const status = await eventually(async () => {
      const got = await getDoc(owner, ownerCopy.id);
      const s = got.body.sends.find((x: Json) => x.id === res.body.value.id);
      return s?.messageStatus ? s : undefined;
    });
    expect(status.messageStatus).toBe('sent');
  });

  it('inside the 24-hour window, without an approved template: a document message', async () => {
    await approve(MemoDocumentTemplate.name, 'en', 'PENDING');
    try {
      await pool.query(
        `insert into channel.messages (tenant_id, contact_id, channel, direction, kind, status)
         values ($1, $2, 'whatsapp', 'in', 'text', 'received')`,
        [tenantId, asha.contactId],
      );
      const before = toNumber(ashaPhone).length;
      const res = await send(owner, ownerCopy.id, { to: { contactId: asha.contactId } });
      await sendDone(owner, ownerCopy.id, res.body.value.id);
      const [message] = await eventually(() =>
        toNumber(ashaPhone).length > before ? toNumber(ashaPhone).slice(before) : undefined,
      );
      expect(message).toMatchObject({
        type: 'document',
        document: { filename: 'memo-Plan.pdf', caption: 'Here is the memo Plan.' },
      });
    } finally {
      await approve(MemoDocumentTemplate.name, 'en', 'APPROVED');
    }
  });

  it('WhatsApp unreachable: by email instead; nothing reachable: failed, unreachable', async () => {
    const ravi = await seedContact(tenantId, 'Ravi', phone());
    await pool.query('update channel.contacts set unreachable_at = now() where id = $1', [
      ravi.contactId,
    ]);
    const lost = await send(owner, ownerCopy.id, { to: { customerId: ravi.customerId } });
    expect(await sendDone(owner, ownerCopy.id, lost.body.value.id)).toMatchObject({
      status: 'failed',
      error: 'unreachable',
    });
    // The same customer, with an account: their email.
    await pool.query('update app.customers set user_id = $1 where id = $2', [
      staff.id,
      ravi.customerId,
    ]);
    const mailed = await send(owner, ownerCopy.id, { to: { customerId: ravi.customerId } });
    expect(await sendDone(owner, ownerCopy.id, mailed.body.value.id)).toMatchObject({
      status: 'sent',
      channel: 'email',
    });
    expect((await mailTo(staff.email)).map((m) => m.Subject)).toContain('Memo Plan');
  });

  it('a send before the document is made waits, then goes, once', async () => {
    const address = `cards-${Date.now()}@test.local`;
    const asked = await render(owner, 'memos.card', plan.id);
    const res = await send(owner, asked.body.value.id, { to: { email: address } });
    expect(res.status).toBe(200);
    expect(['waiting', 'queued']).toContain(res.body.value.status);
    expect(await sendDone(owner, asked.body.value.id, res.body.value.id)).toMatchObject({
      status: 'sent',
      channel: 'email',
    });
    const mail = await eventually(async () =>
      (await mailTo(address)).find((m) => m.Subject === 'Card Plan'),
    );
    expect((await attachments(mail.ID))[0].FileName).toBe('card-Plan.pdf');
    // Both its jobs (asked, and made) have had their turn: one email, one send recorded.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await mailTo(address)).toHaveLength(1);
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events
        where action = 'document.sent' and resource_id = $1 and after->>'send' = $2`,
      [asked.body.value.id, res.body.value.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('who may send to whom: yourself always; others need customers.message; channels and recipients checked', async () => {
    const readersCard = await made(reader, 'memos.card', plan.id);
    expect((await send(reader, readersCard.id, { to: { self: true } })).status).toBe(200);
    const refused = await send(reader, readersCard.id, { to: { customerId: asha.customerId } });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('cannot_send_to_others');
    expect((await audit(readersCard.id)).find((a) => a.outcome === 'denied')).toMatchObject({
      action: 'document.send',
      rule: 'cannot_send_to_others',
    });
    const wrongWay = await send(owner, readersCard.id, { to: { self: true }, channel: 'whatsapp' });
    expect(wrongWay.body.rule).toBe('channel_unavailable');
    const sheet = (
      await owner.call('GET', `/api/documents?entity=memo&id=${plan.id}`)
    ).body.items.find((d: Json) => d.document === 'memos.sheet');
    expect((await send(owner, sheet.id, { to: { self: true } })).body.rule).toBe('not_sendable');
    // A recipient of another business is no recipient.
    const theirs = await seedContact((await me(stranger)).tenantId, 'Theirs', phone());
    expect(
      (await send(owner, ownerCopy.id, { to: { customerId: theirs.customerId } })).status,
    ).toBe(404);
    expect((await send(owner, ownerCopy.id, { to: { userId: stranger.id } })).status).toBe(404);
  });

  it('the assistant’s send to someone else waits for approval, audited; approved, it goes', async () => {
    const agent = asAssistant(`user:${owner.id}`);
    const before = toNumber(ashaPhone).length;
    const parked = await agent('POST', `/api/documents/${ownerCopy.id}/send`, {
      to: { customerId: asha.customerId },
    });
    expect(parked.status).toBe(200);
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval.summary).toBe('Send memo-Plan.pdf to Asha');
    expect((await audit(ownerCopy.id)).find((a) => a.outcome === 'needs_approval')).toMatchObject({
      action: 'document.send',
      rule: 'agent_sends_document',
      actor_kind: 'agent',
    });
    expect(toNumber(ashaPhone).length).toBe(before);
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    await eventually(() => (toNumber(ashaPhone).length > before ? true : undefined));
  });

  it('the assistant sends to the person themself without asking (the scripted model)', async () => {
    const said = await owner.chat('send memo Plan to me');
    expect(said.body.reply).toBe('Sending memo Plan to you.');
    const docs = (await owner.call('GET', `/api/documents?entity=memo&id=${plan.id}`)).body.items;
    const newest = await ready(owner, docs[0].id);
    const s = await sendDone(owner, newest.id, newest.sends[0]?.id ?? '');
    expect(s).toMatchObject({ status: 'sent', channel: 'email', to: { userId: owner.id } });
  });
});

describe('who sees a document’s sends', () => {
  it('whoever sends to others sees every send; anyone else only their own, each projected', async () => {
    const address = `outside-${Date.now()}@test.local`;
    const card = await made(owner, 'memos.card', plan.id);
    const theirs = await send(owner, card.id, { to: { email: address } });
    await sendDone(owner, card.id, theirs.body.value.id);
    const mine = await send(reader, card.id, { to: { self: true } });
    expect(mine.status).toBe(200);
    // The send's own result is projected too: its error is for owners (the fixture's projector).
    expect(mine.body.value).not.toHaveProperty('error');
    await sendDone(reader, card.id, mine.body.value.id);

    // The reader (no customers.message) sees only the send that went to them.
    const read = await getDoc(reader, card.id);
    expect(read.status).toBe(200);
    expect(read.body.sends.map((x: Json) => x.id)).toEqual([mine.body.value.id]);
    expect(read.body.sends[0]).toMatchObject({ to: { userId: reader.id }, status: 'sent' });
    expect(read.body.sends[0]).not.toHaveProperty('error');
    expect(JSON.stringify(read.body)).not.toContain(address);

    // Staff (customers.message) see both, projected: no error without the secret capability.
    const staffs = await getDoc(staff, card.id);
    expect(staffs.body.sends.map((x: Json) => x.id).sort()).toEqual(
      [theirs.body.value.id, mine.body.value.id].sort(),
    );
    for (const x of staffs.body.sends) expect(x).not.toHaveProperty('error');
    // The owner sees both, with their errors.
    const owners = await getDoc(owner, card.id);
    expect(owners.body.sends).toHaveLength(2);
    expect(owners.body.sends.find((x: Json) => x.id === theirs.body.value.id)).toMatchObject({
      to: { email: address },
      error: null,
    });
  });
});

describe('a send leaves at most once', () => {
  type Sender = { send(id: string, t: { by: string; lastTry: boolean }): Promise<string> };
  let sender: Sender;
  let card: Json;
  beforeAll(async () => {
    const { DocumentSender } = await import('../../dist/features/documents/sender.js');
    sender = provider<Sender>(DocumentSender);
    card = await made(owner, 'memos.card', plan.id);
  });

  /** A send row with no job: the test runs the sender itself. */
  async function sendRow(documentId: string, recipient: object, extra: Json = {}) {
    const cols = Object.keys(extra);
    const names = cols.map((c) => `, ${c}`).join('');
    const params = cols.map((_, i) => `, $${i + 5}`).join('');
    const { rows } = await pool.query(
      `insert into app.document_sends (tenant_id, document_id, recipient, requested_by${names})
       values ($1, $2, $3, $4${params}) returning id`,
      [tenantId, documentId, JSON.stringify(recipient), owner.id, ...Object.values(extra)],
    );
    return rows[0].id as string;
  }
  const row = async (id: string) =>
    (await pool.query('select * from app.document_sends where id = $1', [id])).rows[0];

  it('two jobs at once on one queued send: one claims and emails it, the other does nothing', async () => {
    const address = `twice-${Date.now()}@test.local`;
    const id = await sendRow(card.id, { email: address });
    const outcomes = await Promise.all([
      sender.send(id, { by: 'job-a', lastTry: false }),
      sender.send(id, { by: 'job-b', lastTry: false }),
    ]);
    expect(outcomes.filter((o) => o === 'sent by email')).toHaveLength(1);
    expect(outcomes.find((o) => o !== 'sent by email')).toMatch(
      /^(claimed by another job|already sent)$/,
    );
    await eventually(async () => ((await mailTo(address)).length ? true : undefined));
    await new Promise((r) => setTimeout(r, 500));
    expect(await mailTo(address)).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: 'sent', channel: 'email', address });
    // A later try finds it sent.
    expect(await sender.send(id, { by: 'job-a', lastTry: true })).toBe('already sent');
  });

  it('two jobs at once on one WhatsApp send: one upload, one message', async () => {
    const number = phone();
    const ravi = await seedContact(tenantId, 'Ravi Once', number);
    const before = uploads.length;
    const id = await sendRow(ownerCopy.id, { customerId: ravi.customerId });
    const outcomes = await Promise.all([
      sender.send(id, { by: 'job-a', lastTry: false }),
      sender.send(id, { by: 'job-b', lastTry: false }),
    ]);
    expect(outcomes.filter((o) => o === 'sent by whatsapp')).toHaveLength(1);
    await eventually(() => (toNumber(number).length ? true : undefined));
    await new Promise((r) => setTimeout(r, 500));
    expect(toNumber(number)).toHaveLength(1);
    expect(uploads.length - before).toBe(1);
  });

  it('an error before anything left lets the claim go; on the last try the send fails', async () => {
    const { rows } = await pool.query(
      `insert into app.documents (tenant_id, name, resource_type, resource_id, version, status, data, seen_as, file_name, requested_by)
       values ($1, 'memos.card', 'memo', $2, 98, 'ready', $3, $4, 'no-file.pdf', $5) returning id`,
      [
        tenantId,
        plan.id,
        JSON.stringify({ business: { id: tenantId, name: 'x', timeZone: 'UTC' }, value: {} }),
        JSON.stringify({ roles: ['owner'], capabilities: [] }),
        owner.id,
      ],
    );
    const id = await sendRow(rows[0].id, { email: `nofile-${Date.now()}@test.local` });
    await expect(sender.send(id, { by: 'job-a', lastTry: false })).rejects.toThrow(
      'The document has no file',
    );
    expect(await row(id)).toMatchObject({ status: 'queued', claimed_by: null });
    expect(await sender.send(id, { by: 'job-a', lastTry: true })).toBe(
      'failed: The document has no file',
    );
    expect(await row(id)).toMatchObject({ status: 'failed', error: 'The document has no file' });
  });

  it('a send left sending: another job leaves it; the job that claimed it never sends it again', async () => {
    const address = `stopped-${Date.now()}@test.local`;
    const claim = { status: 'sending', claimed_by: 'job-x', claimed_at: new Date() };
    // Stopped part way with nothing recorded: failed, interrupted, and nothing sent.
    const stopped = await sendRow(card.id, { email: address }, claim);
    expect(await sender.send(stopped, { by: 'job-y', lastTry: true })).toBe(
      'claimed by another job',
    );
    expect((await row(stopped)).status).toBe('sending');
    expect(await sender.send(stopped, { by: 'job-x', lastTry: false })).toBe('failed: interrupted');
    // It left (its outcome was written) but was not finished: recorded as sent, not sent again.
    const left = await sendRow(
      card.id,
      { email: address },
      { ...claim, channel: 'email', address },
    );
    expect(await sender.send(left, { by: 'job-x', lastTry: false })).toBe('sent by email');
    expect(await row(left)).toMatchObject({ status: 'sent', address });
    // A claim gone stale: any job finishes it.
    const stale = await sendRow(
      card.id,
      { email: address },
      { ...claim, claimed_at: new Date(Date.now() - 10 * 60_000) },
    );
    expect(await sender.send(stale, { by: 'job-y', lastTry: false })).toBe('failed: interrupted');
    expect(await mailTo(address)).toHaveLength(0);
    const failed = (await audit(card.id)).filter((a) => a.action === 'document.send_failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });
});

describe('when a document cannot be made', () => {
  it('it fails on its last try, its waiting sends fail, and it cannot be sent', async () => {
    const { rows } = await pool.query(
      `insert into app.documents (tenant_id, name, resource_type, resource_id, version, data, seen_as, file_name, requested_by)
       values ($1, 'memos.memo', 'memo', $2, 99, $3, $4, 'broken.pdf', $5) returning id`,
      [
        tenantId,
        plan.id,
        JSON.stringify({ business: { id: tenantId, name: 'x', timeZone: 'UTC' }, value: null }),
        JSON.stringify({ roles: ['owner'], capabilities: [] }),
        owner.id,
      ],
    );
    const id = rows[0].id as string;
    await pool.query(
      `insert into app.document_sends (tenant_id, document_id, recipient, status) values ($1, $2, $3, 'waiting')`,
      [tenantId, id, JSON.stringify({ userId: owner.id })],
    );
    await expect(service().render(id, false)).rejects.toThrow();
    expect(await service().render(id, true)).toBe('failed');
    const got = await getDoc(owner, id);
    expect(got.body).toMatchObject({ status: 'failed', size: null });
    expect(got.body.error).toBeTruthy();
    expect(got.body.sends).toEqual([
      expect.objectContaining({ status: 'failed', error: 'document_failed' }),
    ]);
    expect((await send(owner, id, { to: { self: true } })).body.rule).toBe('document_failed');
    expect((await audit(id)).map((a) => a.action)).toContain('document.failed');
  });
});

describe('personal data', () => {
  it("a person's export lists the documents they asked for, without what they show", async () => {
    const { db } = provider<CoreOptions>(CORE_OPTIONS);
    const out = await api.exportPersonalData({ subject: { kind: 'user', userId: owner.id }, db });
    expect(out.documents).toContainEqual(
      expect.objectContaining({ id: ownerCopy.id, document: 'memos.memo', version: 1 }),
    );
    expect(JSON.stringify(out.documents)).not.toContain('S3cret');
  });
});

describe('declaring documents', () => {
  // Last: it adds a document to the process's registry.
  it('the start refuses a document whose template the application does not send', () => {
    const stray = api.defineDocument({
      ...api.documents.get('memos.memo'),
      name: 'memos.stray',
      send: {
        whatsapp: {
          template: { ...MemoDocumentTemplate, name: 'memo_stray_v1' },
          params: () => ({}),
        },
      },
    } as Parameters<Api['defineDocument']>[0]);
    api.documents.register(stray);
    expect(() => service().onApplicationBootstrap()).toThrow(
      /memo_stray_v1 is not one of the application's templates/,
    );
  });
});
