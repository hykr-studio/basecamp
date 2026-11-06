// Photos on notes (the files feature in the sample's notes module): uploaded in the app and kept
// on a note, reached only through it, let go of when the note goes (an approved delete), and a
// photo sent on WhatsApp put on a new note by the assistant.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
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
} from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const alice = new Person('Alice Photos');
const bob = new Person('Bob Photos');
let tenantId = '';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  u32(13),
  Buffer.from('IHDR'),
  u32(1200),
  u32(900),
  Buffer.alloc(40, 1),
]);

/** Presign for a note's photos, PUT the bytes, confirm: the file's id. */
async function uploadPhoto(person: Person, name = 'site.png'): Promise<string> {
  const pre = await person.call('POST', '/api/files', {
    name,
    mime: 'image/png',
    size: png.length,
    for: { entity: 'note', field: 'photos' },
  });
  expect(pre.status).toBe(201);
  const put = await fetch(`${server.base}${pre.body.upload.url}`, {
    method: 'PUT',
    headers: pre.body.upload.headers,
    body: new Uint8Array(png),
  });
  expect(put.status).toBe(200);
  const done = await person.call('POST', `/api/files/${pre.body.file.id}/confirm`);
  expect(done.body).toMatchObject({ status: 'ready', width: 1200, height: 900 });
  return pre.body.file.id;
}

const fileRow = async (id: string) =>
  (
    await pool.query(
      'select status, resource_id, contact_id, source from app.files where id = $1',
      [id],
    )
  ).rows[0] as Json;

/* A stand-in WhatsApp Cloud API that serves one photo. */
const sent: { to: string; text?: { body: string } }[] = [];
const media = new Map<string, Buffer>();
let stub: Server;
let stubUrl = '';
const secret = 'test-app-secret';
const NUMBER = `pn-photos-${Date.now()}`;
let seq = 0;

async function sendPhoto(from: string, caption: string) {
  const mediaId = `media-photos-${Date.now()}-${seq++}`;
  media.set(mediaId, png);
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
                  id: `m-photos-${Date.now()}-${seq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'image',
                  image: { id: mediaId, mime_type: 'image/png', caption },
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
        if (file && media.has(file)) {
          res.writeHead(200, { 'content-type': 'image/png' }).end(media.get(file));
          return;
        }
        const id = path.split('/').at(-1) ?? '';
        if (media.has(id)) return json({ url: `${stubUrl}/files/${id}`, mime_type: 'image/png' });
        return json({ data: [] });
      }
      if (data) sent.push(JSON.parse(data));
      json({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  stubUrl = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_GRAPH_URL = stubUrl;
  process.env.WA_APP_SECRET = secret;
  await boot(application);
  await alice.signUp();
  await bob.signUp();
  tenantId = (await me(alice)).tenantId;
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

describe('photos on notes', () => {
  it('a photo uploaded in the app is kept on a note and reached through it', async () => {
    const photo = await uploadPhoto(alice);
    const made = await alice.call('POST', '/api/notes', { title: 'Site walk', photos: [photo] });
    expect(made.status).toBe(201);
    expect(made.body.value.photos).toEqual([photo]);
    const got = await alice.call('GET', `/api/files/${photo}`);
    expect(got.body).toMatchObject({
      attachedTo: { entity: 'note', id: made.body.value.id, field: 'photos' },
    });
    const served = await fetch(`${server.base}${got.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it("another business gets 404, and can't put the photo on its own note", async () => {
    const photo = await uploadPhoto(alice);
    await alice.call('POST', '/api/notes', { title: 'Kitchen', photos: [photo] });
    expect((await bob.call('GET', `/api/files/${photo}`)).status).toBe(404);
    const taken = await bob.call('POST', '/api/notes', { title: 'Mine', photos: [photo] });
    expect(taken.status).toBe(403);
    expect(taken.body).toMatchObject({ rule: 'file_unavailable' });
  });

  it('only images go in photos', async () => {
    const pdf = await alice.call('POST', '/api/files', {
      name: 'plan.pdf',
      mime: 'application/pdf',
      size: 100,
      for: { entity: 'note', field: 'photos' },
    });
    expect(pdf.status).toBe(415);
  });

  it("the assistant's delete waits for approval; approved, the note lets go of its photo", async () => {
    const photo = await uploadPhoto(alice);
    const made = await alice.call('POST', '/api/notes', { title: 'Old', photos: [photo] });
    const parked = await asAssistant(`user:${alice.id}`)(
      'DELETE',
      `/api/notes/${made.body.value.id}`,
    );
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    expect(await fileRow(photo)).toMatchObject({
      status: 'ready',
      resource_id: made.body.value.id,
    });
    const approved = await alice.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    expect(await fileRow(photo)).toMatchObject({ status: 'detached' });
    expect((await alice.call('GET', `/api/files/${photo}`)).status).toBe(404);
  });

  it('a photo sent on WhatsApp goes on a new note', async () => {
    expect(
      (await alice.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
    ).toBe(201);
    const address = `9188${String(Date.now()).slice(-7)}`;
    const { contactId, customerId } = await seedContact(tenantId, 'Kiran', address);
    await pool.query('update channel.contacts set welcomed_at = now() where id = $1', [contactId]);
    await sendPhoto(address, 'note Porch light');
    await eventually(
      () =>
        sent.find((s) => s.to === address && s.text?.body.includes('Saved the photo on the note')),
      20_000,
    );
    const { rows } = await pool.query(
      'select title, photos from app.notes where customer_id = $1',
      [customerId],
    );
    expect(rows).toEqual([{ title: 'Porch light', photos: [expect.any(String)] }]);
    expect(await fileRow(rows[0].photos[0])).toMatchObject({
      source: 'whatsapp',
      contact_id: contactId,
      resource_id: expect.any(String),
    });
  });
});
