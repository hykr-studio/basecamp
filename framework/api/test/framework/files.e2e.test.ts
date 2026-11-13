// Files and media (B1): uploads (presign, PUT, confirm), files kept on records' file fields and
// reached only through them (another business, a hidden field, someone else's upload: 404), the
// write path attaching and letting go of them (parked writes included), transcription, WhatsApp
// media kept for its sender, erasure and the sweeper. The fixture's `cards` entity has every kind
// of file field (fixture/src/features/files). Storage is the memory driver (vitest.config.ts).
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApiClient } from '@hykr/api-client';
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
  origin,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { filesApp } from '../fixture/dist/features/files/index.js';

const owner = new Person('Owner Files');
const staff = new Person('Staff Files');
const admin = new Person('Admin Files');
const stranger = new Person('Stranger Files');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === owner || p === stranger ? {} : inTenant());

/** A provider of the booted app. */
const provider = <T>(token: unknown): T => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(token as string, { strict: false }) as T;
};
const service = () => provider<InstanceType<Api['FilesService']>>(api.FilesService);

/* ── Bytes ─────────────────────────────────────────────────────────────────── */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A PNG's signature and header: enough for its type and size to be read. */
const png = (width = 640, height = 480) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    u32(13),
    Buffer.from('IHDR'),
    u32(width),
    u32(height),
    Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64, 7),
  ]);
const note = (words: string) => Buffer.from(`FAKE-STT:en:${words}`);

type For = { entity: string; field: string; id?: string };

/** Presign, PUT the bytes where it says, confirm. */
async function upload(
  person: Person,
  o: { name: string; mime: string; bytes: Buffer; for: For },
): Promise<{ id: string; pre: Json; put?: Response; confirmed?: Json }> {
  const pre = await person.call(
    'POST',
    '/api/files',
    { name: o.name, mime: o.mime, size: o.bytes.length, for: o.for },
    as(person),
  );
  if (pre.status !== 201) return { id: '', pre };
  const put = await fetch(`${server.base}${pre.body.upload.url}`, {
    method: 'PUT',
    headers: pre.body.upload.headers,
    body: new Uint8Array(o.bytes),
  });
  const confirmed = await person.call(
    'POST',
    `/api/files/${pre.body.file.id}/confirm`,
    undefined,
    as(person),
  );
  return { id: pre.body.file.id, pre, put, confirmed };
}
const photo = (person: Person, name = 'porch.png') =>
  upload(person, {
    name,
    mime: 'image/png',
    bytes: png(),
    for: { entity: 'card', field: 'photos' },
  });

const card = (person: Person, body: object) => person.call('POST', '/api/cards', body, as(person));

const fileRow = async (id: string) =>
  (await pool.query('select * from app.files where id = $1', [id])).rows[0] as
    | Record<string, unknown>
    | undefined;

const audit = async (resourceId: string) =>
  (
    await pool.query(
      'select action, outcome, rule, actor_kind, after from audit.events where resource_id = $1 order by at',
      [resourceId],
    )
  ).rows;

/* ── A stand-in WhatsApp Cloud API that serves media ───────────────────────── */

