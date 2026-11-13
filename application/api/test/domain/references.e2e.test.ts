// A to-do's or a note's meeting is a meeting its writer can read in its own business (V2): an
// unknown id, another business's meeting and a meeting of this business the writer cannot read
// are refused alike, and the database's key (tenant_id, meeting_id) refuses a cross-business
// link even from SQL. A business deleting its own meeting unlinks only its own rows.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { addMember, asAssistant, boot, me, Person, pool, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const alice = new Person('Alice References');
const staff = new Person('Staff References');
const bob = new Person('Bob References');
let aliceTenant = '';
let bobTenant = '';

const day = (offset: number, time: string) =>
  `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}:00.000Z`;

async function meeting(who: Person, title: string): Promise<string> {
  const res = await who.call('POST', '/api/meetings', {
    title,
    startsAt: day(1, '10:00'),
    endsAt: day(1, '11:00'),
    attendees: [],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value.id;
}

const refused = { error: 'not_found', message: 'No such meeting', field: 'meetingId' };
const linkOf = async (table: 'todos' | 'notes', id: string) =>
  (await pool.query(`select meeting_id from app.${table} where id = $1`, [id])).rows[0]?.meeting_id;

let aliceMeeting = '';
let bobMeeting = '';

beforeAll(async () => {
  await boot(application);
  for (const p of [alice, staff, bob]) await p.signUp();
  aliceTenant = (await me(alice)).tenantId;
  bobTenant = (await me(bob)).tenantId;
  await addMember(staff, aliceTenant, ['staff']);
  expect((await staff.call('PUT', '/api/me/default', { tenantId: aliceTenant })).status).toBe(200);
  aliceMeeting = await meeting(alice, 'Site visit');
  bobMeeting = await meeting(bob, 'Supplier call');
});
afterAll(shutdown);

describe('a meeting named by a to-do or a note', () => {
  it("another business's meeting and an unknown id are refused alike", async () => {
    const bodies = [];
    for (const meetingId of [aliceMeeting, randomUUID()]) {
      for (const path of ['/api/todos', '/api/notes']) {
        const res = await bob.call('POST', path, { title: 'Linked', meetingId });
        expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(404);
        bodies.push(res.body);
      }
      for (const table of ['todos', 'notes'] as const) {
        const own = await bob.call('POST', `/api/${table}`, { title: 'Mine' });
        const patched = await bob.call('PATCH', `/api/${table}/${own.body.value.id}`, {
          meetingId,
        });
        expect(patched.status, `${table} ${JSON.stringify(patched.body)}`).toBe(404);
        bodies.push(patched.body);
        expect(await linkOf(table, own.body.value.id)).toBeNull();
      }
    }
    for (const body of bodies) expect(body).toEqual(refused);
    // Bob's own meeting is his to name.
    const mine = await bob.call('POST', '/api/todos', { title: 'Mine', meetingId: bobMeeting });
    expect(mine.status).toBe(201);
  });

  it("a meeting of the business the writer cannot read is refused alike, and the assistant's too", async () => {
    // Staff read their own meetings only.
    const res = await staff.call('POST', '/api/todos', {
      title: 'Linked',
      meetingId: aliceMeeting,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(refused);
    const ask = asAssistant(`user:${staff.id}`);
    const asked = await ask('POST', '/api/todos', { title: 'Linked', meetingId: aliceMeeting });
    expect(asked.status).toBe(404);
    expect(asked.body).toEqual(refused);
  });

  it('a member of two businesses names only the meetings of the one they work in', async () => {
    const both = new Person('Both References');
    await both.signUp();
    const ownTenant = (await me(both)).tenantId;
    await addMember(both, aliceTenant, ['admin']);
    const ownMeeting = await meeting(both, 'Own review');
    const inAlice = { 'x-tenant-id': aliceTenant };
    // In their own business, Alice's meeting is no meeting of theirs, though they can read it there.
    for (const path of ['/api/todos', '/api/notes']) {
      const res = await both.call('POST', path, { title: 'Crossed', meetingId: aliceMeeting });
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body).toEqual(refused);
      const back = await both.call(
        'POST',
        path,
        { title: 'Crossed back', meetingId: ownMeeting },
        inAlice,
      );
      expect(back.status, `${path} ${JSON.stringify(back.body)}`).toBe(404);
      expect(back.body).toEqual(refused);
    }
    const there = await both.call(
      'POST',
      '/api/todos',
      { title: 'Theirs', meetingId: aliceMeeting },
      inAlice,
    );
    expect(there.status, JSON.stringify(there.body)).toBe(201);
    const here = await both.call('POST', '/api/todos', { title: 'Mine', meetingId: ownMeeting });
    expect(here.status).toBe(201);
    expect(
      (await pool.query('select tenant_id from app.todos where id = $1', [here.body.value.id]))
        .rows[0].tenant_id,
    ).toBe(ownTenant);
  });

  it('the database refuses a cross-business link written by SQL', async () => {
    for (const table of ['todos', 'notes']) {
      const insert = pool.query(
        `insert into app.${table} (tenant_id, owner_id, title, meeting_id) values ($1, $2, 'By SQL', $3)`,
        [bobTenant, bob.id, aliceMeeting],
      );
      await expect(insert).rejects.toMatchObject({ code: '23503' });
    }
  });

  it('a business deleting its own meeting unlinks only its own rows', async () => {
    const doomed = await meeting(alice, 'Cancelled visit');
    const todo = await alice.call('POST', '/api/todos', { title: 'Prep', meetingId: doomed });
    const note = await alice.call('POST', '/api/notes', { title: 'Agenda', meetingId: doomed });
    const kept = await bob.call('POST', '/api/todos', { title: 'Call', meetingId: bobMeeting });
    expect((await alice.call('DELETE', `/api/meetings/${doomed}`)).status).toBe(200);
    expect(await linkOf('todos', todo.body.value.id)).toBeNull();
    expect(await linkOf('notes', note.body.value.id)).toBeNull();
    expect(await linkOf('todos', kept.body.value.id)).toBe(bobMeeting);
  });
});

describe('the SQL hook that adds the keys', () => {
  it('unlinks the links that already cross businesses, once, and adds the key', async () => {
    const hook = await readFile(
      fileURLToPath(new URL('../../../domain/sql/post/meeting-references.sql', import.meta.url)),
      'utf8',
    );
    const crossed = await bob.call('POST', '/api/todos', { title: 'Crossed' });
    const id = crossed.body.value.id;
    await pool.query('alter table app.todos drop constraint todos_meeting_fk');
    await pool.query('update app.todos set meeting_id = $1 where id = $2', [aliceMeeting, id]);
    await pool.query(hook);
    expect(await linkOf('todos', id)).toBeNull();
    // Idempotent: every migrate runs it again.
    await pool.query(hook);
    const keys = await pool.query(
      `select pg_get_constraintdef(oid) def from pg_constraint where conname in ('todos_meeting_fk', 'notes_meeting_fk') order by conname`,
    );
    expect(keys.rows.map((r) => r.def)).toEqual([
      'FOREIGN KEY (tenant_id, meeting_id) REFERENCES app.meetings(tenant_id, id) ON DELETE SET NULL (meeting_id)',
      'FOREIGN KEY (tenant_id, meeting_id) REFERENCES app.meetings(tenant_id, id) ON DELETE SET NULL (meeting_id)',
    ]);
  });

  it('looks for each key on its own table: the same name elsewhere does not stop it (V10)', async () => {
    const hook = await readFile(
      fileURLToPath(new URL('../../../domain/sql/post/meeting-references.sql', import.meta.url)),
      'utf8',
    );
    const onNotes = () =>
      pool.query(
        `select count(*)::int n from pg_constraint where conname = 'notes_meeting_fk' and conrelid = 'app.notes'::regclass`,
      );
    await pool.query('alter table app.notes drop constraint notes_meeting_fk');
    await pool.query(
      'create table app.v10_decoy (n int constraint notes_meeting_fk check (n > 0))',
    );
    try {
      await pool.query(hook);
      expect((await onNotes()).rows[0].n).toBe(1);
      // A database that ran it already (both keys in place): it changes nothing.
      await pool.query(hook);
      expect((await onNotes()).rows[0].n).toBe(1);
    } finally {
      await pool.query('drop table app.v10_decoy');
      await pool.query(hook);
    }
  });
});
