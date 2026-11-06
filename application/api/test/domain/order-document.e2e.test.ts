// The orders module's PDF (orders.order, B2): an order's groups, lines, tax and totals in
// English, Hindi or Telugu, never its cost; opened by every colleague who reads the order and by
// nobody outside the business; made and sent by the scripted assistant (to yourself at once, to
// anyone else after approval). Tests draw with the fake engine (vitest.config.ts); the real
// engine draws the same layout here once.
import { createPdfEngine, documents, layoutOf } from '@hykr/api';
import { addMember, boot, eventually, me, Person, pool, server, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Order Docs');
const staff = new Person('Staff Order Docs');
const ops = new Person('Ops Order Docs');
const stranger = new Person('Stranger Order Docs');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const rooms = [
  { ref: 'k', kind: 'group', title: 'Kitchen' },
  {
    ref: 'k1',
    parent: 'k',
    title: 'Cabinet',
    quantity: 2,
    unitPrice: '1500.00',
    taxRateBp: 1800,
    cost: '987.65',
  },
  { ref: 'k2', parent: 'k', title: 'Sink', quantity: 1, unitPrice: '800.50', taxRateBp: 1200 },
];

let order: { id: string; number: string };

const render = (p: Person, id: string, lang?: string, headers: Record<string, string> = {}) =>
  p.call(
    'POST',
    '/api/documents',
    { document: 'orders.order', id, ...(lang ? { lang } : {}) },
    headers,
  );
const ready = (p: Person, id: string, headers: Record<string, string> = {}) =>
  eventually(async () => {
    const got = await p.call('GET', `/api/documents/${id}`, undefined, headers);
    return got.body?.status === 'ready' ? got.body : undefined;
  });
/** A document's PDF, through its short-lived URL. */
async function pdfText(url: string) {
  const res = await fetch(url.startsWith('/') ? `${server.base}${url}` : url);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  return Buffer.from(await res.arrayBuffer()).toString('utf8');
}

async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  return ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, staff, ops, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(ops, tenantId, ['ops']);
  await pool.query(`update app.tenants set settings = settings || $2::jsonb where id = $1`, [
    tenantId,
    JSON.stringify({ money: { currency: 'INR', fyStartMonth: 4 } }),
  ]);
  const saved = await owner.call('POST', '/api/orders/save', { title: 'Flat 4B', items: rooms });
  expect(saved.status).toBe(200);
  order = saved.body.value.order;
});
afterAll(shutdown);

describe("an order's PDF", () => {
  let english: { id: string; url: string };

  it('shows its number, groups, lines, tax and totals; never what a line costs', async () => {
    const asked = await render(owner, order.id);
    expect(asked.status).toBe(200);
    expect(asked.body.value).toMatchObject({
      document: 'orders.order',
      name: `${order.number.replaceAll('/', '-')}.pdf`,
      status: 'pending',
    });
    english = await ready(owner, asked.body.value.id);
    const text = await pdfText(english.url);
    for (const words of [
      `Order ${order.number}`,
      'Kitchen',
      '  Cabinet | 2 | ₹1,500.00 | ₹3,000.00',
      'Sink',
      'Subtotal: ₹3,800.50',
      'Tax 12%: ₹96.06',
      'Tax 18%: ₹540.00',
      'Total: ₹4,436.56',
      'Status: Open',
    ])
      expect(text).toContain(words);
    expect(text).not.toContain('987.65');
    // Not in the stored snapshot either: the owner sees cost, but the document never reads it.
    const { rows } = await pool.query('select data from app.documents where id = $1', [english.id]);
    expect(JSON.stringify(rows[0].data)).not.toContain('cost');
  });

  it('in Hindi and Telugu', async () => {
    const hi = await ready(owner, (await render(owner, order.id, 'hi')).body.value.id);
    const hiText = await pdfText(hi.url);
    for (const words of [`ऑर्डर ${order.number}`, 'कुल: ₹4,436.56', 'स्थिति: खुला'])
      expect(hiText).toContain(words);
    const te = await ready(owner, (await render(owner, order.id, 'te')).body.value.id);
    expect(await pdfText(te.url)).toContain(`ఆర్డర్ ${order.number}`);
  });

  it('every colleague who reads the order opens every copy; others, none', async () => {
    // Ops read the whole business but not cost: the PDF shows none, so they open the owner's.
    expect(
      (await ops.call('GET', `/api/documents/${english.id}`, undefined, inTenant())).status,
    ).toBe(200);
    // Staff read only their own orders, so not this one's documents.
    expect(
      (await staff.call('GET', `/api/documents/${english.id}`, undefined, inTenant())).status,
    ).toBe(404);
    expect((await stranger.call('GET', `/api/documents/${english.id}`)).status).toBe(404);
    expect((await render(stranger, order.id)).status).toBe(404);
    const theirs = await stranger.call('GET', `/api/documents?entity=order&id=${order.id}`);
    expect(theirs.body.items).toEqual([]);
  });

  it('the real engine draws the same layout in Telugu: a PDF with its fonts', async () => {
    const { rows } = await pool.query('select data, lang from app.documents where id = $1', [
      english.id,
    ]);
    const def = documents.get('orders.order');
    if (!def) throw new Error('orders.order is not declared');
    const layout = layoutOf(def, rows[0].data.value, 'te', rows[0].data.business);
    const { bytes, pages } = await createPdfEngine().render(layout, {
      lang: 'te',
      createdAt: new Date(),
    });
    const raw = bytes.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansTelugu/);
    expect(pages).toBe(1);
  }, 30_000);
});

describe('the assistant and an order’s PDF', () => {
  it('makes one in the turn’s language', async () => {
    const said = await owner.chat(`pdf of order ${order.number}`);
    expect(said.body.reply).toBe(`Making ${order.number.replaceAll('/', '-')}.pdf.`);
    expect((await owner.chat('pdf of order ORD/1999-00/9999')).body.reply).toBe(
      'There is no order ORD/1999-00/9999.',
    );
  });

  it('sends it to the person themself at once, by email with the PDF', async () => {
    const said = await owner.chat(`send order ${order.number} to me`);
    expect(said.body.reply).toBe(`Sending order ${order.number} to you.`);
    const mail = await eventually(async () =>
      (await mailTo(owner.email)).find((m) => m.Subject === `Order ${order.number}`),
    );
    const res = await fetch(`http://localhost:8025/api/v1/message/${mail.ID}`);
    const full = (await res.json()) as { Text: string; Attachments: { FileName: string }[] };
    expect(full.Attachments.map((a) => a.FileName)).toEqual([
      `${order.number.replaceAll('/', '-')}.pdf`,
    ]);
    expect(full.Text).toContain(`Your order ${order.number}, for ₹4,436.56, is attached.`);
  });

  it('sending it to anyone else waits for the owner', async () => {
    const said = await owner.chat(`email order ${order.number} to buyer@example.test`);
    expect(said.body.reply).toMatch(
      /^I've asked for your approval: Send ORD-.*\.pdf to buyer@example\.test by email/,
    );
  });
});