type Sent = { to: string; type?: string; text?: { body: string } };
const sent: Sent[] = [];
const textsTo = (n: string) => sent.filter((s) => s.to === n).flatMap((s) => s.text?.body ?? []);
const media = new Map<string, { bytes: Buffer; mime: string }>();
let stub: Server;
let stubUrl = '';
const secret = 'test-app-secret';
const NUMBER = `pn-files-${Date.now()}`;
let seq = 0;
const phone = () => `9177${String(Date.now()).slice(-6)}${seq++ % 10}`;

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
                  id: `m-files-${Date.now()}-${seq++}`,
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
const sendPhoto = (from: string, caption?: string) => {
  const id = `media-files-${Date.now()}-${seq++}`;
  media.set(id, { bytes: png(320, 200), mime: 'image/png' });
  return deliver(from, { type: 'image', image: { id, mime_type: 'image/png', caption } });
};

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET') {
        const file = /\/files\/(.+)$/.exec(path)?.[1];
        const held = file ? media.get(file) : undefined;
        if (file && held) {
          res.writeHead(200, { 'content-type': held.mime }).end(held.bytes);
          return;
        }
        const id = path.split('/').at(-1) ?? '';
        const meta = media.get(id);
        if (meta) {
          json({ url: `${stubUrl}/files/${id}`, mime_type: meta.mime });
          return;
        }
        json({ data: [] });
        return;
      }
      if (data) sent.push(JSON.parse(data) as Sent);
      json({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  stubUrl = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_GRAPH_URL = stubUrl;
  process.env.WA_APP_SECRET = secret;
  process.env.SARVAM_API_KEY = '';
  api = await import('../../dist/index.js');
  await boot(filesApp);
  for (const p of [owner, staff, admin, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
  expect(
    (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

describe('uploading and reaching a file', () => {
  it('presign, PUT, confirm, put on a card: reached through the card, with a URL that serves it', async () => {
    const up = await photo(owner);
    expect(up.pre.status).toBe(201);
    expect(up.pre.body.upload).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });
    expect(up.put?.status).toBe(200);
    expect(up.confirmed?.status).toBe(200);
    expect(up.confirmed?.body).toMatchObject({
      id: up.id,
      status: 'ready',
      width: 640,
      height: 480,
      attachedTo: null,
    });

    const made = await card(owner, { title: 'Porch', photos: [up.id] });
    expect(made.status).toBe(201);
    expect(made.body.value.photos).toEqual([up.id]);

    const got = await owner.call('GET', `/api/files/${up.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      name: 'porch.png',
      mime: 'image/png',
      attachedTo: { entity: 'card', id: made.body.value.id, field: 'photos' },
    });
    const served = await fetch(`${server.base}${got.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toMatch(/^inline; filename="porch.png"/);
    expect(Buffer.from(await served.arrayBuffer()).equals(png())).toBe(true);

    // A colleague who reads the card reaches its files too.
    expect((await staff.call('GET', `/api/files/${up.id}`, undefined, inTenant())).status).toBe(
      200,
    );
    const many = await owner.call('GET', `/api/files?ids=${up.id}`);
    expect(many.body.items.map((f: { id: string }) => f.id)).toEqual([up.id]);

    expect((await audit(up.id)).map((r) => r.action)).toEqual([
      'file.upload',
      'file.confirm',
      'file.attach',
    ]);
  });

  it('the API client uploads in one call and gives absolute URLs', async () => {
    const client = createApiClient({
      baseUrl: server.base,
      headers: () => ({ cookie: owner.cookie, origin }),
    });
    const file = await client.files.upload(new Blob([new Uint8Array(png(64, 32))]), {
      name: 'client.png',
      mime: 'image/png',
      for: { entity: 'card', field: 'cover' },
    });
    expect(file).toMatchObject({ status: 'ready', width: 64, height: 32 });
    expect(file.url?.startsWith(`${server.base}/api/files/blob/`)).toBe(true);
    expect((await fetch(file.url as string)).status).toBe(200);
    const [again] = await client.files.getMany([file.id]);
    expect(again.url?.startsWith(server.base)).toBe(true);
    await client.files.remove(file.id);
    await expect(client.files.get(file.id)).rejects.toMatchObject({ status: 404 });
  });

  it('a signed URL works for its own method, key and time only', async () => {
    const up = await photo(owner);
    const url: string = up.pre.body.upload.url;
    // Used again for another type, or tampered with: refused.
    const wrongType = await fetch(`${server.base}${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: new Uint8Array(png()),
    });
    expect(wrongType.status).toBe(403);
    const tampered = `${url.slice(0, -3)}AAA`;
    expect((await fetch(`${server.base}${tampered}`)).status).toBe(404);
    // An upload URL does not read.
    expect((await fetch(`${server.base}${url}`)).status).toBe(404);
  });

  it('another business never reaches a file: 404 everywhere, and its id is refused on a write', async () => {
    const up = await photo(owner);
    const made = await card(owner, { title: 'Gate', photos: [up.id] });
    expect(made.status).toBe(201);
    for (const [method, path] of [
      ['GET', `/api/files/${up.id}`],
      ['POST', `/api/files/${up.id}/confirm`],
      ['DELETE', `/api/files/${up.id}`],
      ['POST', `/api/files/${up.id}/transcribe`],
    ] as const)
      expect((await stranger.call(method, path)).status).toBe(404);
    expect((await stranger.call('GET', `/api/files?ids=${up.id}`)).body.items).toEqual([]);
    // Their own file cannot go on our card, nor ours on theirs.
    const theirs = await photo(stranger);
    const refused = await owner.call('PATCH', `/api/cards/${made.body.value.id}`, {
      photos: [up.id, theirs.id],
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'file_unavailable' });
    const steal = await card(stranger, { title: 'Mine now', photos: [up.id] });
    expect(steal.status).toBe(403);
    const denied = await pool.query(
      `select action, outcome from audit.events where rule = 'file_unavailable' and actor_id = $1`,
      [stranger.id],
    );
    expect(denied.rows).toContainEqual({ action: 'card.create', outcome: 'denied' });
    // Nothing moved.
    expect(await fileRow(theirs.id)).toMatchObject({ resource_id: null, status: 'ready' });
    expect(await fileRow(up.id)).toMatchObject({ resource_id: made.body.value.id });
  });

  it("a hidden field hides its file: staff get 404 for the card's secret, the owner reaches it", async () => {
    const up = await upload(owner, {
      name: 'terms.txt',
      mime: 'text/plain',
      bytes: Buffer.from('only for the owner'),
      for: { entity: 'card', field: 'secret' },
    });
    const made = await card(owner, { title: 'Vault', secret: up.id });
    expect(made.status).toBe(201);
    expect((await owner.call('GET', `/api/files/${up.id}`)).status).toBe(200);
    expect((await staff.call('GET', `/api/files/${up.id}`, undefined, inTenant())).status).toBe(
      404,
    );
    expect(
      (await staff.call('GET', `/api/files?ids=${up.id}`, undefined, inTenant())).body.items,
    ).toEqual([]);
    const seen = await staff.call('GET', `/api/cards/${made.body.value.id}`, undefined, inTenant());
    expect(seen.body).not.toHaveProperty('secret');
    // Not an image: served as an attachment, never inline.
    const got = await owner.call('GET', `/api/files/${up.id}`);
    const served = await fetch(`${server.base}${got.body.url}`);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it("an upload on no record is its uploader's alone: a colleague can neither see nor use it", async () => {
    const up = await photo(owner, 'mine.png');
    expect((await admin.call('GET', `/api/files/${up.id}`, undefined, inTenant())).status).toBe(
      404,
    );
    const used = await card(admin, { title: 'Borrowed', photos: [up.id] });
    expect(used.status).toBe(403);
    expect(used.body).toMatchObject({ rule: 'file_unavailable' });
    // The uploader throws it away: the row and the object go.
    const key = (await fileRow(up.id))?.key as string;
    expect(await service().storage.head(key)).not.toBeNull();
    expect((await owner.call('DELETE', `/api/files/${up.id}`)).status).toBe(204);
    expect((await owner.call('GET', `/api/files/${up.id}`)).status).toBe(404);
    expect(await service().storage.head(key)).toBeNull();
    expect((await audit(up.id)).map((r) => r.action)).toContain('file.discard');
  });

  it('presign refuses a field that is not there, a type or size it does not take, and no reach', async () => {
    const pre = (person: Person, body: object) =>
      person.call('POST', '/api/files', body, as(person));
    const base = { name: 'a.png', mime: 'image/png', size: 100 };
    expect(
      (await pre(owner, { ...base, for: { entity: 'card', field: 'title' } })).body,
    ).toMatchObject({ error: 'unknown_file_field' });
    expect((await pre(owner, { ...base, for: { entity: 'nothing', field: 'x' } })).status).toBe(
      400,
    );
    const pdf = await pre(owner, {
      ...base,
      mime: 'application/pdf',
      for: { entity: 'card', field: 'cover' },
    });
    expect(pdf.status).toBe(415);
    // A family never takes SVG unless it is named.
    const svg = await pre(owner, {
      ...base,
      mime: 'image/svg+xml',
      for: { entity: 'card', field: 'photos' },
    });
    expect(svg.status).toBe(415);
    const big = await pre(owner, {
      ...base,
      size: 300_000,
      for: { entity: 'card', field: 'cover' },
    });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ error: 'too_large', maxBytes: 200_000 });

    // Staff write only their own cards: not the owner's.
    const made = await card(owner, { title: 'Shed' });
    const notTheirs = await pre(staff, {
      ...base,
      for: { entity: 'card', field: 'photos', id: made.body.value.id },
    });
    expect(notTheirs.status).toBe(403);
    expect(notTheirs.body).toMatchObject({ rule: 'no_access' });
    const otherBusiness = await pre(stranger, {
      ...base,
      for: { entity: 'card', field: 'photos', id: made.body.value.id },
    });
    expect(otherBusiness.status).toBe(404);
    // The assistant has no bytes to send.
    const agent = await asAssistant(`user:${owner.id}`)('POST', '/api/files', {
      ...base,
      for: { entity: 'card', field: 'photos' },
    });
    expect(agent.status).toBe(403);
  });

  it('confirm checks the bytes: nothing sent (409), a wrong size or a fake image (422)', async () => {
    const pre = await owner.call('POST', '/api/files', {
      name: 'x.png',
      mime: 'image/png',
      size: png().length,
      for: { entity: 'card', field: 'photos' },
    });
    const id = pre.body.file.id;
    const confirm = () => owner.call('POST', `/api/files/${id}/confirm`);
    expect((await confirm()).body).toMatchObject({ error: 'not_uploaded' });
    const key = (await fileRow(id))?.key as string;
    // Stored around the URL's checks: the size is wrong.
    await service().storage.put(key, Buffer.alloc(10), 'image/png');
    expect((await confirm()).body).toMatchObject({ error: 'size_mismatch' });
    expect(await service().storage.head(key)).toBeNull();
    // The right size, but not a PNG.
    const fake = Buffer.alloc(png().length, 65);
    await fetch(`${server.base}${pre.body.upload.url}`, {
      method: 'PUT',
      headers: pre.body.upload.headers,
      body: new Uint8Array(fake),
    });
    const mismatch = await confirm();
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ error: 'content_mismatch' });
    expect(await fileRow(id)).toMatchObject({ status: 'pending' });
  });

  it('a field holds at most its count, and only files it takes', async () => {
    const four = [await photo(owner), await photo(owner), await photo(owner), await photo(owner)];
    const tooMany = await card(owner, { title: 'Too many', photos: four.map((f) => f.id) });
    expect(tooMany.status).toBe(400);
    // A PDF uploaded for attachments cannot become a photo.
    const doc = await upload(owner, {
      name: 'plan.pdf',
      mime: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7\n%fake\n'),
      for: { entity: 'card', field: 'attachments' },
    });
    expect(doc.confirmed?.status).toBe(200);
    const wrongField = await card(owner, { title: 'Plan', photos: [doc.id] });
    expect(wrongField.body).toMatchObject({ rule: 'file_unavailable' });
    expect((await card(owner, { title: 'Plan', attachments: [doc.id] })).status).toBe(201);
  });

  it('a presign and a discard repeated with their idempotency-key run once', async () => {
    const name = `retry-${randomUUID()}.png`;
    const body = {
      name,
      mime: 'image/png',
      size: png().length,
      for: { entity: 'card', field: 'photos' },
    };
    const key = { 'idempotency-key': randomUUID() };
    const first = await owner.call('POST', '/api/files', body, key);
    const again = await owner.call('POST', '/api/files', body, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.file.id).toBe(first.body.file.id);
    expect(again.body.upload.url).toBeTruthy();
    const { rows } = await pool.query('select count(*) n from app.files where name = $1', [name]);
    expect(Number(rows[0].n)).toBe(1);
    // The signed upload URL is not kept with the stored answer.
    const kept = await pool.query('select response from app.idempotency where key = $1', [
      key['idempotency-key'],
    ]);
    expect(JSON.stringify(kept.rows[0].response)).not.toContain('upload');
    expect((await owner.call('POST', '/api/files', { ...body, size: 1 }, key)).status).toBe(409);

    const discard = { 'idempotency-key': randomUUID() };
    const id = first.body.file.id as string;
    expect((await owner.call('DELETE', `/api/files/${id}`, undefined, discard)).status).toBe(204);
    expect((await owner.call('DELETE', `/api/files/${id}`, undefined, discard)).status).toBe(204);
    // Without the key, the file is gone.
    expect((await owner.call('DELETE', `/api/files/${id}`)).status).toBe(404);
  });
});

describe('the write path attaches and lets go', () => {
  it("the assistant's parked update carries the file unclaimed until it is approved", async () => {
    const up = await photo(owner, 'later.png');
    const made = await card(owner, { title: 'Deck' });
    const assistant = asAssistant(`user:${owner.id}`);
    const parked = await assistant('PATCH', `/api/cards/${made.body.value.id}`, {
      photos: [up.id],
    });
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    expect(await fileRow(up.id)).toMatchObject({ resource_id: null });
    expect(await audit(made.body.value.id)).toContainEqual(
      expect.objectContaining({ action: 'card.update', outcome: 'needs_approval' }),
    );

    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    expect(await fileRow(up.id)).toMatchObject({
      resource_type: 'card',
      resource_id: made.body.value.id,
      field: 'photos',
    });
    // The assistant reads the file's details, never a download link.
    const seen = await assistant('GET', `/api/files/${up.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.url).toBeUndefined();
  });

  it("a parked write may not carry someone else's file: refused at once, and audited", async () => {
    const theirs = await photo(admin, 'admins.png');
    const made = await card(owner, { title: 'Fence' });
    const parked = await asAssistant(`user:${owner.id}`)(
      'PATCH',
      `/api/cards/${made.body.value.id}`,
      { photos: [theirs.id] },
    );
    expect(parked.status).toBe(403);
    expect(parked.body).toMatchObject({ rule: 'file_unavailable' });
    const { rows } = await pool.query(
      `select count(*)::int as n from app.approvals where resource_id = $1`,
      [made.body.value.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('a file taken off a card is let go (and can come back); a deleted card lets go of all; the sweeper deletes them', async () => {
    const a = await photo(owner, 'a.png');
    const b = await photo(owner, 'b.png');
    const made = await card(owner, { title: 'Garden', photos: [a.id, b.id] });
    const id = made.body.value.id;
    expect((await owner.call('PATCH', `/api/cards/${id}`, { photos: [a.id] })).status).toBe(200);
    expect(await fileRow(b.id)).toMatchObject({ status: 'detached' });
    expect((await owner.call('GET', `/api/files/${b.id}`)).status).toBe(404);
    // Put back before it is swept (an undo).
    expect((await owner.call('PATCH', `/api/cards/${id}`, { photos: [b.id, a.id] })).status).toBe(
      200,
    );
    expect(await fileRow(b.id)).toMatchObject({ status: 'ready', resource_id: id });

    expect((await owner.call('DELETE', `/api/cards/${id}`)).status).toBe(200);
    for (const f of [a, b]) expect(await fileRow(f.id)).toMatchObject({ status: 'detached' });
    expect((await audit(b.id)).map((r) => r.action)).toEqual([
      'file.upload',
      'file.confirm',
      'file.attach',
      'file.detach',
      'file.attach',
      'file.detach',
    ]);

    // After the grace period the sweeper deletes rows and objects; so for a stale upload.
    const keys = [(await fileRow(a.id))?.key, (await fileRow(b.id))?.key] as string[];
    await pool.query(
      `update app.files set detached_at = now() - interval '400 hours' where id = any($1)`,
      [[a.id, b.id]],
    );
    const stale = await owner.call('POST', '/api/files', {
      name: 'never.png',
      mime: 'image/png',
      size: 10,
      for: { entity: 'card', field: 'photos' },
    });
    await pool.query(`update app.files set created_at = now() - interval '2 days' where id = $1`, [
      stale.body.file.id,
    ]);
    // Uploaded and confirmed, but never put on a record within the grace period.
    const unused = await photo(owner, 'unused.png');
    const fresh = await photo(owner, 'fresh.png');
    await pool.query(
      `update app.files set created_at = now() - interval '400 hours' where id = $1`,
      [unused.id],
    );
    const swept = await service().sweep();
    expect(swept.deleted).toBeGreaterThanOrEqual(4);
    for (const f of [a.id, b.id, stale.body.file.id, unused.id])
      expect(await fileRow(f)).toBeUndefined();
    expect(await fileRow(fresh.id)).toMatchObject({ status: 'ready' });
    for (const key of keys) expect(await service().storage.head(key)).toBeNull();
    expect((await audit(a.id)).at(-1)).toMatchObject({
      action: 'file.swept',
      actor_kind: 'system',
    });
  });
});

describe('voice', () => {
  it("an audio file's words are heard once and kept; the assistant reads them with its tools", async () => {
    const up = await upload(owner, {
      name: 'memo.ogg',
      mime: 'audio/ogg',
      bytes: note('Pour the slab on Monday'),
      for: { entity: 'card', field: 'attachments' },
    });
    expect((await card(owner, { title: 'Slab', attachments: [up.id] })).status).toBe(201);
    const heard = await owner.call('POST', `/api/files/${up.id}/transcribe`);
    expect(heard.status).toBe(200);
    expect(heard.body).toEqual({ text: 'Pour the slab on Monday', lang: 'en' });
    expect((await owner.call('GET', `/api/files/${up.id}`)).body).toMatchObject({
      transcript: 'Pour the slab on Monday',
      transcriptLang: 'en',
    });
    // Kept: a second call reads it back (the bytes could even be gone).
    await service().storage.delete((await fileRow(up.id))?.key as string);
    expect((await owner.call('POST', `/api/files/${up.id}/transcribe`)).body.text).toBe(
      'Pour the slab on Monday',
    );

    const said = await owner.chat(`what does file ${up.id} say`);
    expect(said.body.reply).toBe('The file says: "Pour the slab on Monday"');
    const about = await owner.chat(`what is file ${up.id}`);
    expect(about.body.reply).toBe('"memo.ogg" is a audio/ogg file, on a card.');
    // Through the same reach: another business's assistant finds nothing.
    expect((await stranger.chat(`what is file ${up.id}`)).body.reply).toBe(
      "I couldn't do that: No such file.",
    );

    const image = await photo(owner);
    await card(owner, { title: 'Pic', photos: [image.id] });
    expect((await owner.call('POST', `/api/files/${image.id}/transcribe`)).status).toBe(422);
  });
});

describe('WhatsApp media', () => {
  let address = '';
  let contactId = '';
  let customerId = '';

  it('a photo sent on WhatsApp is kept for its sender and named to the turn; the assistant puts it on a card', async () => {
    address = phone();
    ({ contactId, customerId } = await seedContact(tenantId, 'Mira', address));
    await pool.query('update channel.contacts set welcomed_at = now() where id = $1', [contactId]);
    await sendPhoto(address, 'card for Porch light');
    await eventually(() => textsTo(address).find((t) => t.includes('Kept it on the card')), 20_000);

    const { rows } = await pool.query(
      'select id, photos, owner_id from app.fixture_cards where customer_id = $1',
      [customerId],
    );
    expect(rows).toHaveLength(1);
    const fileId = rows[0].photos[0] as string;
    expect(await fileRow(fileId)).toMatchObject({
      source: 'whatsapp',
      contact_id: contactId,
      owner_id: null,
      status: 'ready',
      width: 320,
      height: 200,
      resource_type: 'card',
      resource_id: rows[0].id,
    });
    const message = await pool.query(
      `select kind, body from channel.messages where contact_id = $1 and direction = 'in'`,
      [contactId],
    );
    expect(message.rows).toEqual([{ kind: 'media', body: { fileId } }]);
    expect((await audit(fileId)).map((r) => r.action)).toEqual(['file.received', 'file.attach']);
    // The business reaches it through the card.
    expect((await owner.call('GET', `/api/files/${fileId}`)).status).toBe(200);
  });

  it('a message that is only a file is answered; a business that keeps no media keeps none', async () => {
    const from = phone();
    const c = await seedContact(tenantId, 'Ravi', from);
    await pool.query('update channel.contacts set welcomed_at = now() where id = $1', [
      c.contactId,
    ]);
    await sendPhoto(from);
    await eventually(() => textsTo(from).find((t) => t.includes('Which record should it go on?')));

    await setTenantSettings(tenantId, { files: { keepInboundMedia: false } });
    try {
      const before = (
        await pool.query('select count(*)::int as n from app.files where contact_id = $1', [
          c.contactId,
        ])
      ).rows[0].n;
      await sendPhoto(from, 'card for Nothing kept');
      await eventually(async () => {
        const { rows } = await pool.query(
          `select count(*)::int as n from channel.inbound_events where "from" = $1 and processed_at is null`,
          [from],
        );
        return rows[0].n === 0 && textsTo(from).length > 1;
      }, 20_000);
      const after = (
        await pool.query('select count(*)::int as n from app.files where contact_id = $1', [
          c.contactId,
        ])
      ).rows[0].n;
      expect(after).toBe(before);
    } finally {
      await setTenantSettings(tenantId, { files: null });
    }
  });

  it('"delete my data" erases what they sent; the sweeper deletes the objects', async () => {
    const [{ id: fileId, key }] = (
      await pool.query('select id, key from app.files where contact_id = $1', [contactId])
    ).rows;
    await deliver(address, { type: 'text', text: { body: 'delete my data' } });
    const erased = await eventually(async () => {
      const { rows } = await pool.query(
        `select after from audit.events where action = 'channel.contact.erased' and resource_id = $1`,
        [contactId],
      );
      return rows[0];
    }, 20_000);
    expect(erased.after).toMatchObject({ contributors: { files: 1 } });
    expect(await fileRow(fileId)).toMatchObject({ status: 'erased', name: 'erased' });
    expect((await owner.call('GET', `/api/files/${fileId}`)).status).toBe(404);
    await service().sweep();
    expect(await fileRow(fileId)).toBeUndefined();
    expect(await service().storage.head(key)).toBeNull();
    // The card keeps the id; sending its list back unchanged is still a valid write.
    const [cardRow] = (
      await pool.query('select id, photos from app.fixture_cards where $1 = any(photos)', [fileId])
    ).rows;
    const kept = await owner.call('PATCH', `/api/cards/${cardRow.id}`, {
      title: 'Porch light, renamed',
      photos: cardRow.photos,
    });
    expect(kept.status).toBe(200);
    expect(kept.body.value.photos).toEqual([fileId]);
  });
});

describe('personal data', () => {
  it("a person's export lists their files", async () => {
    const up = await photo(owner, 'exported.png');
    const { db } = provider<CoreOptions>(CORE_OPTIONS);
    const out = await api.exportPersonalData({ subject: { kind: 'user', userId: owner.id }, db });
    expect(out.files).toContainEqual(
      expect.objectContaining({ id: up.id, name: 'exported.png', mime: 'image/png' }),
    );
  });
});
