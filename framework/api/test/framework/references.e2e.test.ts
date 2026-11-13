// References (V2): a field that names another record (`traits.references`) names one its writer
// can read in their business. An unknown id, another business's id and a record the writer
// cannot read get the same 404, through every entry point (the app, the assistant, MCP, a
// command, an offline create, an import, an approved replay). A key no spec declares is the
// database's alone, refused without its detail. On the fixture's rooms and bookings
// (fixture/src/features/references).
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  connectMcp,
  type McpConnection,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { referencesServer } from '../fixture/dist/features/references/index.js';

type Api = typeof import('../../dist/index.js');
let api: Api;

const owner = new Person('Owner References');
const staff = new Person('Staff References');
const other = new Person('Other References');
let tenantId = '';
let mcp: McpConnection | undefined;

/** As this person, in the owner's business. */
const as = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

const room = async (p: Person, title: string): Promise<string> => {
  const res = await (p === other
    ? p.call('POST', '/api/rooms', { title })
    : as(p)('POST', '/api/rooms', { title }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.value.id;
};

/** What every refused reference answers: the target's own "not yours". */
const refused = { error: 'not_found', message: 'No such room', field: 'roomId' };

let ownerRoom = '';
let staffRoom = '';
let otherRoom = '';
const unknown = randomUUID();
/** The three a member of the business may not name: unknown, another business's, unreadable. */
const forStaff = () => [unknown, otherRoom, ownerRoom];

const bookingsNaming = async (roomId: string) =>
  Number(
    (
      await pool.query(
        'select count(*)::int n from app.fixture_rooms_bookings where room_id = $1',
        [roomId],
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  api = await import('../../dist/index.js');
  await boot(referencesServer);
  for (const p of [owner, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  expect((await staff.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
  ownerRoom = await room(owner, 'Boardroom');
  staffRoom = await room(staff, 'Staff room');
  otherRoom = await room(other, 'Their room');
});
afterAll(async () => {
  await mcp?.close();
  await shutdown();
});

describe('a person naming a room', () => {
  it('is refused alike for an unknown room, another business’s and one they cannot read', async () => {
    const bodies = [];
    for (const roomId of forStaff()) {
      const res = await as(staff)('POST', '/api/bookings', { title: 'Mine', roomId });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      bodies.push(res.body);
    }
    for (const body of bodies) expect(body).toEqual(refused);
    for (const roomId of forStaff()) expect(await bookingsNaming(roomId)).toBe(0);
    // Their own room is theirs to name; the owner reaches every room of the business.
    expect(
      (await as(staff)('POST', '/api/bookings', { title: 'Mine', roomId: staffRoom })).status,
    ).toBe(201);
    expect(
      (await as(owner)('POST', '/api/bookings', { title: 'Ours', roomId: staffRoom })).status,
    ).toBe(201);
    for (const roomId of [unknown, otherRoom])
      expect((await as(owner)('POST', '/api/bookings', { title: 'Ours', roomId })).body).toEqual(
        refused,
      );
  });

  it('is refused alike when an update changes the room, and the booking is left as it was', async () => {
    const made = await as(staff)('POST', '/api/bookings', { title: 'Moving', roomId: staffRoom });
    const id = made.body.value.id;
    for (const roomId of forStaff()) {
      const res = await as(staff)('PATCH', `/api/bookings/${id}`, { roomId });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refused);
    }
    expect((await as(staff)('GET', `/api/bookings/${id}`)).body).toMatchObject({
      roomId: staffRoom,
    });
  });

  it('keeps a room it already names, and always unlinks', async () => {
    const made = await as(staff)('POST', '/api/bookings', { title: 'Kept', roomId: staffRoom });
    const id = made.body.value.id;
    // Linked when it was readable (here: by the database), the owner's room is out of reach now.
    await pool.query('update app.fixture_rooms_bookings set room_id = $1 where id = $2', [
      ownerRoom,
      id,
    ]);
    const kept = await as(staff)('PATCH', `/api/bookings/${id}`, {
      title: 'Renamed',
      roomId: ownerRoom,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.value).toMatchObject({ title: 'Renamed', roomId: ownerRoom });
    const unlinked = await as(staff)('PATCH', `/api/bookings/${id}`, { roomId: null });
    expect(unlinked.body.value).toMatchObject({ roomId: null });
  });
});

describe('every other way in', () => {
  it('the assistant gets the same refusal, before anything waits for the person', async () => {
    const ask = asAssistant(`user:${staff.id}`, { 'x-tenant-id': tenantId });
    for (const roomId of forStaff()) {
      const res = await ask('POST', '/api/bookings', { title: 'For me', roomId });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refused);
    }
    const parked = await ask('POST', '/api/bookings', { title: 'For me', roomId: staffRoom });
    expect(parked.body.status).toBe('needs_approval');
  });

  it('an approved request whose room went meanwhile fails, and makes nothing', async () => {
    const doomed = await room(owner, 'Doomed room');
    const ask = asAssistant(`user:${owner.id}`, { 'x-tenant-id': tenantId });
    const parked = await ask('POST', '/api/bookings', { title: 'Too late', roomId: doomed });
    expect(parked.body.status).toBe('needs_approval');
    expect((await as(owner)('DELETE', `/api/rooms/${doomed}`)).status).toBe(200);
    const decided = await as(owner)('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(decided.body).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(decided.body)).toContain('No such room');
    const left = await pool.query(
      `select count(*)::int n from app.fixture_rooms_bookings where title = 'Too late'`,
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('a command that writes the room is refused alike', async () => {
    const made = await as(staff)('POST', '/api/bookings', {
      title: 'By command',
      roomId: staffRoom,
    });
    const id = made.body.value.id;
    for (const roomId of forStaff()) {
      const res = await as(staff)('POST', `/api/bookings/${id}/move`, { roomId });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refused);
    }
    const moved = await as(staff)('POST', `/api/bookings/${id}/move`, { roomId: null });
    expect(moved.body.value).toMatchObject({ roomId: null });
  });

  it('an offline create with its own id is refused alike, and the id stays free', async () => {
    const id = randomUUID();
    for (const roomId of forStaff()) {
      const res = await as(staff)('POST', '/api/bookings', { id, title: 'Offline', roomId });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refused);
    }
    const made = await as(staff)('POST', '/api/bookings', {
      id,
      title: 'Offline',
      roomId: staffRoom,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.value.id).toBe(id);
  });

  it('an MCP client is refused alike', async () => {
    mcp = await connectMcp(staff, 'rooms:write');
    for (const roomId of forStaff()) {
      const res = await mcp.call('rooms_write', {
        action: 'create-booking',
        input: { title: 'Over MCP', roomId },
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('No such room');
    }
    const made = await mcp.call('rooms_write', {
      action: 'create-booking',
      input: { title: 'Over MCP', roomId: staffRoom },
    });
    expect(made.isError, made.text).toBe(false);
  });

  it('an import with raw ids reports each refused row with one code, on the field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v2-'));
    const path = join(dir, 'bookings.csv');
    // Owners import (`imports.run`), and read every room of the business: unknown and theirs.
    const rows = [unknown, otherRoom].map((r, i) => `K${i},Imported ${i},${r},`);
    // A key no spec declares is the database's: the same code, without the field.
    const spare = `K8,Imported 8,,${unknown}`;
    await writeFile(
      path,
      ['id,title,roomId,spareRoomId', ...rows, spare, `K9,Imported 9,${staffRoom},`, ''].join('\n'),
    );
    const out = await api.importFile(server.app as never, {
      entity: 'booking',
      path,
      as: owner.email,
      everyMs: 100,
      log: () => {},
    });
    expect(out.result).toMatchObject({ created: 1, failed: 3 });
    const report = (await readFile(out.reportPath as string, 'utf8')).trim().split('\n').slice(1);
    expect(report).toHaveLength(3);
    for (const line of report.slice(0, 2))
      expect(line).toMatch(/^\d+,unknown_reference,roomId,No such room,/);
    expect(report[2]).toMatch(/^\d+,unknown_reference,,It names a record that does not exist,/);
  });
});

describe('a key no spec declares', () => {
  it('refuses an unknown id as 404, without the database’s detail', async () => {
    const res = await as(owner)('POST', '/api/bookings', { title: 'Spare', spareRoomId: unknown });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'not_found',
      message: 'It names a record that does not exist',
    });
    const made = await as(owner)('POST', '/api/bookings', { title: 'Spare' });
    const patched = await as(owner)('PATCH', `/api/bookings/${made.body.value.id}`, {
      spareRoomId: unknown,
    });
    expect(patched.status).toBe(404);
    expect(patched.body).toEqual(res.body);
  });

  it('refuses to delete a record it still names as 409, without the database’s detail', async () => {
    const spare = await room(owner, 'Spare room');
    expect(
      (await as(owner)('POST', '/api/bookings', { title: 'Spare', spareRoomId: spare })).status,
    ).toBe(201);
    const res = await as(owner)('DELETE', `/api/rooms/${spare}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'in_use', message: 'Other records still name this room' });
  });
});

describe('the writes that went around the check (V10)', () => {
  const plansIn = async (series: string) =>
    Number(
      (
        await pool.query(
          'select count(*)::int n from app.fixture_rooms_plans where coalesce(series_id, id) = $1',
          [series],
        )
      ).rows[0].n,
    );

  it('a revision naming another room is refused alike; one keeping its room is not', async () => {
    const made = await as(staff)('POST', '/api/plans', { title: 'Plan', roomId: staffRoom });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.value.id;
    for (const roomId of forStaff()) {
      const res = await as(staff)('POST', `/api/plans/${id}/revise`, { roomId });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(refused);
    }
    expect(await plansIn(id)).toBe(1);
    // Linked when it was readable (here: by the database), the owner's room is out of reach now:
    // a revision that keeps it, or names it again, copies it as the update would keep it.
    await pool.query('update app.fixture_rooms_plans set room_id = $1 where id = $2', [
      ownerRoom,
      id,
    ]);
    const kept = await as(staff)('POST', `/api/plans/${id}/revise`, {});
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.value).toMatchObject({ roomId: ownerRoom, revision: 2 });
    const again = await as(staff)('POST', `/api/plans/${id}/revise`, { roomId: ownerRoom });
    expect(again.body.value).toMatchObject({ roomId: ownerRoom, revision: 3 });
    const moved = await as(staff)('POST', `/api/plans/${id}/revise`, { roomId: staffRoom });
    expect(moved.body.value).toMatchObject({ roomId: staffRoom, revision: 4 });
    expect(await plansIn(id)).toBe(4);
  });

  it('a public form’s answer is refused alike, before it could wait, and spends nothing', async () => {
    const link = await as(owner)('POST', '/api/shares', {
      target: { form: 'rooms.plan' },
      maxUses: 5,
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const token = link.body.value.token as string;
    const guest = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const customers = async () =>
      Number(
        (
          await pool.query('select count(*)::int n from app.customers where tenant_id = $1', [
            tenantId,
          ])
        ).rows[0].n,
      );
    const before = await customers();
    // A guest reads no room of the business: each is one they may not name.
    for (const roomId of [...forStaff(), staffRoom]) {
      const res = await guest('POST', `/api/share/${token}/submit`, {
        values: { title: 'Guest plan', roomId },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(refused);
    }
    // Naming none, the answer would wait for the team, and a guest's never does.
    const waits = await guest('POST', `/api/share/${token}/submit`, {
      values: { title: 'Guest plan' },
    });
    expect(waits.status).toBe(403);
    expect(waits.body).toMatchObject({ rule: 'guest_cannot_wait' });
    expect((await guest('GET', `/api/share/${token}`)).body.form).toMatchObject({ remaining: 5 });
    expect(await customers()).toBe(before);
    const made = await pool.query(
      `select count(*)::int n from app.fixture_rooms_plans where title = 'Guest plan'`,
    );
    expect(made.rows[0].n).toBe(0);
  });

  /** A room of staff's that the owner takes over: staff no longer read it. */
  const handedOver = async (title: string) => {
    const id = await room(staff, title);
    return {
      id,
      handOver: () =>
        pool.query('update app.fixture_rooms set owner_id = $1 where id = $2', [owner.id, id]),
    };
  };
  const undo = (id: string) => as(staff)('POST', `/api/undo/${id}`);

  it('undoing a delete puts the booking back only while its room is still theirs', async () => {
    const lent = await handedOver('Lent room');
    const made = await as(staff)('POST', '/api/bookings', { title: 'Undo me', roomId: lent.id });
    const id = made.body.value.id;
    const removed = await as(staff)('DELETE', `/api/bookings/${id}`);
    expect(removed.body).toMatchObject({ status: 'done', undo: { id: expect.any(String) } });
    await lent.handOver();
    const undone = await undo(removed.body.undo.id);
    expect(undone.status, JSON.stringify(undone.body)).toBe(404);
    expect(undone.body).toEqual(refused);
    expect(await bookingsNaming(lent.id)).toBe(0);

    // A room gone meanwhile: the same refusal, never the database's.
    const gone = await room(staff, 'Gone room');
    const doomed = await as(staff)('POST', '/api/bookings', { title: 'Undo me', roomId: gone });
    const out = await as(staff)('DELETE', `/api/bookings/${doomed.body.value.id}`);
    expect((await as(staff)('DELETE', `/api/rooms/${gone}`)).status).toBe(200);
    const late = await undo(out.body.undo.id);
    expect(late.status, JSON.stringify(late.body)).toBe(404);
    expect(late.body).toEqual(refused);

    // Its room still theirs, it comes back as it was.
    const kept = await as(staff)('POST', '/api/bookings', { title: 'Back', roomId: staffRoom });
    const gone2 = await as(staff)('DELETE', `/api/bookings/${kept.body.value.id}`);
    expect((await undo(gone2.body.undo.id)).status).toBe(200);
    expect((await as(staff)('GET', `/api/bookings/${kept.body.value.id}`)).body).toMatchObject({
      roomId: staffRoom,
    });
  });

  it('undoing a change of room goes back only to a room still theirs, as an update does', async () => {
    const lent = await handedOver('Lent again');
    const made = await as(staff)('POST', '/api/bookings', { title: 'Revert me', roomId: lent.id });
    const id = made.body.value.id;
    const moved = await as(staff)('PATCH', `/api/bookings/${id}`, { roomId: staffRoom });
    expect(moved.body.undo).toMatchObject({ id: expect.any(String) });
    await lent.handOver();
    const undone = await undo(moved.body.undo.id);
    expect(undone.status, JSON.stringify(undone.body)).toBe(404);
    expect(undone.body).toEqual(refused);
    expect((await as(staff)('GET', `/api/bookings/${id}`)).body).toMatchObject({
      roomId: staffRoom,
    });
  });
});
