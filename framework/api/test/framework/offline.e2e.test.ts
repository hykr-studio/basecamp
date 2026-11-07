// Offline capture (B12): what the server does for writes a device queued while offline. A
// person's create may choose the record's id (entities marked `offline`); a retry with the same
// idempotency key answers the first reply, even when two arrive at once; `If-Match` makes an
// update or delete conditional on the record's version (409 when it moved on); a write that
// needs approval parks when it syncs; stored replies are forgotten after their retention. The
// fixture's jots (offline, versioned, a secret only reviewers read) and its plain tasks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { offlineServer } from '../fixture/dist/features/offline/index.js';

const owner = new Person('Owner Offline');
const staff = new Person('Staff Offline');
const stranger = new Person('Stranger Offline');
let tenantId = '';
/** Staff work in the owner's business, not the one their sign-up made. */
const inTenant = () => ({ 'x-tenant-id': tenantId });

type Jot = { id: string; title: string; secret?: string | null; review: boolean; version: number };

const key = () => randomUUID();
const create = (person: Person, body: object, k = key(), headers: Record<string, string> = {}) =>
  person.call('POST', '/api/jots', body, { 'idempotency-key': k, ...headers });
const patch = (person: Person, id: string, body: object, headers: Record<string, string> = {}) =>
  person.call('PATCH', `/api/jots/${id}`, body, { 'idempotency-key': key(), ...headers });
const audits = async (resourceId: string) =>
  (
    await pool.query(
      `select action, outcome, actor_id from audit.events where resource_id = $1 order by at`,
      [resourceId],
    )
  ).rows as { action: string; outcome: string; actor_id: string }[];

