// Share links and public surfaces (B9): a member shares a record, a page or a form by an expiring,
// revocable link (its token shown once, its hash kept); a guest reads only what the link names,
// as anyone without a capability sees it (hidden fields stay hidden), through the share routes
// only; a gated link shows only its gate until the code sent to its recipient; a guest opens the
// record's PDF and accepts it (B8) as the link's contact; a shared page shows its blocks as its
// maker sees them, without their capabilities; a form link creates a record through the entity's
// own create, owned by the business and its customer, audited as the guest, never parked.
// The fixture's inquiries, baskets and agreements (fixture/src/features/share).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
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
import { shareApp } from '../fixture/dist/features/share/index.js';

const owner = new Person('Owner Share');
const staff = new Person('Staff Share');
const buyer = new Person('Customer Share');
const stranger = new Person('Stranger Share');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === owner || p === stranger ? {} : inTenant());
const phone = `9188${String(Date.now()).slice(-8)}`;
let contact = { contactId: '', customerId: '' };

/** A call with no session at all: what someone holding a link has. */
async function guest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const share = (p: Person, body: object) => p.call('POST', '/api/shares', body, as(p));
async function shared(p: Person, body: object) {
  const res = await share(p, body);
  expect(res.status).toBe(201);
  return res.body.value as Json;
}
const open = (token: string, session?: string) =>
  guest('GET', `/api/share/${token}`, undefined, session ? { 'x-share-session': session } : {});
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const audit = async (action: string, resourceId?: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, actor_id, channel from audit.events
       where action = $1 and tenant_id = $2 and ($3::text is null or resource_id = $3)
       order by at`,
      [action, tenantId, resourceId ?? null],
    )
  ).rows as { outcome: string; rule: string | null; actor_kind: string; actor_id: string }[];

/** The newest verification code sent to this number after `ask` ran. */
async function whatsappCodeAfter<T>(address: string, ask: () => Promise<T>) {
  const count = async () =>
    Number(
      (
        await pool.query(
          `select count(*) from channel.messages where template = 'verification_code_v1' and body->>'to' = $1`,
          [address],
        )
      ).rows[0].count,
    );
  const before = await count();
  const asked = await ask();
  const code = await eventually(async () => {
    if ((await count()) <= before) return undefined;
    const { rows } = await pool.query(
      `select body from channel.messages where template = 'verification_code_v1' and body->>'to' = $1
       order by at desc limit 1`,
      [address],
    );
    return rows[0]?.body?.params?.code as string | undefined;
  });
  return { asked, code: code ?? '' };
}

const inquiry = async (p: Person, body: object) => {
  const res = await p.call('POST', '/api/inquiries', body, as(p));
  expect(res.status).toBe(201);
  return res.body.value as Json;
};

beforeAll(async () => {
  await boot(shareApp);
  for (const p of [owner, staff, buyer, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  // The buyer is this business's customer, signed in to the app.
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, buyer.name, buyer.id],
  );
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, $3, $4, false)
     on conflict (tenant_id, user_id) do update set roles = excluded.roles, customer_id = excluded.customer_id`,
    [tenantId, buyer.id, ['customer'], rows[0].id],
  );
  contact = await seedContact(tenantId, 'Guest Contact', phone);
});
afterAll(shutdown);

// Each test asks for its own codes: the hourly limit counts only what this test asked for.
beforeEach(async () => {
  await pool.query(
    `update channel.otp_challenges set created_at = now() - interval '2 hours' where tenant_id = $1`,
    [tenantId],
  );
});

/* ── Making links ──────────────────────────────────────────────────────────── */

