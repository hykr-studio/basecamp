// Acceptance by one-time code (B8): a customer accepts an offered agreement's PDF with a code sent
// to their own email or WhatsApp number; the acceptance binds the PDF's hash and the record's
// version, moves the record to `accepted` (frozen), and leaves an append-only, hash-chained
// evidence row (IP, user agent, device, where the code went, when). Codes spend an attempt per
// guess, are used once, expire, and are limited per person. Another business gets 404, colleagues
// who reach the record cannot sign and see the evidence without the address or the request, the
// assistant cannot ask or accept, and refusals are audited. A summary is signed at the fixture's
// e-sign provider instead. The fixture's `agreements` (fixture/src/features/acceptance).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The API's entry is loaded in beforeAll, after boot sets the runtime.
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
  server,
  shutdown,
} from '../../dist/testing.js';
import { acceptanceApp, esignStarts } from '../fixture/dist/features/acceptance/index.js';

const owner = new Person('Owner Accept');
const staff = new Person('Staff Accept');
const buyer = new Person('Customer Accept');
const signer = new Person('Signer Accept');
const stranger = new Person('Stranger Accept');
let tenantId = '';
let customerId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => (p === owner || p === stranger ? {} : inTenant());
const buyerPhone = `9177${String(Date.now()).slice(-8)}`;

const service = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(api.AcceptanceService, { strict: false });
};

beforeAll(async () => {
  api = await import('../../dist/index.js');
  await boot(acceptanceApp);
  for (const p of [owner, staff, buyer, signer, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(signer, tenantId, ['fixture_signer']);
  // The buyer is this business's customer, signed in to the app.
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, buyer.name, buyer.id],
  );
  customerId = rows[0].id;
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, $3, $4, false)
     on conflict (tenant_id, user_id) do update set roles = excluded.roles, customer_id = excluded.customer_id`,
    [tenantId, buyer.id, ['customer'], customerId],
  );
});
afterAll(shutdown);

// Each test asks for its own codes: the hourly limit counts only what this test asked for.
beforeEach(async () => {
  await pool.query(
    `update channel.otp_challenges set created_at = now() - interval '2 hours'
     where user_id = any($1::text[])`,
    [[buyer.id, signer.id, staff.id]],
  );
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** An agreement the buyer asked for, its margin set by the owner, offered to them. */
async function offered(name: string, opts: { offer?: boolean } = {}) {
  const made = await buyer.call(
    'POST',
    '/api/agreements',
    { title: name, terms: 'Terms.' },
    as(buyer),
  );
  expect(made.status).toBe(201);
  const id = made.body.value.id as string;
  expect((await owner.call('PATCH', `/api/agreements/${id}`, { margin: '12%' })).status).toBe(200);
  if (opts.offer !== false) await move(owner, id, 'offer');
  return id;
}
async function move(p: Person, id: string, name: string) {
  const res = await p.call('POST', `/api/transitions/agreements/${id}/${name}`, {}, as(p));
  expect(res.status).toBe(200);
  return res.body.value;
}
const agreement = async (id: string) =>
  (await owner.call('GET', `/api/agreements/${id}`)).body as Json;

/** A PDF of the agreement, made (the owner asks for it). */
async function pdf(id: string, document = 'agreements.agreement') {
  const res = await owner.call('POST', '/api/documents', { document, id });
  expect(res.status).toBe(200);
  return eventually(async () => {
    const got = await owner.call('GET', `/api/documents/${res.body.value.id}`);
    return got.body?.status === 'ready' ? (got.body as Json) : undefined;
  });
}

const status = (p: Person, documentId: string) =>
  p.call('GET', `/api/acceptances/documents/${documentId}`, undefined, as(p));
const challenge = (p: Person, documentId: string, channel?: string) =>
  p.call(
    'POST',
    '/api/acceptances/challenges',
    { documentId, ...(channel ? { channel } : {}) },
    as(p),
  );
const accept = (
  p: Person,
  challengeId: string,
  code: string,
  extra: object = {},
  headers: Record<string, string> = {},
) => p.call('POST', '/api/acceptances', { challengeId, code, ...extra }, { ...as(p), ...headers });
const other = (code: string) => (code === '000000' ? '111111' : '000000');

/** Mailpit's verification emails to this address, newest first. */
async function mails(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
  return messages.filter((m) => /verification code/.test(m.Subject)).map((m) => m.ID);
}

/** Run `ask`, then wait for a verification email that was not there before it, and its code. */
async function emailedAfter<T>(email: string, ask: () => Promise<T>) {
  const before = new Set(await mails(email));
  const asked = await ask();
  const code = await eventually(async () => {
    const fresh = (await mails(email)).find((id) => !before.has(id));
    if (!fresh) return undefined;
    const body = (await (await fetch(`http://localhost:8025/api/v1/message/${fresh}`)).json()) as {
      Text: string;
    };
    return /(\d{6}) is your verification code/.exec(body.Text)?.[1];
  });
  return { asked, code };
}

