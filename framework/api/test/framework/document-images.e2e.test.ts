// Images in documents (B21), booted: `ctx.image` gives `load` only image files its requester may
// open (another business's, one on no record of theirs, one in a field hidden from them, a pending
// or erased one, an SVG, a WebP, one over a limit: refused), a layout naming an image its load was
// not given is refused (image_not_loaded), every limit answers its named error, a version keeps
// the pictures it was made with, and a picture gone before drawing fails the document at once
// (image_unavailable) with no PDF and nothing fetched. The fixture's `memos` and its photo sheet
// (fixture/src/features/documents). The fake engine draws (vitest.config.ts): plain text lines.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Api = typeof import('../../dist/index.js');
let api: Api;

import {
  addMember,
  boot,
  eventually,
  type Json,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { documentsApp } from '../fixture/dist/features/documents/index.js';

const owner = new Person('Owner Pictures');
const staff = new Person('Staff Pictures');
const stranger = new Person('Stranger Pictures');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === owner || p === stranger ? {} : inTenant());

const service = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(api.DocumentsService, { strict: false });
};

beforeAll(async () => {
  api = await import('../../dist/index.js');
  await boot(documentsApp);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

/* ── Pictures ──────────────────────────────────────────────────────────────── */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A PNG's signature and header (what sniffing reads), of this size; `seed` makes it unique. */
const png = (width = 40, height = 30, seed = 0) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    u32(13),
    Buffer.from('IHDR'),
    u32(width),
    u32(height),
    Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64, seed),
  ]);
/** A JPEG's start and a frame header of 32 × 16. */
const jpeg = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]),
    Buffer.alloc(40, 1),
  ]);
const webp = () => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8L', 8, 'latin1');
  b.writeUInt32LE(9 | (9 << 14), 21);
  return b;
};
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

type Field = 'photo' | 'photos' | 'secretPhoto';

