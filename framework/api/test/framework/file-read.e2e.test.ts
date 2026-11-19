// Reading files with a model: the `vision` capability in the deployment's registry and the
// business's policy, `POST /api/files/:id/read` and the assistant's `read-file` tool (the same
// reach as GET /api/files/:id), PDFs drawn page by page or sent as they are, limits, credits,
// metering on tokens and file_pages, one audit row per read with no reading in it, a WhatsApp
// photo read in the turn it came with, and `readWithModel` for server code (a schema, one retry,
// never inside a write's transaction). The scripted vision model "sees" what follows
// FAKE-VISION: in a file's bytes; the stub gateway (fixture/features/models) counts what reaches it.
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Principal } from '@hykr/contracts';
import { inWriteTransaction } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addMember,
  boot,
  eventually,
  type Json,
  makeOperator,
  me,
  Person,
  pool,
  seedContact,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { filesApp } from '../fixture/dist/features/files/index.js';
import { type StubGateway, startGateway } from '../fixture/dist/features/models/gateway.js';

type Api = typeof import('../../dist/index.js');
let api: Api;

const owner = new Person('Owner Reads');
const staff = new Person('Staff Reads');
const stranger = new Person('Stranger Reads');
const opal = new Person('Opal Reads');
let tenantId = '';
let gateway: StubGateway;
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === staff ? inTenant() : {});

const ENV = [
  'MODEL_PROVIDERS',
  'FILES_READ_MAX_BYTES',
  'FILES_READ_PER_HOUR',
  'WA_GRAPH_URL',
  'WA_APP_SECRET',
] as const;
const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));

const service = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(api.FilesService, { strict: false });
};

/* ── Bytes ─────────────────────────────────────────────────────────────────── */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A PNG's header (its type and size), then what the scripted vision model sees in it. */
const png = (sees?: string, width = 640, height = 480) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    u32(13),
    Buffer.from('IHDR'),
    u32(width),
    u32(height),
    Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64, 7),
    ...(sees ? [Buffer.from(`FAKE-VISION:${sees}`)] : []),
  ]);