/** The code in the verification_code_v1 message to this number, made by the worker. */
async function whatsappCode(address: string) {
  return eventually(async () => {
    const { rows } = await pool.query(
      `select body from channel.messages
       where template = 'verification_code_v1' and body->>'to' = $1
       order by at desc limit 1`,
      [address],
    );
    return rows[0]?.body?.params?.code as string | undefined;
  });
}

/** Ask for a code by email and wait for it. */
async function emailed(p: Person, documentId: string) {
  const { asked, code } = await emailedAfter(p.email, () => challenge(p, documentId, 'email'));
  expect(asked.status).toBe(200);
  return { id: asked.body.value.id as string, code };
}

/** The promise's answer, or a failure after `ms`: an API that hangs answers nothing. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const audit = async (action: string, resourceId?: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, actor_id from audit.events
       where action = $1 and tenant_id = $2 and ($3::text is null or resource_id = $3)
       order by at`,
      [action, tenantId, resourceId ?? null],
    )
  ).rows as { action: string; outcome: string; rule: string | null; actor_id: string }[];

/* ── Accepting by code ─────────────────────────────────────────────────────── */

describe('accepting a PDF by a code', () => {
  let id: string;
  let doc: Json;
  let accepted: Json;

  it('shows what is accepted, where the code would go, and that they may', async () => {
    id = await offered('Plan A');
    doc = await pdf(id);
    expect(doc.recordVersion).toBe((await agreement(id)).version);
    const res = await status(buyer, doc.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      acceptance: 'agreements.agreement',
      document: { id: doc.id, version: 1, sha256: doc.sha256 },
      statement: 'I accept the agreement Plan A as shown in this PDF.',
      can: { ok: true },
      accepted: [],
    });
    // Email only: no number is linked to them here. Masked.
    expect(res.body.channels).toEqual([
      { channel: 'email', sentTo: expect.stringMatching(/^c•••@test\.local$/) },
    ]);
  });

  it('a code goes to their own email; a wrong one spends an attempt, the right one accepts', async () => {
    const { asked, code } = await emailedAfter(buyer.email, () => challenge(buyer, doc.id));
    expect(asked.status).toBe(200);
    expect(asked.body.value).toMatchObject({
      documentId: doc.id,
      channel: 'email',
      statement: 'I accept the agreement Plan A as shown in this PDF.',
    });
    expect(asked.body.value.sentTo).not.toContain(buyer.email);
    expect(code).toMatch(/^\d{6}$/);
    // Only the hash is kept.
    const { rows } = await pool.query(
      'select code_hash, binding from channel.otp_challenges where id = $1',
      [asked.body.value.id],
    );
    expect(rows[0].code_hash).not.toContain(code);
    expect(rows[0].binding).toMatchObject({ documentId: doc.id, sha256: doc.sha256 });

    const wrong = await accept(buyer, asked.body.value.id, other(code ?? ''));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('wrong_code');
    const right = await accept(buyer, asked.body.value.id, code ?? '', {
      device: { platform: 'web', appVersion: '1.2.3' },
    });
    expect(right.status).toBe(200);
    accepted = right.body.value;
    expect(accepted).toMatchObject({
      acceptance: 'agreements.agreement',
      method: 'otp',
      record: { entity: 'agreement', id, version: doc.recordVersion },
      document: { id: doc.id, sha256: doc.sha256, version: 1 },
      statement: 'I accept the agreement Plan A as shown in this PDF.',
      signer: { kind: 'user', userId: buyer.id, customerId, name: buyer.name },
      otp: { channel: 'email', sentTo: expect.stringMatching(/•••/) },
      seq: 1,
      prevHash: null,
    });
    // The signer sees neither the request nor the full address; nothing of the record's.
    expect(accepted.client).toBeUndefined();
    expect(accepted.otp.address).toBeUndefined();
    expect(JSON.stringify(right.body)).not.toContain('12%');
    const { rows: tries } = await pool.query(
      'select attempts, consumed_at from channel.otp_challenges where id = $1',
      [asked.body.value.id],
    );
    expect(tries[0].attempts).toBe(2);
    expect(tries[0].consumed_at).not.toBeNull();
  });

  it('the record moved along its transition and is frozen', async () => {
    const now = await agreement(id);
    expect(now.status).toBe('accepted');
    expect(now.version).toBe(doc.recordVersion + 1);
    const edit = await owner.call('PATCH', `/api/agreements/${id}`, { title: 'Changed' });
    expect(edit.status).toBe(403);
    expect(edit.body.rule).toBe('record_frozen');
    // Nobody moves it there by hand.
    const direct = await owner.call('POST', `/api/transitions/agreements/${id}/accept`, {});
    expect(direct.status).toBe(403);
  });

  it('a code is used once', async () => {
    const [{ id: challengeId }] = (
      await pool.query('select id from channel.otp_challenges where resource_id = $1', [id])
    ).rows;
    const again = await accept(buyer, challengeId, '123456');
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('no_code');
  });

  it('is audited and stored as events, as the signer', async () => {
    expect(await audit('acceptance.accept')).toEqual([
      expect.objectContaining({ outcome: 'committed', rule: 'signer_accepts', actor_id: buyer.id }),
    ]);
    expect(await audit('acceptance.create', accepted.id)).toHaveLength(1);
    // The record's move, audited as the signer's write (the owner's refused edit came after).
    const updates = (await audit('agreement.update', id)).filter((r) => r.outcome === 'committed');
    expect(updates.at(-1)).toMatchObject({ actor_id: buyer.id });
    expect((await audit('acceptance.challenge', doc.id))[0]).toMatchObject({
      outcome: 'committed',
    });
    const { rows } = await pool.query(
      `select name, row from app.domain_events where tenant_id = $1 and name in
       ('acceptance.recorded', 'agreement.accept', 'agreement.followup', 'otp.requested')
       order by occurred_at, name`,
      [tenantId],
    );
    expect(rows.map((r) => r.name)).toEqual([
      'otp.requested',
      'acceptance.recorded',
      'agreement.accept',
      'agreement.followup',
    ]);
    // Ids, never the code or the address.
    expect(JSON.stringify(rows[0].row)).not.toContain(buyer.email);
    expect(rows[1].row).toMatchObject({ id: accepted.id, sha256: doc.sha256, documentId: doc.id });
    // The application's `accepted` ran in the same write, after the record moved.
    expect(rows[3].row).toMatchObject({ id, acceptanceId: accepted.id, status: 'accepted' });
  });

  it('the business sees the full evidence; colleagues see it masked', async () => {
    const full = await owner.call('GET', `/api/acceptances/${accepted.id}`);
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({
      verified: true,
      otp: { address: buyer.email },
      client: {
        ip: expect.any(String),
        userAgent: expect.any(String),
        device: { platform: 'web', appVersion: '1.2.3' },
      },
    });
    const masked = await staff.call(
      'GET',
      `/api/acceptances?entity=agreement&id=${id}`,
      undefined,
      as(staff),
    );
    expect(masked.status).toBe(200);
    expect(masked.body.items).toHaveLength(1);
    expect(masked.body.items[0].client).toBeUndefined();
    expect(masked.body.items[0].otp.address).toBeUndefined();
    expect(masked.body.items[0].signer.name).toBe(buyer.name);
    const listed = await status(buyer, doc.id);
    expect(listed.body.can).toMatchObject({ ok: false, rule: 'already_accepted' });
    expect(listed.body.accepted.map((a: Json) => a.id)).toEqual([accepted.id]);
  });

  it('another business reaches nothing of it', async () => {
    for (const path of [
      `/api/acceptances/${accepted.id}`,
      `/api/acceptances?entity=agreement&id=${id}`,
      `/api/acceptances/documents/${doc.id}`,
    ])
      expect((await stranger.call('GET', path)).status).toBe(404);
    expect((await challenge(stranger, doc.id)).status).toBe(404);
    expect((await accept(stranger, accepted.id, '123456')).status).toBe(404);
  });

  it('the evidence is append-only', async () => {
    await expect(
      pool.query(`update audit.acceptances set statement = 'other' where id = $1`, [accepted.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('delete from audit.acceptances where id = $1', [accepted.id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('truncate audit.acceptances')).rejects.toThrow(/append-only/);
    expect(await service().verifyChain(tenantId)).toEqual({ ok: true, rows: 1, brokenAt: null });
  });
});

describe('a code by WhatsApp', () => {
  it('goes to the number linked to them, and the next acceptance chains to the last', async () => {
    const id = await offered('Plan B');
    const doc = await pdf(id);
    const none = await challenge(buyer, doc.id, 'whatsapp');
    expect(none.status).toBe(403);
    expect(none.body.rule).toBe('no_whatsapp_number');
    await pool.query(
      `insert into channel.contacts (tenant_id, address, user_id, linked_at) values ($1, $2, $3, now())`,
      [tenantId, buyerPhone, buyer.id],
    );
    expect((await status(buyer, doc.id)).body.channels).toEqual([
      { channel: 'email', sentTo: expect.any(String) },
      { channel: 'whatsapp', sentTo: `•••• ${buyerPhone.slice(-4)}` },
    ]);
    const asked = await challenge(buyer, doc.id, 'whatsapp');
    expect(asked.status).toBe(200);
    expect(asked.body.value.channel).toBe('whatsapp');
    const code = await whatsappCode(buyerPhone);
    const done = await accept(buyer, asked.body.value.id, code ?? '');
    expect(done.status).toBe(200);
    expect(done.body.value).toMatchObject({ otp: { channel: 'whatsapp' }, seq: 2 });
    const first = (
      await pool.query('select hash from audit.acceptances where tenant_id = $1 and seq = 1', [
        tenantId,
      ])
    ).rows[0];
    expect(done.body.value.prevHash).toBe(first.hash);
    expect(await service().verifyChain(tenantId)).toMatchObject({ ok: true, rows: 2 });
  });
});

describe('refusals', () => {
  it('a colleague who reaches the record is not its signer, and is audited as refused', async () => {
    const id = await offered('Plan C');
    const doc = await pdf(id);
    const res = await challenge(staff, doc.id);
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('not_signer');
    expect((await audit('acceptance.challenge', doc.id)).at(-1)).toMatchObject({
      outcome: 'denied',
      rule: 'not_signer',
      actor_id: staff.id,
    });
    expect((await status(staff, doc.id)).body).toMatchObject({
      can: { ok: false, rule: 'not_signer' },
      channels: [],
    });
  });

  it('the assistant can neither ask for a code nor accept', async () => {
    const id = await offered('Plan D');
    const doc = await pdf(id);
    const assistant = asAssistant(`user:${buyer.id}`, { 'x-tenant-id': tenantId });
    const asked = await assistant('POST', '/api/acceptances/challenges', { documentId: doc.id });
    expect(asked.status).toBe(403);
    expect(asked.body.rule).toBe('humans_only');
    const accepted = await assistant('POST', '/api/acceptances', {
      challengeId: doc.id,
      code: '123456',
    });
    expect(accepted.status).toBe(403);
  });

  it('a PDF made before the record last changed is stale', async () => {
    const id = await offered('Plan E', { offer: false });
    const early = await pdf(id);
    await move(owner, id, 'offer');
    const res = await challenge(buyer, early.id);
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('document_stale');
    // A draft cannot be accepted at all.
    const draft = await offered('Plan E2', { offer: false });
    const draftPdf = await pdf(draft);
    expect((await challenge(buyer, draftPdf.id)).body.rule).toBe('not_from_state');
  });

  it('a record that moved after the code was sent is not accepted', async () => {
    const id = await offered('Plan F');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    await move(owner, id, 'withdraw');
    const res = await accept(buyer, challengeId, code ?? '');
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('record_changed');
    expect((await agreement(id)).status).toBe('withdrawn');
    expect(
      (
        await pool.query(
          'select count(*)::int as n from audit.acceptances where resource_id = $1',
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('guesses spend the attempts, even all at once; an expired code is refused', async () => {
    const id = await offered('Plan G');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    const guesses = await Promise.all(
      Array.from({ length: 8 }, () => accept(buyer, challengeId, other(code ?? ''))),
    );
    expect(guesses.every((g) => g.status === 400)).toBe(true);
    const late = await accept(buyer, challengeId, code ?? '');
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('no_code');

    const fresh = await emailed(buyer, doc.id);
    await pool.query(
      `update channel.otp_challenges set expires_at = now() - interval '1 minute' where id = $1`,
      [fresh.id],
    );
    const expired = await accept(buyer, fresh.id, fresh.code ?? '');
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe('no_code');
  });

  it('more guesses at once than the pool has connections leave the API answering', async () => {
    const id = await offered('Plan G2');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    // The API's pool has 10 connections. A guess spent inside the write's transaction held one
    // while it waited for another, so this many at once left none for anybody (60 did not always
    // overlap enough to show it; 200 did).
    const guesses = await within(
      20_000,
      '200 guesses at once',
      Promise.all(Array.from({ length: 200 }, () => accept(buyer, challengeId, other(code ?? '')))),
    );
    expect(guesses.every((g) => g.status === 400)).toBe(true);
    expect(guesses.filter((g) => g.body.error === 'wrong_code')).toHaveLength(5);
    const { rows } = await pool.query(
      'select attempts, consumed_at from channel.otp_challenges where id = $1',
      [challengeId],
    );
    expect(rows[0]).toMatchObject({ attempts: 5, consumed_at: null });
    // Wrong guesses never reach the write: nothing of theirs is audited.
    expect(await audit('acceptance.accept', doc.id)).toEqual([]);
    const read = await within(5_000, 'a later read', owner.call('GET', `/api/agreements/${id}`));
    expect(read.status).toBe(200);
  });

  it('many right guesses at once accept once', async () => {
    const id = await offered('Plan G3');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    const tries = await within(
      20_000,
      '30 right guesses at once',
      Promise.all(Array.from({ length: 30 }, () => accept(buyer, challengeId, code ?? ''))),
    );
    expect(tries.filter((t) => t.status === 200)).toHaveLength(1);
    // The rest: no attempt left or used (400), or the record moved under them (403).
    expect(tries.every((t) => t.status === 200 || t.status === 400 || t.status === 403)).toBe(true);
    const { rows } = await pool.query(
      'select count(*)::int as n from audit.acceptances where resource_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(1);
    expect((await agreement(id)).status).toBe('accepted');
  });

  it('a repeat of an accepted request (its idempotency key) answers as it did', async () => {
    const id = await offered('Plan G4');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    const key = { 'idempotency-key': `accept-${challengeId}` };
    const first = await accept(buyer, challengeId, code ?? '', {}, key);
    expect(first.status).toBe(200);
    const again = await accept(buyer, challengeId, code ?? '', {}, key);
    expect(again.status).toBe(200);
    expect(again.body.value.id).toBe(first.body.value.id);
    // Another key is another request: the code is used.
    const fresh = await accept(
      buyer,
      challengeId,
      code ?? '',
      {},
      { 'idempotency-key': `new-${challengeId}` },
    );
    expect(fresh.status).toBe(400);
    expect(fresh.body.error).toBe('no_code');
    const { rows } = await pool.query('select attempts from channel.otp_challenges where id = $1', [
      challengeId,
    ]);
    expect(rows[0].attempts).toBe(1);
  });

  it('at most 5 codes an hour per person', async () => {
    const id = await offered('Plan H');
    const doc = await pdf(id);
    for (let i = 0; i < 5; i++) expect((await challenge(buyer, doc.id)).status).toBe(200);
    const sixth = await challenge(buyer, doc.id);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too_many_codes');
  });

  it('a read projector on acceptances runs on every read', async () => {
    const id = await offered('[private] Plan I');
    const doc = await pdf(id);
    const { id: challengeId, code } = await emailed(buyer, doc.id);
    const done = await accept(buyer, challengeId, code ?? '');
    expect(done.status).toBe(200);
    expect(done.body.value.statement).toBe('[hidden]');
    const seen = await staff.call(
      'GET',
      `/api/acceptances?entity=agreement&id=${id}`,
      undefined,
      as(staff),
    );
    expect(seen.body.items[0].statement).toBe('[hidden]');
    const full = await owner.call('GET', `/api/acceptances/${done.body.value.id}`);
    expect(full.body.statement).toContain('[private] Plan I');
  });
});

describe('signing at an e-sign provider', () => {
  let id: string;
  let summary: Json;
  let ref = '';

  it('starts a signing there for a capability holder, with the PDF', async () => {
    id = await offered('Plan J');
    summary = await pdf(id, 'agreements.summary');
    const noCodes = await challenge(signer, summary.id);
    expect(noCodes.body.rule).toBe('no_codes');
    expect((await challenge(buyer, summary.id)).body.rule).toBe('not_signer');
    const res = await signer.call(
      'POST',
      '/api/acceptances/esign',
      { documentId: summary.id },
      as(signer),
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({
      provider: 'fixture-esign',
      url: expect.stringMatching(/^https:\/\/esign\.invalid\//),
    });
    ref = res.body.value.ref;
    const started = esignStarts.at(-1);
    expect(started?.bytes).toBeGreaterThan(0);
    expect(started?.request).toMatchObject({
      tenantId,
      acceptance: 'agreements.summary',
      document: { id: summary.id, sha256: summary.sha256 },
      signer: { name: signer.name, email: signer.email },
      statement: 'I sign the summary of Plan J.',
    });
  });

  it("records the provider's verified result as evidence; the record stays where it is", async () => {
    const done = await service().completeESign({
      provider: 'fixture-esign',
      ref,
      status: 'signed',
      certificate: { transaction: 'T-1' },
      signedSha256: 'f'.repeat(64),
    });
    expect(done).toMatchObject({ method: 'esign', esign: { provider: 'fixture-esign', ref } });
    const full = await owner.call('GET', `/api/acceptances/${done?.id}`);
    expect(full.body).toMatchObject({
      verified: true,
      signer: { userId: signer.id },
      esign: { certificate: { transaction: 'T-1', signedSha256: 'f'.repeat(64) } },
    });
    const masked = await staff.call('GET', `/api/acceptances/${done?.id}`, undefined, as(staff));
    expect(masked.body.esign.certificate).toBeUndefined();
    expect((await agreement(id)).status).toBe('offered');
    // Once: the signing has ended, and the signer has accepted this PDF.
    await expect(
      service().completeESign({ provider: 'fixture-esign', ref, status: 'signed' }),
    ).rejects.toThrow();
    const again = await signer.call(
      'POST',
      '/api/acceptances/esign',
      { documentId: summary.id },
      as(signer),
    );
    expect(again.body.rule).toBe('already_accepted');
  });

  it('a declined signing records nothing; a moved record refuses a late result', async () => {
    const other = await offered('Plan K');
    const doc = await pdf(other, 'agreements.summary');
    const start = async () =>
      (await signer.call('POST', '/api/acceptances/esign', { documentId: doc.id }, as(signer))).body
        .value.ref as string;
    const declined = await start();
    expect(
      await service().completeESign({
        provider: 'fixture-esign',
        ref: declined,
        status: 'declined',
      }),
    ).toBeNull();
    expect((await audit('acceptance.signed')).at(-1)).toMatchObject({
      outcome: 'denied',
      rule: 'esign_declined',
    });
    const late = await start();
    await move(owner, other, 'withdraw');
    await expect(
      service().completeESign({ provider: 'fixture-esign', ref: late, status: 'signed' }),
    ).rejects.toThrow();
    expect(await service().verifyChain(tenantId)).toMatchObject({ ok: true });
  });
});