beforeAll(async () => {
  await boot(offlineServer);
  for (const p of [owner, staff, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

describe('client-chosen ids', () => {
  it("a person's create makes the record with the id the app chose, audited under it", async () => {
    const id = randomUUID();
    const made = await create(owner, { id, title: 'Made offline', secret: 'kept' });
    expect(made.status).toBe(201);
    expect(made.body.status).toBe('done');
    expect(made.body.value).toMatchObject({ id, title: 'Made offline', version: 1 });
    expect((await owner.call('GET', `/api/jots/${id}`)).body.id).toBe(id);
    expect(await audits(id)).toEqual([
      { action: 'jot.create', outcome: 'committed', actor_id: owner.id },
    ]);
  });

  it('an id already used is 409 id_taken, from anyone, in any business', async () => {
    const id = randomUUID();
    expect((await create(owner, { id, title: 'First' })).status).toBe(201);
    const again = await create(owner, { id, title: 'Second' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('id_taken');
    // Another business gets the same answer, and learns nothing of the record.
    const elsewhere = await create(stranger, { id, title: 'Theirs' });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body).toEqual(again.body);
    expect((await stranger.call('GET', `/api/jots/${id}`)).status).toBe(404);
  });

  it("a deleted record's id stays used: a new record never inherits what the old one left", async () => {
    const id = randomUUID();
    expect((await create(owner, { id, title: 'Owner private jot' })).status).toBe(201);
    const said = await owner.call(
      'POST',
      '/api/comments',
      { entity: 'jot', recordId: id, body: 'Owner-only remark' },
      { 'idempotency-key': key() },
    );
    expect(said.body.status).toBe('done');
    const comments = () =>
      staff.call('GET', `/api/comments?entity=jot&id=${id}`, undefined, inTenant());
    // Staff read only their own jots: not this one, nor its comments.
    expect((await comments()).status).toBe(404);
    const gone = await owner.call('DELETE', `/api/jots/${id}`, undefined, {
      'idempotency-key': key(),
    });
    expect(gone.status).toBe(200);
    // The comment outlives its record; the id is refused, so nobody takes it over.
    const again = await create(staff, { id, title: 'Staff jot, same id' }, key(), inTenant());
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('id_taken');
    expect((await comments()).status).toBe(404);
    // The same answer for its maker and for another business: the id is spent.
    const back = await create(owner, { id, title: 'Back again' });
    expect(back.status).toBe(409);
    expect(back.body).toEqual(again.body);
    expect((await create(stranger, { id, title: 'Theirs' })).body).toEqual(again.body);
  });

  it('two creates of one id at the same moment make one record', async () => {
    const id = randomUUID();
    const both = await Promise.all([
      create(owner, { id, title: 'Race A' }),
      create(owner, { id, title: 'Race B' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await pool.query('select count(*)::int as n from app.fixture_jots where id = $1', [
      id,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('refuses an id that is not a UUID, and an id from the assistant', async () => {
    const bad = await create(owner, { id: 'not-a-uuid', title: 'Bad id' });
    expect(bad.status).toBe(400);
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const byAgent = await asks('POST', '/api/jots', {
      id: randomUUID(),
      title: 'By the assistant',
    });
    expect(byAgent.status).toBe(400);
    expect(byAgent.body.error).toBe('client_id_people_only');
  });

  it('an entity without the trait makes its own ids, whatever the body says', async () => {
    const id = randomUUID();
    const made = await owner.call('POST', '/api/tasks', { id, title: 'Plain task' });
    expect(made.status).toBe(201);
    expect(made.body.value.id).not.toBe(id);
  });

  it('hides the secret from whoever may not read it, in the reply and the replay', async () => {
    const id = randomUUID();
    const k = key();
    const first = await create(staff, { id, title: 'Staff jot' }, k, inTenant());
    expect(first.status).toBe(201);
    expect(first.body.value).not.toHaveProperty('secret');
    const replay = await create(staff, { id, title: 'Staff jot' }, k, inTenant());
    expect(replay.body).toEqual(first.body);
    // Staff cannot set it either.
    const sets = await create(
      staff,
      { id: randomUUID(), title: 'Sets it', secret: 'x' },
      key(),
      inTenant(),
    );
    expect(sets.status).toBe(403);
    // Whoever may read it sees it.
    const mine = await create(owner, { id: randomUUID(), title: 'Owner jot', secret: 's' });
    expect(mine.body.value.secret).toBe('s');
  });
});

describe('idempotency', () => {
  it('a retry with the same key answers the first reply and writes nothing more', async () => {
    const id = randomUUID();
    const k = key();
    const first = await create(owner, { id, title: 'Sent twice' }, k);
    const second = await create(owner, { id, title: 'Sent twice' }, k);
    expect(second.body).toEqual(first.body);
    expect(await audits(id)).toHaveLength(1);
    // The same key with another body is another request: refused.
    const other = await create(owner, { id, title: 'Something else' }, k);
    expect(other.status).toBe(409);
  });

  it('five requests with one key at the same moment run once', async () => {
    const k = key();
    const title = `Concurrent ${k.slice(0, 8)}`;
    const all = await Promise.all(Array.from({ length: 5 }, () => create(owner, { title }, k)));
    expect(new Set(all.map((r) => r.status))).toEqual(new Set([201]));
    const ids = new Set(all.map((r) => r.body.value.id));
    expect(ids.size).toBe(1);
    const rows = await pool.query(
      'select count(*)::int as n from app.fixture_jots where title = $1',
      [title],
    );
    expect(rows.rows[0].n).toBe(1);
    expect(await audits([...ids][0])).toHaveLength(1);
  });

  it('forgets replies past the retention, and keeps newer ones', async () => {
    const old = `old-${key()}`;
    const fresh = `fresh-${key()}`;
    await pool.query(
      `insert into app.idempotency (key, principal_id, request_hash, response, created_at)
       values ($1, 'p', 'h', '{}', now() - interval '40 days'), ($2, 'p', 'h', '{}', now() - interval '1 day')`,
      [old, fresh],
    );
    const { IdempotencyService } = await import('../../dist/index.js');
    const out = await server.app?.get(IdempotencyService).purge();
    expect(out?.deleted).toBeGreaterThanOrEqual(1);
    const left = await pool.query('select key from app.idempotency where key = any($1)', [
      [old, fresh],
    ]);
    expect(left.rows.map((r) => r.key)).toEqual([fresh]);
  });
});

describe('If-Match', () => {
  const made = async (title: string) =>
    (await create(owner, { id: randomUUID(), title })).body.value as Jot;

  it('an update on the version it names runs; on an older one it is 409 and changes nothing', async () => {
    const j = await made('Versioned');
    const ok = await patch(owner, j.id, { title: 'Edited' }, { 'if-match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body.value.version).toBe(2);
    const stale = await patch(owner, j.id, { title: 'From another phone' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
    const now = (await owner.call('GET', `/api/jots/${j.id}`)).body as Jot;
    expect(now).toMatchObject({ title: 'Edited', version: 2 });
    // A weak tag, a list, and a bare number all name versions; * matches any record.
    expect((await patch(owner, j.id, { title: 'W' }, { 'if-match': 'W/"2"' })).status).toBe(200);
    expect(
      (await patch(owner, j.id, { title: 'List' }, { 'if-match': '"1", "3"' })).body.value.version,
    ).toBe(4);
    expect((await patch(owner, j.id, { title: 'Bare' }, { 'if-match': '4' })).status).toBe(200);
    expect((await patch(owner, j.id, { title: 'Any' }, { 'if-match': '*' })).status).toBe(200);
  });

  it('a delete on an older version is 409 and the record stays', async () => {
    const j = await made('Deleted later');
    await patch(owner, j.id, { title: 'Moved on' });
    const gone = await owner.call('DELETE', `/api/jots/${j.id}`, undefined, { 'if-match': '"1"' });
    expect(gone.status).toBe(409);
    expect((await owner.call('GET', `/api/jots/${j.id}`)).status).toBe(200);
    const ok = await owner.call('DELETE', `/api/jots/${j.id}`, undefined, { 'if-match': '"2"' });
    expect(ok.status).toBe(200);
  });

  it("another business's record is 404, whatever If-Match says", async () => {
    const j = await made('Not theirs');
    const r = await patch(stranger, j.id, { title: 'x' }, { 'if-match': '"9"' });
    expect(r.status).toBe(404);
  });

  it('refuses a precondition it cannot check: garbage, no versions, a create, a command', async () => {
    const j = await made('Checked');
    expect((await patch(owner, j.id, { title: 'x' }, { 'if-match': 'abc' })).status).toBe(400);
    const task = (await owner.call('POST', '/api/tasks', { title: 'Unversioned' })).body.value;
    const onTask = await owner.call(
      'PATCH',
      `/api/tasks/${task.id}`,
      { title: 'y' },
      {
        'if-match': '"1"',
      },
    );
    expect(onTask.status).toBe(400);
    expect(onTask.body.error).toBe('if_match_unsupported');
    // * on a record without versions only says it exists.
    expect(
      (await owner.call('PATCH', `/api/tasks/${task.id}`, { title: 'z' }, { 'if-match': '*' }))
        .status,
    ).toBe(200);
    const onCreate = await create(owner, { title: 'New' }, key(), { 'if-match': '"1"' });
    expect(onCreate.status).toBe(400);
    const onRead = await owner.call('GET', `/api/jots/${j.id}`, undefined, { 'if-match': '"1"' });
    expect(onRead.status).toBe(400);
  });
});

describe('a write that needs approval parks when it syncs', () => {
  it('parks with the client id, answers the same approval on a retry, and makes it on approval', async () => {
    const id = randomUUID();
    const k = key();
    const parked = await create(staff, { id, title: 'For review', review: true }, k, inTenant());
    expect(parked.body.status).toBe('needs_approval');
    expect(parked.body.approval.resourceId).toBe(id);
    expect((await owner.call('GET', `/api/jots/${id}`)).status).toBe(404);
    expect(await audits(id)).toEqual([
      { action: 'jot.create', outcome: 'needs_approval', actor_id: staff.id },
    ]);
    // The app sends it again (its reply was lost): the same request, the same approval.
    const retry = await create(staff, { id, title: 'For review', review: true }, k, inTenant());
    expect(retry.body.approval.id).toBe(parked.body.approval.id);
    // Its maker cannot decide it; a reviewer can.
    const self = await staff.call(
      'POST',
      `/api/approvals/${parked.body.approval.id}/approve`,
      undefined,
      inTenant(),
    );
    expect(self.status).not.toBe(200);
    const approved = await owner.call('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(approved.body.status).toBe('approved');
    const made = (await staff.call('GET', `/api/jots/${id}`, undefined, inTenant())).body as Jot;
    expect(made).toMatchObject({ id, title: 'For review', review: true });
    expect(made).not.toHaveProperty('secret');
  });
});