/** Presign, PUT, confirm: a file meant for a memo's field. */
async function upload(
  p: Person,
  bytes: Buffer,
  mime = 'image/png',
  field: Field = 'photos',
  confirm = true,
): Promise<string> {
  const pre = await p.call(
    'POST',
    '/api/files',
    { name: `p-${Date.now()}`, mime, size: bytes.length, for: { entity: 'memo', field } },
    as(p),
  );
  expect(pre.status, JSON.stringify(pre.body)).toBe(201);
  if (!confirm) return pre.body.file.id;
  const put = await fetch(`${server.base}${pre.body.upload.url}`, {
    method: 'PUT',
    headers: pre.body.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBeLessThan(300);
  const done = await p.call('POST', `/api/files/${pre.body.file.id}/confirm`, undefined, as(p));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return pre.body.file.id;
}

const memo = async (p: Person, body: object) => {
  const res = await p.call('POST', '/api/memos', body, as(p));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value as { id: string };
};
const render = (p: Person, id: string, document = 'memos.photos') =>
  p.call('POST', '/api/documents', { document, id }, as(p));
const getDoc = (p: Person, id: string) => p.call('GET', `/api/documents/${id}`, undefined, as(p));
const ready = (p: Person, id: string) =>
  eventually(async () => {
    const got = await getDoc(p, id);
    return got.body?.status === 'ready' ? got.body : undefined;
  });
async function made(p: Person, id: string) {
  const res = await render(p, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ready(p, res.body.value.id);
}
/** The fake engine's lines: the words in the PDF behind a document's URL. */
async function lines(doc: Json): Promise<string> {
  const res = await fetch(doc.url.startsWith('/') ? `${server.base}${doc.url}` : doc.url);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer()).toString('utf8');
}
const stored = async (documentId: string) =>
  (
    await pool.query('select data, status, error, file_id from app.documents where id = $1', [
      documentId,
    ])
  ).rows[0] as {
    data: { images?: { fileId: string; sha256: string }[] };
    status: string;
    error: string | null;
    file_id: string | null;
  };

/** Run with some environment settings (the limits are read when a document is asked for). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

let sheet: { id: string };
let photoId = '';

describe('a document with pictures', () => {
  it('draws a picture, a grid, a header logo, a hidden picture for whoever sees it, and a QR code', async () => {
    photoId = await upload(owner, png(40, 30, 1), 'image/png', 'photo');
    const grid = [await upload(owner, jpeg(), 'image/jpeg'), await upload(owner, png(20, 20, 2))];
    const secret = await upload(owner, png(10, 10, 3), 'image/png', 'secretPhoto');
    sheet = await memo(owner, {
      title: 'Site',
      body: 'qr:upi://pay?pa=studio@bank&am=1500',
      photo: photoId,
      photos: grid,
      secretPhoto: secret,
    });
    const doc = await made(owner, sheet.id);
    const text = await lines(doc);
    for (const line of [
      '[Image: header]  Site',
      '[Image: photo]',
      '[Image: photo 1]',
      '[Image: photo 2]',
      '[Image: secret]',
      '[QR: upi://pay?pa=studio@bank&am=1500]',
    ])
      expect(text).toContain(`(${line})`);
    // The snapshot keeps each picture once, by file and SHA-256; the audit counts them.
    const row = await stored(doc.id);
    expect(row.data.images?.map((i) => i.fileId).sort()).toEqual([photoId, ...grid, secret].sort());
    for (const i of row.data.images ?? []) expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [audited] = (
      await pool.query(
        `select after from audit.events where action = 'document.rendered' and resource_id = $1`,
        [doc.id],
      )
    ).rows;
    expect(audited.after.images).toBe(4);
    // Events carry ids and status, never pictures.
    const events = (
      await pool.query('select name, row from app.domain_events where resource_id = $1', [doc.id])
    ).rows;
    expect(events.map((e) => e.name)).toContain('document.rendered');
    for (const e of events) expect(JSON.stringify(e.row)).not.toContain(photoId);
  });

  it('a picture in a field hidden from the requester never reaches their PDF', async () => {
    const doc = await made(staff, sheet.id);
    const text = await lines(doc);
    expect(text).toContain('([Image: photo])');
    expect(text).not.toContain('[Image: secret]');
    expect((await stored(doc.id)).data.images).toHaveLength(3);
  });

  it('ctx.image gives only image files the requester may open, PNG or JPEG', async () => {
    const theirs = await upload(stranger, png(5, 5, 4), 'image/png', 'photo');
    await memo(stranger, { title: 'Elsewhere', photo: theirs });
    const loose = await upload(owner, png(6, 6, 5)); // on no record: only its uploader reaches it
    const pending = await upload(owner, png(7, 7, 6), 'image/png', 'photos', false);
    const vector = await upload(owner, svg(), 'image/svg+xml');
    const web = await upload(owner, webp(), 'image/webp');
    const gone = await upload(owner, png(8, 8, 7));
    const hidden = await upload(owner, png(9, 9, 8), 'image/png', 'secretPhoto');
    const good = await upload(owner, png(11, 11, 9));
    const probes = [theirs, loose, pending, vector, web, gone, hidden, good];
    const m = await memo(owner, {
      title: 'Probes',
      body: `probe:${probes.join(',')}`,
      photos: [vector, web, gone, good],
      secretPhoto: hidden,
    });
    await pool.query(`update app.files set status = 'erased' where id = $1`, [gone]);
    const text = await lines(await made(staff, m.id));
    for (const id of [theirs, loose, pending, vector, web, gone, hidden])
      expect(text, id).toContain(`(probe ${id}: refused)`);
    expect(text).toContain(`(probe ${good}: given)`);
    // The owner uploaded the loose one: theirs to show.
    const mine = await lines(await made(owner, m.id));
    expect(mine).toContain(`(probe ${loose}: given)`);
    expect(mine).toContain(`(probe ${hidden}: given)`);
    expect(mine).toContain(`(probe ${theirs}: refused)`);
  });

  it('a layout naming an image its load was not given is refused: image_not_loaded', async () => {
    const forged = await memo(owner, {
      title: 'Forged',
      body: 'forge',
      photo: await upload(owner, png(13, 13, 16), 'image/png', 'photo'),
    });
    const res = await render(owner, forged.id);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'image_not_loaded' });
    const other = await upload(owner, png(12, 12, 10));
    const unloaded = await memo(owner, {
      title: 'Unloaded',
      body: `unloaded:${other}`,
      photo: await upload(owner, png(14, 13, 17), 'image/png', 'photo'),
    });
    expect((await render(owner, unloaded.id)).body).toMatchObject({ error: 'image_not_loaded' });
  });

  it('a QR text too long for its level is refused when asked: qr_too_long', async () => {
    const long = await memo(owner, { title: 'Long', body: `qr:${'ఆ'.repeat(900)}` });
    const res = await render(owner, long.id);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'qr_too_long' });
    expect(res.body.issues[0].path).toEqual(['blocks', 1, 'data']);
  });

  it('each limit answers its named error, never a 500', async () => {
    // Images per document: the sheet shows four.
    const many = await withEnv({ DOCUMENTS_IMAGES_MAX: '3' }, () => render(owner, sheet.id));
    expect(many.status).toBe(422);
    expect(many.body).toMatchObject({ error: 'too_many_images' });
    // Image bytes per document.
    const total = await withEnv({ DOCUMENTS_IMAGES_MAX_BYTES: '150' }, () =>
      render(owner, sheet.id),
    );
    expect(total.status).toBe(422);
    expect(total.body).toMatchObject({ error: 'images_too_large' });
    // Bytes or pixels of one image: not given to load (image_too_large, logged), so not shown.
    const big = await upload(owner, png(400, 300, 11));
    const m = await memo(owner, { title: 'Big', body: `probe:${big}` });
    for (const env of [{ DOCUMENTS_IMAGE_MAX_BYTES: '50' }, { DOCUMENTS_IMAGE_MAX_PIXELS: '1000' }])
      expect(await withEnv(env, async () => lines(await made(owner, m.id)))).toContain(
        `(probe ${big}: refused)`,
      );
    expect(await lines(await made(owner, m.id))).toContain(`(probe ${big}: given)`);
  });
});

describe('versions and failures', () => {
  it('a version keeps the picture it was made with; the next shows the new one', async () => {
    const first = await upload(owner, png(30, 30, 12), 'image/png', 'photo');
    const m = await memo(owner, { title: 'Kitchen', photo: first });
    const v1 = await made(owner, m.id);
    const second = await upload(owner, png(30, 30, 13), 'image/png', 'photo');
    const changed = await owner.call('PATCH', `/api/memos/${m.id}`, { photo: second });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const v2 = await made(owner, m.id);
    expect(v2.version).toBe(v1.version + 1);
    const again = (await getDoc(owner, v1.id)).body;
    expect(again.sha256).toBe(v1.sha256);
    expect((await stored(v1.id)).data.images?.[0].fileId).toBe(first);
    expect((await stored(v2.id)).data.images?.[0].fileId).toBe(second);
    expect((await stored(v2.id)).data.images?.[0].sha256).not.toBe(
      (await stored(v1.id)).data.images?.[0].sha256,
    );
  });

  it('a picture erased before drawing fails the document at once: image_unavailable, no PDF, nothing fetched', async () => {
    const picture = await upload(owner, png(14, 14, 14), 'image/png', 'photo');
    const m = await memo(owner, { title: 'Erased', photo: picture });
    const doc = await made(owner, m.id);
    // As if the render had not run yet: pending again, and the picture erased meanwhile.
    await pool.query(
      `update app.documents set status = 'pending', file_id = null, sha256 = null where id = $1`,
      [doc.id],
    );
    await pool.query(`update app.files set status = 'erased' where id = $1`, [picture]);
    const fetched: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(url));
      return real(url, init);
    }) as typeof fetch;
    let outcome: string;
    try {
      // Not the last try: a picture that is gone does not come back, so it fails now.
      outcome = await service().render(doc.id, false);
    } finally {
      globalThis.fetch = real;
    }
    expect(outcome).toBe('failed');
    expect(fetched).toEqual([]);
    const row = await stored(doc.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(`image_unavailable: ${picture}`);
    expect(row.file_id).toBeNull();
    expect((await getDoc(owner, doc.id)).body).toMatchObject({ status: 'failed' });
  });

  it('a picture whose bytes changed since is unavailable too', async () => {
    const picture = await upload(owner, png(15, 15, 15), 'image/png', 'photo');
    const m = await memo(owner, { title: 'Changed', photo: picture });
    const doc = await made(owner, m.id);
    await pool.query(
      `update app.documents set status = 'pending', file_id = null, sha256 = null,
         data = jsonb_set(data, '{images,0,sha256}', to_jsonb(repeat('a', 64))) where id = $1`,
      [doc.id],
    );
    expect(await service().render(doc.id, false)).toBe('failed');
    expect((await stored(doc.id)).error).toBe(`image_unavailable: ${picture}`);
  });
});