const require = createRequire(import.meta.url);
/** A PDF of `n` pages; page i says "FAKE-VISION:Page i" in its text layer. */
async function pdf(n: number): Promise<Buffer> {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  for (let i = 1; i <= n; i++) {
    if (i > 1) doc.addPage();
    doc.fontSize(18).text(`FAKE-VISION:Page ${i}`);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

type For = { entity: string; field: string };

async function upload(person: Person, o: { name: string; mime: string; bytes: Buffer; for: For }) {
  const pre = await person.call(
    'POST',
    '/api/files',
    { name: o.name, mime: o.mime, size: o.bytes.length, for: o.for },
    as(person),
  );
  expect(pre.status).toBe(201);
  await fetch(`${server.base}${pre.body.upload.url}`, {
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
  expect(confirmed.status).toBe(200);
  return pre.body.file.id as string;
}

/** A card holding this file in this field, made by the owner. */
async function onCard(field: string, o: { name: string; mime: string; bytes: Buffer }) {
  const id = await upload(owner, { ...o, for: { entity: 'card', field } });
  const value = ['photos', 'attachments'].includes(field) ? [id] : id;
  const made = await owner.call('POST', '/api/cards', {
    title: `Card ${randomUUID()}`,
    [field]: value,
  });
  expect(made.status).toBe(201);
  return id;
}

const photoOnCard = (sees: string) =>
  onCard('photos', { name: 'scan.png', mime: 'image/png', bytes: png(sees) });

const read = (person: Person, id: string, body: object = {}) =>
  person.call('POST', `/api/files/${id}/read`, body, as(person));

const readAudits = async (fileId: string) =>
  (
    await pool.query(
      `select actor_kind, after from audit.events where action = 'file.read_by_model' and resource_id = $1`,
      [fileId],
    )
  ).rows as { actor_kind: string; after: Json }[];

const uses = async (meter: string, ref: string) =>
  (
    await pool.query(
      'select quantity::int as quantity, variant, source from app.usage_events where tenant_id = $1 and meter = $2 and ref = $3',
      [tenantId, meter, ref],
    )
  ).rows;

/** The read's metering key: the request id its audit row carries. */
const lastReadRequest = async (fileId: string) =>
  (
    await pool.query(
      `select request_id from audit.events where action = 'file.read_by_model' and resource_id = $1 order by at desc limit 1`,
      [fileId],
    )
  ).rows[0]?.request_id as string;

const visionRequests = () =>
  gateway.requests.filter((r) =>
    (r.body.messages ?? []).some(
      (m: { content?: unknown }) =>
        Array.isArray(m.content) &&
        m.content.some((p: { type?: string }) => p.type === 'image_url' || p.type === 'file'),
    ),
  );
const partsOf = (r: { body: Json }, type: string) =>
  r.body.messages
    .flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: { type?: string }) => p.type === type).length;

/* ── A stand-in WhatsApp Cloud API that serves media ───────────────────────── */

const sent: { to: string; text?: { body: string } }[] = [];
const textsTo = (n: string) => sent.filter((s) => s.to === n).flatMap((s) => s.text?.body ?? []);
const media = new Map<string, { bytes: Buffer; mime: string }>();
const secret = 'test-app-secret-reads';
const NUMBER = `pn-reads-${Date.now()}`;
let seq = 0;
const phone = () => `9188${String(Date.now()).slice(-6)}${seq++ % 10}`;
let stopWa: () => void = () => undefined;

async function sendPhoto(from: string, sees: string, caption: string) {
  const id = `media-reads-${Date.now()}-${seq++}`;
  media.set(id, { bytes: png(sees, 320, 200), mime: 'image/png' });
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
                  id: `m-reads-${Date.now()}-${seq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'image',
                  image: { id, mime_type: 'image/png', caption },
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

/** The stub providers: `eye` in the north (one model sees, one takes PDFs, one is text only). */
const providers = (url: string) => [
  {
    id: 'eye',
    baseUrl: `${url}/v1`,
    apiKey: 'eye-key',
    region: 'north',
    models: [
      { id: 'see', capabilities: ['vision'] },
      { id: 'docs', capabilities: ['vision', 'pdf'] },
      { id: 'blind' },
    ],
  },
  {
    id: 'far',
    baseUrl: `${url}/far/v1`,
    apiKey: 'far-key',
    region: 'south',
    models: [{ id: 'see', capabilities: ['vision'] }],
  },
];

beforeAll(async () => {
  gateway = await startGateway();
  const { createServer } = await import('node:http');
  const wa = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const json = (body: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET') {
        const file = /\/files\/(.+)$/.exec(path)?.[1];
        const held = file ? media.get(file) : undefined;
        if (file && held)
          return void res.writeHead(200, { 'content-type': held.mime }).end(held.bytes);
        const id = path.split('/').at(-1) ?? '';
        const meta = media.get(id);
        if (meta) return json({ url: `${waUrl}/files/${id}`, mime_type: meta.mime });
        return json({ data: [] });
      }
      if (data) sent.push(JSON.parse(data));
      json({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] });
    });
  });
  await new Promise<void>((r) => wa.listen(0, r));
  const waUrl = `http://localhost:${(wa.address() as { port: number }).port}`;
  stopWa = () => wa.close();
  process.env.WA_GRAPH_URL = waUrl;
  process.env.WA_APP_SECRET = secret;
  process.env.MODEL_PROVIDERS = JSON.stringify(providers(gateway.url));
  process.env.FILES_READ_MAX_BYTES = String(150_000);
  api = await import('../../dist/index.js');
  await boot(filesApp);
  for (const p of [owner, staff, stranger, opal]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await makeOperator(opal, ['platform.credits']);
  expect(
    (await owner.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
});

afterAll(async () => {
  for (const n of ENV)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  stopWa();
  await shutdown();
  await gateway?.close();
});

describe('the vision capability and the policy', () => {
  it('GET /api/models lists capabilities and the model that reads files', async () => {
    const res = await owner.call('GET', '/api/models');
    expect(res.status).toBe(200);
    const see = res.body.models.find((m: { ref: string }) => m.ref === 'eye/see');
    expect(see).toMatchObject({ kind: 'chat', capabilities: ['vision'], allowed: false });
    expect(
      res.body.models.find((m: { ref: string }) => m.ref === 'eye/blind').capabilities,
    ).toEqual([]);
    // Fake mode: the scripted model reads files too.
    expect(res.body.vision).toEqual({ ref: 'fake/scripted' });
  });

  it('a business picks its vision model; one out of region, not allowed or text only is refused', async () => {
    const set = (policy: object) => owner.call('PUT', '/api/models/policy', policy);
    const far = await set({ allowed: ['far/see'], vision: 'far/see', regions: ['north'] });
    expect(far.status).toBe(400);
    expect(JSON.stringify(far.body.problems)).toContain('outside');
    const notAllowed = await set({ allowed: ['eye/docs'], vision: 'eye/see' });
    expect(notAllowed.status).toBe(400);
    expect(JSON.stringify(notAllowed.body.problems)).toContain('vision');
    const blind = await set({ allowed: ['eye/blind'], vision: 'eye/blind' });
    expect(blind.status).toBe(400);
    expect(JSON.stringify(blind.body.problems)).toContain('cannot read images');

    const ok = await set({ allowed: ['eye/see'], vision: 'eye/see', regions: ['north'] });
    expect(ok.status).toBe(200);
    expect((await owner.call('GET', '/api/models')).body.vision).toEqual({ ref: 'eye/see' });
    await setTenantSettings(tenantId, { models: null });
  });
});

describe('reading a file', () => {
  it('reads a photo on a record: the text, the pages, the model; one audit row with no reading', async () => {
    const id = await photoOnCard('Total 1,250 at Sharma Hardware');
    const res = await read(owner, id, { question: 'the total' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      text: 'Total 1,250 at Sharma Hardware',
      pages: 1,
      model: 'fake/scripted',
    });
    const rows = await readAudits(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ model: 'fake/scripted', pages: 1, provider: 'fake' });
    // Nothing of what the file says, nor a URL, in the audit trail or the stored events.
    const trail = await pool.query(
      `select count(*)::int as n from audit.events where tenant_id = $1 and (after::text like '%Sharma%' or after::text like '%/api/files/blob%')`,
      [tenantId],
    );
    expect(trail.rows[0].n).toBe(0);
    const events = await pool.query(
      `select count(*)::int as n from app.domain_events where tenant_id = $1 and (row::text like '%Sharma%' or before::text like '%Sharma%')`,
      [tenantId],
    );
    expect(events.rows[0].n).toBe(0);
    // Metered: tokens on the model's ref, one page.
    const ref = `file_read:${await lastReadRequest(id)}`;
    expect(await uses('tokens', ref)).toEqual([
      expect.objectContaining({ variant: 'fake/scripted', source: 'file_read' }),
    ]);
    expect(await uses('file_pages', ref)).toEqual([
      expect.objectContaining({ quantity: 1, variant: 'fake/scripted' }),
    ]);
  });

  it('the assistant reads it with read-file, as the person', async () => {
    const id = await photoOnCard('Gate code 4321');
    const said = await owner.chat(`read file ${id}`);
    expect(said.body.reply).toBe('The file shows: Gate code 4321');
    expect((await readAudits(id))[0].actor_kind).toBe('agent');
  });

  it('404 for a file of another business, one hidden from them, one not ready; their own upload reads', async () => {
    const id = await photoOnCard('Private');
    expect((await read(stranger, id)).status).toBe(404);
    expect((await stranger.chat(`read file ${id}`)).body.reply).toBe(
      "I couldn't do that: No such file.",
    );
    // The card's secret field is hidden from staff: so is its file.
    const secret = await onCard('secret', { name: 's.png', mime: 'image/png', bytes: png('x') });
    expect((await read(staff, secret)).status).toBe(404);
    expect((await read(owner, secret)).status).toBe(200);
    // Presigned, never confirmed: not ready.
    const pre = await owner.call('POST', '/api/files', {
      name: 'p.png',
      mime: 'image/png',
      size: 100,
      for: { entity: 'card', field: 'photos' },
    });
    expect((await read(owner, pre.body.file.id)).status).toBe(404);
    // An upload on no record yet is its uploader's to read.
    const mine = await upload(staff, {
      name: 'mine.png',
      mime: 'image/png',
      bytes: png('Mine'),
      for: { entity: 'card', field: 'photos' },
    });
    expect((await read(staff, mine)).body.text).toBe('Mine');
    expect((await read(owner, mine)).status).toBe(404);
  });

  it('422 for audio, SVG, HEIC, a file over the limit and a PDF over the page limit', async () => {
    const audio = await onCard('attachments', {
      name: 'n.ogg',
      mime: 'audio/ogg',
      bytes: Buffer.from('FAKE-STT:en:hello'),
    });
    expect((await read(owner, audio)).body).toMatchObject({ error: 'unsupported_type' });
    const svg = await onCard('secret', {
      name: 'a.svg',
      mime: 'image/svg+xml',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    expect((await read(owner, svg)).status).toBe(422);
    const heicBytes = Buffer.concat([u32(24), Buffer.from('ftypheic'), Buffer.alloc(40)]);
    const heic = await onCard('secret', { name: 'i.heic', mime: 'image/heic', bytes: heicBytes });
    const refusedHeic = await read(owner, heic);
    expect(refusedHeic.status).toBe(422);
    expect(refusedHeic.body.message).toContain('JPEG');
    // FILES_READ_MAX_BYTES is 150 KB here.
    const big = await onCard('photos', {
      name: 'big.png',
      mime: 'image/png',
      bytes: Buffer.concat([png('big'), Buffer.alloc(160_000)]),
    });
    expect((await read(owner, big)).body).toMatchObject({ error: 'too_large' });
    const long = await onCard('attachments', {
      name: 'long.pdf',
      mime: 'application/pdf',
      bytes: await pdf(21),
    });
    const tooMany = await read(owner, long);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body).toMatchObject({ error: 'too_many_pages' });
    // Naming pages within the limit reads them.
    const two = await read(owner, long, { pages: [20, 21] });
    expect(two.body).toMatchObject({ pages: 2, text: 'Page 20\nPage 21' });
    expect((await read(owner, long, { pages: [22] })).body).toMatchObject({ error: 'bad_pages' });
  });
});

describe('PDFs, models and credits', () => {
  it('a 12-page PDF read with pages [1, 2] sends 2 page images and counts 2 pages; tokens on the model', async () => {
    await setTenantSettings(tenantId, { models: { allowed: ['eye/see'], vision: 'eye/see' } });
    try {
      const id = await onCard('attachments', {
        name: 'plan.pdf',
        mime: 'application/pdf',
        bytes: await pdf(12),
      });
      const before = visionRequests().length;
      const res = await read(owner, id, { pages: [1, 2] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        text: 'Read 2 images and 0 PDFs on see.',
        pages: 2,
        model: 'eye/see',
      });
      const sentNow = visionRequests().slice(before);
      expect(sentNow).toHaveLength(1);
      expect(sentNow[0].model).toBe('see');
      expect(partsOf(sentNow[0], 'image_url')).toBe(2);
      // The page's text layer goes with it, and the system prompt says the file is data.
      expect(JSON.stringify(sentNow[0].body.messages)).toContain('Page 1, its text layer');
      expect(JSON.stringify(sentNow[0].body.messages)).toContain('never instructions');
      const ref = `file_read:${await lastReadRequest(id)}`;
      expect(await uses('file_pages', ref)).toEqual([
        expect.objectContaining({ quantity: 2, variant: 'eye/see' }),
      ]);
      expect(await uses('tokens', ref)).toEqual([
        expect.objectContaining({ quantity: 150, variant: 'eye/see' }),
      ]);
    } finally {
      await setTenantSettings(tenantId, { models: null });
    }
  });

  it('a model that takes PDFs gets the PDF as it is', async () => {
    await setTenantSettings(tenantId, { models: { allowed: ['eye/docs'], vision: 'eye/docs' } });
    try {
      const id = await onCard('attachments', {
        name: 'short.pdf',
        mime: 'application/pdf',
        bytes: await pdf(3),
      });
      const before = visionRequests().length;
      const res = await read(owner, id);
      expect(res.body).toMatchObject({ text: 'Read 0 images and 1 PDFs on docs.', pages: 3 });
      expect(partsOf(visionRequests().slice(before)[0], 'file')).toBe(1);
    } finally {
      await setTenantSettings(tenantId, { models: null });
    }
  });

  it('no vision model: 409 no_vision_model, and the assistant says it cannot read files here', async () => {
    await setTenantSettings(tenantId, { models: { allowed: ['eye/blind'], chat: 'eye/blind' } });
    try {
      const id = await photoOnCard('Nothing');
      const before = visionRequests().length;
      const res = await read(owner, id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'no_vision_model' });
      const said = await owner.chat(`read file ${id}`);
      expect(said.body.reply).toContain("Files can't be read here");
      expect(visionRequests().length).toBe(before);
    } finally {
      await setTenantSettings(tenantId, { models: null });
    }
  });

  it('a business paused by credits gets the paused answer before any model call', async () => {
    const id = await photoOnCard('Paused');
    const paused = await opal.call('PUT', `/api/credits/operator/${tenantId}/override`, {
      override: { mode: 'pause', reason: 'unpaid invoice' },
    });
    expect(paused.status).toBeLessThan(300);
    try {
      const res = await read(owner, id);
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: 'credits_paused', rule: 'credits_suspended' });
      expect(await readAudits(id)).toEqual([]);
    } finally {
      await opal.call('PUT', `/api/credits/operator/${tenantId}/override`, { override: null });
    }
  });
});

describe('WhatsApp', () => {
  it('a photo sent on WhatsApp is read in the same turn; a business can turn that off', async () => {
    const from = phone();
    const c = await seedContact(tenantId, 'Mira Reads', from);
    await pool.query('update channel.contacts set welcomed_at = now() where id = $1', [
      c.contactId,
    ]);
    await sendPhoto(from, 'Deliver on Friday', 'what does this say');
    await eventually(
      () => textsTo(from).find((t) => t.includes('The file shows: Deliver on Friday')),
      20_000,
    );
    const { rows } = await pool.query(
      `select e.actor_kind from audit.events e join app.files f on f.id = e.resource_id
       where e.action = 'file.read_by_model' and f.contact_id = $1`,
      [c.contactId],
    );
    expect(rows).toEqual([{ actor_kind: 'agent' }]);

    await setTenantSettings(tenantId, { files: { readInbound: false } });
    try {
      await sendPhoto(from, 'Not read', 'what does this say');
      await eventually(() => textsTo(from).find((t) => t.includes("I couldn't do that")), 20_000);
      expect(textsTo(from).some((t) => t.includes('Not read'))).toBe(false);
    } finally {
      await setTenantSettings(tenantId, { files: null });
    }
  });
});

describe('readWithModel, for server code', () => {
  const Counted = z.object({ count: z.number(), label: z.string() });
  const principal = async (): Promise<Principal> => ({
    actor: { kind: 'user', id: owner.id },
    subject: { kind: 'user', userId: owner.id },
    tenantId,
    roles: ['owner'],
    scopes: [],
  });

  it('returns a checked value; a wrong first reply is retried once; then 422 unreadable', async () => {
    const p = await principal();
    const good = await photoOnCard('{"count": 1250, "label": "Sharma"}');
    await expect(
      service().readWithModel(p, good, { instructions: 'The count', schema: Counted }),
    ).resolves.toEqual({
      value: { count: 1250, label: 'Sharma' },
      model: 'fake/scripted',
      pages: 1,
    });

    const second = await photoOnCard('{"count": "a lot"}|||{"count": 90, "label": "Rao"}');
    await expect(
      service().readWithModel(p, second, { instructions: 'The count', schema: Counted }),
    ).resolves.toMatchObject({ value: { count: 90, label: 'Rao' } });

    const never = await photoOnCard('not json at all');
    await expect(
      service().readWithModel(p, never, { instructions: 'The count', schema: Counted }),
    ).rejects.toMatchObject({ response: { error: 'unreadable' } });
    // Still one audit row each, the failed one included (its tokens were spent).
    expect(await readAudits(never)).toHaveLength(1);
  });

  it('inside a write transaction it throws at once, never calling out', async () => {
    const p = await principal();
    const id = await photoOnCard('{"count": 1, "label": "x"}');
    const started = Date.now();
    await expect(
      inWriteTransaction('card.create', () =>
        service().readWithModel(p, id, { instructions: 'x', schema: Counted }),
      ),
    ).rejects.toThrow(/must not run inside a write's transaction/);
    expect(Date.now() - started).toBeLessThan(200);
    expect(await readAudits(id)).toEqual([]);
  });

  it("an agent's run reads only files on records its scope reads", async () => {
    const id = await photoOnCard('Scoped');
    const run = (scopes: string[]): Principal => ({
      actor: { kind: 'agent', id: 'agent-reads' },
      actingFor: { userId: owner.id },
      subject: { kind: 'user', userId: owner.id },
      tenantId,
      roles: ['owner'],
      runId: randomUUID(),
      scopes,
    });
    await expect(service().reachable(run(['agent-run']), id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service().reachable(run(['agent-run', 'agent-run.read:card']), id),
    ).resolves.toMatchObject({ id });
  });
});

describe('limits', () => {
  it('reads per person per hour: 429 too_many_reads', async () => {
    const id = await photoOnCard('Again');
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events where action = 'file.read_by_model' and after->>'who' = $1 and at > now() - interval '1 hour'`,
      [`user:${owner.id}`],
    );
    // FILES_READ_PER_HOUR is read once per process: fill the hour to its default.
    const left = 60 - rows[0].n;
    for (let i = 0; i < left; i++)
      await pool.query(
        `insert into audit.events (action, resource_type, resource_id, actor_kind, actor_id, tenant_id, after)
         values ('file.read_by_model', 'file', $1, 'user', $2, $3, $4)`,
        [id, owner.id, tenantId, { who: `user:${owner.id}` }],
      );
    const res = await read(owner, id);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'too_many_reads' });
  });
});