describe('making a link', () => {
  let item: Json;
  let made: Json;

  it('a member who reaches a record makes a link: its token once, its hash kept, audited', async () => {
    item = await inquiry(owner, { name: 'Tomas', score: 7 });
    made = await shared(owner, { target: { entity: 'inquiry', id: item.id }, label: 'For Tomas' });
    expect(made).toMatchObject({
      kind: 'record',
      target: { entity: 'inquiry', id: item.id },
      label: 'For Tomas',
      status: 'active',
      otp: null,
      to: null,
      uses: 0,
      createdBy: owner.id,
    });
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.path).toBe(`/share/${made.token}`);
    expect(made.url.endsWith(made.path)).toBe(true);
    // Seven days, the business's default.
    const days = (Date.parse(made.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const { rows } = await pool.query('select token_hash from app.share_links where id = $1', [
      made.id,
    ]);
    expect(rows[0].token_hash).toBe(sha(made.token));
    const events = await pool.query(
      `select after::text from audit.events where tenant_id = $1 and resource_id = $2`,
      [tenantId, made.id],
    );
    expect(events.rows.length).toBeGreaterThan(0);
    for (const r of events.rows) expect(r.after).not.toContain(made.token);
    const listed = await owner.call('GET', `/api/shares?entity=inquiry&id=${item.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([expect.objectContaining({ id: made.id })]);
    expect(JSON.stringify(listed.body)).not.toContain(made.token);
  });

  it('only people who may share, for what they reach and what is declared', async () => {
    // Staff reach their own inquiries only: the owner's is not there for them.
    const notTheirs = await share(staff, { target: { entity: 'inquiry', id: item.id } });
    expect(notTheirs.status).toBe(404);
    expect(
      (await staff.call('GET', `/api/shares?entity=inquiry&id=${item.id}`, undefined, inTenant()))
        .status,
    ).toBe(404);
    // Another business: 404.
    expect((await share(stranger, { target: { entity: 'inquiry', id: item.id } })).status).toBe(
      404,
    );
    // A customer reaches their own records but may not share them.
    const theirs = await inquiry(buyer, { name: 'Buyer asks' });
    const customer = await share(buyer, { target: { entity: 'inquiry', id: theirs.id } });
    expect(customer.status).toBe(403);
    expect(customer.body.rule).toBe('shares_create');
    expect((await audit('share.create')).some((a) => a.rule === 'shares_create')).toBe(true);
    // The assistant cannot share.
    const agent = await asAssistant(`user:${owner.id}`)('POST', '/api/shares', {
      target: { entity: 'inquiry', id: item.id },
    });
    expect(agent.status).toBe(403);
    // An entity nobody declared shareable: nothing to share.
    const task = await owner.call('POST', '/api/tasks', { title: 'Not shareable' });
    expect(
      (await share(owner, { target: { entity: 'task', id: task.body.value.id } })).status,
    ).toBe(404);
  });

  it('refuses a link too long, a code with nowhere to go, and uses on a record', async () => {
    const target = { entity: 'inquiry', id: item.id };
    const tooLong = await share(owner, { target, expiresInDays: 91 });
    expect(tooLong.body).toMatchObject({ rule: 'too_long' });
    const nowhere = await share(owner, { target, otp: 'whatsapp' });
    expect(nowhere.body).toMatchObject({ rule: 'no_whatsapp_number' });
    const uses = await share(owner, { target, maxUses: 3 });
    expect(uses.body).toMatchObject({ rule: 'uses_for_forms' });
    // The business's own limit.
    await setTenantSettings(tenantId, { shares: { defaultDays: 2, maxDays: 5 } });
    expect((await share(owner, { target, expiresInDays: 6 })).body.rule).toBe('too_long');
    const short = await shared(owner, { target });
    expect((Date.parse(short.expiresAt) - Date.now()) / 86_400_000).toBeLessThan(2.1);
    await setTenantSettings(tenantId, { shares: null });
  });
});

/* ── What a guest sees ─────────────────────────────────────────────────────── */

describe('a guest', () => {
  let item: Json;
  let link: Json;

  it('reads the record the link names, as someone without any capability sees it', async () => {
    item = await inquiry(owner, { name: 'Ines', score: 9, notes: 'Shared notes' });
    link = await shared(owner, { target: { entity: 'inquiry', id: item.id } });
    // The owner sees the score.
    expect((await owner.call('GET', `/api/inquiries/${item.id}`)).body.score).toBe(9);
    const res = await open(link.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      link: { id: link.id, kind: 'record' },
      business: { name: expect.any(String) },
      gate: null,
      record: {
        entity: 'inquiry',
        id: item.id,
        value: { id: item.id, name: 'Ines', notes: 'Shared notes' },
        children: [],
        documents: [],
      },
    });
    expect(res.body.record.value).not.toHaveProperty('score');
    const { rows } = await pool.query('select views from app.share_links where id = $1', [link.id]);
    expect(rows[0].views).toBe(1);
  });

  it('reaches nothing else: no generated route, no unknown token', async () => {
    expect((await guest('GET', `/api/inquiries/${item.id}`)).status).toBe(401);
    expect(
      (await guest('GET', `/api/inquiries/${item.id}`, undefined, { 'x-share-token': link.token }))
        .status,
    ).toBe(401);
    const unknown = await open('A'.repeat(43));
    expect(unknown.status).toBe(404);
    expect((await open('nope')).status).toBe(404);
    // A record link has no form.
    expect((await guest('POST', `/api/share/${link.token}/submit`, { values: {} })).status).toBe(
      404,
    );
  });

  it("sees a basket's items, never their cost", async () => {
    const saved = await owner.call('POST', '/api/baskets/save', {
      currency: 'EUR',
      title: 'Shared basket',
      items: [
        { ref: 'g', title: 'Group' },
        { ref: 'l', parent: 'g', title: 'Line', quantity: 2, price: '1.50', cost: '0.70' },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.value.items[1].cost).toMatchObject({ minor: 70 });
    const basket = await shared(owner, {
      target: { entity: 'basket', id: saved.body.value.basket.id },
    });
    const res = await open(basket.token);
    expect(res.status).toBe(200);
    const items = res.body.record.children[0];
    expect(items).toMatchObject({ entity: 'basketItem', truncated: false });
    expect(items.items).toHaveLength(2);
    expect(items.items[1]).toMatchObject({ title: 'Line', quantity: 2 });
    for (const i of items.items) expect(i).not.toHaveProperty('cost');
  });

  it('is refused once the link is revoked or ended, and when its record goes', async () => {
    const other = await shared(owner, { target: { entity: 'inquiry', id: item.id } });
    expect(
      (await staff.call('POST', `/api/shares/${other.id}/revoke`, {}, inTenant())).status,
    ).toBe(404);
    const revoked = await owner.call('POST', `/api/shares/${other.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.value).toMatchObject({ status: 'revoked' });
    const gone = await open(other.token);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe('link_revoked');
    await pool.query(
      `update app.share_links set expires_at = now() - interval '1 minute' where id = $1`,
      [link.id],
    );
    const ended = await open(link.token);
    expect(ended.status).toBe(410);
    expect(ended.body.error).toBe('link_expired');
    // Deleting the record revokes its links, in the same write.
    const doomed = await inquiry(owner, { name: 'Doomed' });
    const doomedLink = await shared(owner, { target: { entity: 'inquiry', id: doomed.id } });
    expect((await owner.call('DELETE', `/api/inquiries/${doomed.id}`)).status).toBe(200);
    expect((await open(doomedLink.token)).status).toBe(410);
  });
});

/* ── A gated link, its PDF and its acceptance ──────────────────────────────── */

describe('a gated link to an agreement', () => {
  let agreementId = '';
  let doc: Json;
  let link: Json;
  let session = '';

  it('is made for a contact, with a code to their WhatsApp number', async () => {
    const made = await owner.call('POST', '/api/agreements', { title: 'Lease', terms: 'Terms.' });
    agreementId = made.body.value.id;
    expect(
      (await owner.call('PATCH', `/api/agreements/${agreementId}`, { margin: '9%' })).status,
    ).toBe(200);
    // The contact's customer is the agreement's.
    await pool.query('update app.fixture_agreements set customer_id = $1 where id = $2', [
      contact.customerId,
      agreementId,
    ]);
    expect(
      (await owner.call('POST', `/api/transitions/agreements/${agreementId}/offer`, {})).status,
    ).toBe(200);
    const asked = await owner.call('POST', '/api/documents', {
      document: 'agreements.agreement',
      id: agreementId,
    });
    doc = await eventually(async () => {
      const got = await owner.call('GET', `/api/documents/${asked.body.value.id}`);
      return got.body?.status === 'ready' ? (got.body as Json) : undefined;
    });
    // Agreements may be shared for 30 days at most.
    const target = { entity: 'agreement', id: agreementId };
    expect((await share(owner, { target, expiresInDays: 31 })).body.rule).toBe('too_long');
    // The agreement's own customer: their contact's number.
    link = await shared(owner, { target, to: { recordCustomer: true }, otp: 'whatsapp' });
    expect(link).toMatchObject({
      otp: { channel: 'whatsapp', sentTo: `•••• ${phone.slice(-4)}` },
      to: { contactId: contact.contactId, customerId: contact.customerId, email: null },
    });
  });

  it('shows only its gate until the code', async () => {
    const res = await open(link.token);
    expect(res.status).toBe(200);
    expect(res.body.gate).toEqual({
      channel: 'whatsapp',
      sentTo: `•••• ${phone.slice(-4)}`,
      verified: false,
    });
    expect(res.body.record).toBeUndefined();
    const locked = await guest('GET', `/api/share/${link.token}/documents/${doc.id}`);
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe('code_required');
  });

  it('a wrong code spends an attempt; the right one opens a session for this link only', async () => {
    const { asked, code } = await whatsappCodeAfter(phone, () =>
      guest('POST', `/api/share/${link.token}/code`, {}),
    );
    expect(asked.status).toBe(200);
    expect(asked.body.value).toMatchObject({
      channel: 'whatsapp',
      sentTo: `•••• ${phone.slice(-4)}`,
    });
    expect(code).toMatch(/^\d{6}$/);
    const challengeId = asked.body.value.id;
    const wrong = await guest('POST', `/api/share/${link.token}/verify`, {
      challengeId,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('wrong_code');
    const { rows } = await pool.query('select attempts from channel.otp_challenges where id = $1', [
      challengeId,
    ]);
    expect(rows[0].attempts).toBe(1);
    const right = await guest('POST', `/api/share/${link.token}/verify`, { challengeId, code });
    expect(right.status).toBe(200);
    session = right.body.value.session;
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Used once.
    expect(
      (await guest('POST', `/api/share/${link.token}/verify`, { challengeId, code })).body.error,
    ).toBe('no_code');
    const res = await open(link.token, session);
    expect(res.body.gate.verified).toBe(true);
    expect(res.body.record).toMatchObject({
      entity: 'agreement',
      id: agreementId,
      value: { title: 'Lease', status: 'offered' },
      documents: [{ id: doc.id, document: 'agreements.agreement', acceptable: true }],
    });
    expect(res.body.record.value).not.toHaveProperty('margin');
    // Another gated link does not take this session.
    const second = await shared(owner, {
      target: { entity: 'agreement', id: agreementId },
      to: { contactId: contact.contactId },
      otp: 'whatsapp',
    });
    expect((await open(second.token, session)).body.gate.verified).toBe(false);
    expect((await audit('share.verify', link.id))[0]).toMatchObject({
      outcome: 'committed',
      actor_kind: 'guest',
      actor_id: link.id,
    });
  });

  it("opens the record's PDF, and no other record's", async () => {
    const pdf = await guest('GET', `/api/share/${link.token}/documents/${doc.id}`, undefined, {
      'x-share-session': session,
    });
    expect(pdf.status).toBe(200);
    expect(pdf.body).toMatchObject({ id: doc.id, status: 'ready', sends: [] });
    expect(typeof pdf.body.url).toBe('string');
    // A PDF of another agreement: not this link's.
    const other = await owner.call('POST', '/api/agreements', { title: 'Other', terms: 'x' });
    const otherDoc = await owner.call('POST', '/api/documents', {
      document: 'agreements.agreement',
      id: other.body.value.id,
    });
    const elsewhere = await guest(
      'GET',
      `/api/share/${link.token}/documents/${otherDoc.body.value.id}`,
      undefined,
      { 'x-share-session': session },
    );
    expect(elsewhere.status).toBe(404);
  });

  it("accepts the PDF as the link's contact, with the acceptance's own code", async () => {
    const h = { 'x-share-session': session };
    const status = await guest(
      'GET',
      `/api/share/${link.token}/acceptances/documents/${doc.id}`,
      undefined,
      h,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      can: { ok: true },
      channels: [{ channel: 'whatsapp', sentTo: `•••• ${phone.slice(-4)}` }],
    });
    const { asked, code } = await whatsappCodeAfter(phone, () =>
      guest('POST', `/api/share/${link.token}/acceptances/challenges`, { documentId: doc.id }, h),
    );
    expect(asked.status).toBe(200);
    const accepted = await guest(
      'POST',
      `/api/share/${link.token}/acceptances`,
      { challengeId: asked.body.value.id, code },
      h,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.value).toMatchObject({
      method: 'otp',
      signer: { kind: 'contact', contactId: contact.contactId, customerId: contact.customerId },
      document: { id: doc.id, sha256: doc.sha256 },
    });
    // The guest sees the evidence masked.
    expect(accepted.body.value.client).toBeUndefined();
    const { rows } = await pool.query(
      'select channel, assurance from audit.acceptances where document_id = $1',
      [doc.id],
    );
    expect(rows[0]).toEqual({ channel: 'share', assurance: 'otp' });
    expect((await owner.call('GET', `/api/agreements/${agreementId}`)).body.status).toBe(
      'accepted',
    );
    expect((await audit('acceptance.accept'))[0]).toMatchObject({
      outcome: 'committed',
      actor_kind: 'guest',
      actor_id: link.id,
    });
  });

  it('a link without a contact cannot sign', async () => {
    const plain = await shared(owner, { target: { entity: 'agreement', id: agreementId } });
    const res = await guest('GET', `/api/share/${plain.token}/acceptances/documents/${doc.id}`);
    expect(res.status).toBe(200);
    expect(res.body.can).toMatchObject({ ok: false, rule: 'people_only' });
  });
});

/* ── A shared page ─────────────────────────────────────────────────────────── */

describe('a shared page', () => {
  it("shows its blocks as its maker sees them, without the maker's capabilities", async () => {
    await inquiry(owner, { name: 'Paged', score: 5 });
    const mine = await inquiry(staff, { name: 'Staff paged' });
    await owner.call('POST', '/api/tasks', { title: 'A task on the page' });
    const spec = {
      title: 'Inquiries',
      blocks: [
        { id: 'inquiries', view: 'inquiry.list', query: {} },
        { id: 'tasks', view: 'task.list', query: {} },
      ],
    };
    const page = await owner.call('POST', '/api/pages', { name: 'Shared page', spec });
    expect(page.status).toBe(201);
    const link = await shared(owner, { target: { page: page.body.value.id } });
    const res = await open(link.token);
    expect(res.status).toBe(200);
    expect(res.body.page).toMatchObject({ name: 'Shared page', layout: 'stack' });
    // Tasks are not shareable: left out.
    expect(res.body.page.blocks.map((b: Json) => b.id)).toEqual(['inquiries']);
    const items = res.body.page.blocks[0].data.items as Json[];
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(['Paged', 'Staff paged']));
    for (const i of items) expect(i).not.toHaveProperty('score');
    // Staff's own page reaches only staff's own inquiries.
    const staffPage = await staff.call(
      'POST',
      '/api/pages',
      { name: 'Staff page', spec },
      inTenant(),
    );
    const staffLink = await shared(staff, { target: { page: staffPage.body.value.id } });
    const theirs = (await open(staffLink.token)).body.page.blocks[0].data.items as Json[];
    expect(theirs.map((i) => i.id)).toEqual([mine.id]);
    // A page nobody else reaches cannot be shared by them.
    expect((await share(staff, { target: { page: page.body.value.id } })).status).toBe(404);
    // The maker gone from the business: the link reaches nothing.
    await pool.query('delete from app.memberships where tenant_id = $1 and user_id = $2', [
      tenantId,
      staff.id,
    ]);
    expect((await open(staffLink.token)).status).toBe(410);
    await addMember(staff, tenantId, ['staff']);
  });
});

/* ── A form link ───────────────────────────────────────────────────────────── */

describe('a form link', () => {
  let link: Json;
  let created = '';

  it("asks the form's fields and the business's own, in its words", async () => {
    const field = await owner.call('POST', '/api/custom-fields', {
      entity: 'inquiry',
      key: 'budgetBand',
      type: 'select',
      label: { en: 'Budget' },
      options: ['low', 'high'],
    });
    expect(field.status).toBe(201);
    link = await shared(owner, { target: { form: 'inquiries.inquiry' }, maxUses: 2 });
    expect(link).toMatchObject({ kind: 'form', target: { form: 'inquiries.inquiry' }, maxUses: 2 });
    const res = await open(link.token);
    expect(res.status).toBe(200);
    expect(res.body.form).toMatchObject({
      name: 'inquiries.inquiry',
      entity: 'inquiry',
      label: { en: 'Ask us' },
      remaining: 2,
    });
    const byKey = Object.fromEntries(res.body.form.fields.map((f: Json) => [f.key, f]));
    expect(Object.keys(byKey)).toEqual([
      'name',
      'topic',
      'guests',
      'wanted',
      'notes',
      'urgent',
      'budgetBand',
    ]);
    expect(byKey.name).toMatchObject({ type: 'text', required: true, label: { en: 'Your name' } });
    expect(byKey.topic).toMatchObject({
      type: 'select',
      required: false,
      options: ['general', 'pricing', 'review'],
    });
    expect(byKey.guests).toMatchObject({ type: 'integer', min: 1, max: 50 });
    expect(byKey.wanted).toMatchObject({ type: 'date' });
    expect(byKey.notes).toMatchObject({ type: 'longText', max: 1000 });
    expect(byKey.urgent).toMatchObject({ type: 'boolean' });
    expect(byKey.budgetBand).toMatchObject({
      type: 'select',
      custom: true,
      options: ['low', 'high'],
    });
  });

  it('an answer is a new record owned by the business, for a new customer, audited as the guest', async () => {
    expect(
      (await guest('POST', `/api/share/${link.token}/submit`, { values: { topic: 'pricing' } }))
        .status,
    ).toBe(400);
    const res = await guest('POST', `/api/share/${link.token}/submit`, {
      // Only what the form asks: the score and the source are not the guest's to set.
      values: { name: 'Asha', topic: 'pricing', guests: 3, score: 99, source: 'mine' },
      custom: { budgetBand: 'high' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      status: 'done',
      value: { entity: 'inquiry', id: expect.any(String) },
    });
    created = res.body.value.id;
    const { rows } = await pool.query(
      `select i.owner_id, i.source, i.score, i.custom, c.display_name
       from app.fixture_inquiries i join app.customers c on c.id = i.customer_id where i.id = $1`,
      [created],
    );
    expect(rows[0]).toEqual({
      owner_id: owner.id,
      source: 'form',
      score: null,
      custom: { budgetBand: 'high' },
      display_name: 'Asha',
    });
    expect((await audit('inquiry.create', created))[0]).toMatchObject({
      outcome: 'committed',
      actor_kind: 'guest',
      actor_id: link.id,
      channel: 'share',
    });
    expect((await audit('customer.create')).length).toBeGreaterThan(0);
    // The team reads it; the guest learnt nothing but its id.
    expect((await owner.call('GET', `/api/inquiries/${created}`)).body).toMatchObject({
      name: 'Asha',
      topic: 'pricing',
    });
  });

  it('never waits for an approval: refused, audited, not counted', async () => {
    const res = await guest('POST', `/api/share/${link.token}/submit`, {
      values: { name: 'Reviewer', topic: 'review' },
    });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('guest_cannot_wait');
    const refused = (await audit('inquiry.create')).filter((a) => a.rule === 'guest_cannot_wait');
    expect(refused[0]).toMatchObject({ outcome: 'denied', actor_kind: 'guest' });
    const { rows } = await pool.query('select uses from app.share_links where id = $1', [link.id]);
    expect(rows[0].uses).toBe(1);
    expect(
      Number(
        (
          await pool.query(
            'select count(*) from app.approvals where tenant_id = $1 and action = $2',
            [tenantId, 'inquiry.create'],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  });

  it('takes its uses, then no more', async () => {
    const second = await guest('POST', `/api/share/${link.token}/submit`, {
      values: { name: 'Ben' },
    });
    expect(second.status).toBe(201);
    const third = await guest('POST', `/api/share/${link.token}/submit`, {
      values: { name: 'Cy' },
    });
    expect(third.status).toBe(410);
    expect(third.body.error).toBe('link_used');
    expect(
      (await owner.call('GET', `/api/shares?form=inquiries.inquiry`)).body.items[0],
    ).toMatchObject({
      id: link.id,
      status: 'used',
      uses: 2,
    });
  });

  it("an answer through a contact's link is that contact's customer's", async () => {
    const theirs = await shared(owner, {
      target: { form: 'inquiries.inquiry' },
      to: { contactId: contact.contactId },
    });
    const res = await guest('POST', `/api/share/${theirs.token}/submit`, {
      values: { name: 'From the contact' },
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      'select customer_id from app.fixture_inquiries where id = $1',
      [res.body.value.id],
    );
    expect(rows[0].customer_id).toBe(contact.customerId);
  });

  it('a form that must be gated, briefly', async () => {
    const target = { form: 'inquiries.private' };
    expect((await share(owner, { target })).body.rule).toBe('code_needed');
    expect(
      (
        await share(owner, {
          target,
          to: { email: 'gate@example.test' },
          otp: 'email',
          expiresInDays: 4,
        })
      ).body.rule,
    ).toBe('too_long');
    const gated = await shared(owner, { target, to: { email: 'gate@example.test' }, otp: 'email' });
    expect(gated.otp).toMatchObject({ channel: 'email', sentTo: 'g•••@example.test' });
    const locked = await guest('POST', `/api/share/${gated.token}/submit`, {
      values: { name: 'X' },
    });
    expect(locked.status).toBe(401);
  });
});
