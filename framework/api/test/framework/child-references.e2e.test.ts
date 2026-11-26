// References on records with a parent (R1): a sheet's lines name price items
// (`traits.references` on the child spec). Every tree write checks every new and changed line's
// items in bulk, one query per target, before anything is written, and refuses an unknown item,
// another business's and one the writer cannot read with the same 404, the field and the line's
// path. Lines read their items' labels, as the reader may see them. On the fixture's sheets
// (fixture/src/features/child-references).
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  childReferencesServer,
  itemQueries,
} from '../fixture/dist/features/child-references/index.js';

type Api = typeof import('../../dist/index.js');
let api: Api;

const owner = new Person('Owner Lines');
const staff = new Person('Staff Lines');
const other = new Person('Other Lines');
let tenantId = '';
let otherTenant = '';
let mcp: McpConnection | undefined;

/** As this person, in the owner's business. */
const as = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

const item = async (p: Person, name: string, cost = 100): Promise<string> => {
  // Staff may not set a cost (field policy): theirs is set by the database.
  const body = p === staff ? { name } : { name, cost };
  const res = await (p === other
    ? p.call('POST', '/api/priceItems', body)
    : as(p)('POST', '/api/priceItems', body));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  if (p === staff)
    await pool.query('update app.fixture_sheets_items set cost = $1 where id = $2', [
      cost,
      res.body.value.id,
    ]);
  return res.body.value.id;
};

/** Many items of the owner's business at once, straight into the table. */
const manyItems = async (n: number, prefix: string): Promise<string[]> => {
  const ids = Array.from({ length: n }, () => randomUUID());
  await pool.query(
    `insert into app.fixture_sheets_items (id, tenant_id, owner_id, name)
     select unnest($1::text[]), $2, $3, $4 || unnest($5::text[])`,
    [ids, tenantId, owner.id, prefix, ids.map((_, i) => String(i))],
  );
  return ids;
};

/** What every refused line answers, but its path: the item's own "not yours". */
const refusedAt = (path: (string | number)[], ref?: string) => ({
  error: 'not_found',
  message: 'No such price item',
  field: path.at(-1),
  path,
  ...(ref ? { ref } : {}),
});

let ownerItem = '';
let staffItem = '';
let otherItem = '';
const unknown = randomUUID();
/** The three a member of the business may not name: unknown, another business's, unreadable. */
const forStaff = () => [unknown, otherItem, ownerItem];

const linesIn = async (sheetId: string) =>
  Number(
    (
      await pool.query('select count(*)::int n from app.fixture_sheets_lines where sheet_id = $1', [
        sheetId,
      ])
    ).rows[0].n,
  );
const sheetsTitled = async (title: string) =>
  Number(
    (await pool.query('select count(*)::int n from app.fixture_sheets where title = $1', [title]))
      .rows[0].n,
  );

const save = (p: Person, body: unknown) => as(p)('POST', '/api/sheets/save', body);
const resetCount = () => {
  itemQueries.find = 0;
  itemQueries.findMany = 0;
};

beforeAll(async () => {
  api = await import('../../dist/index.js');
  await boot(childReferencesServer);
  for (const p of [owner, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  otherTenant = (await me(other)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  expect((await staff.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
  ownerItem = await item(owner, 'Ply 18 mm');
  staffItem = await item(staff, 'Laminate');
  otherItem = await item(other, 'Their ply');
});
afterAll(async () => {
  await mcp?.close();
  await shutdown();
});
beforeEach(resetCount);

describe('a child spec that declares references', () => {
  it('boots, and a line naming a readable item is saved with it', async () => {
    expect(otherTenant).not.toBe(tenantId);
    const res = await save(staff, {
      title: 'Kitchen',
      items: [
        { ref: 'a', title: 'Carcass', itemId: staffItem },
        { ref: 'b', parent: 'a', title: 'Shutter', altItemId: staffItem },
        { ref: 'c', title: 'Labour' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.value.items).toHaveLength(3);
    expect(res.body.value.items[0]).toMatchObject({ itemId: staffItem, altItemId: null });
  });
});

describe('the check, in bulk', () => {
  it('500 new lines naming 200 items make one reference query, whatever writes them', async () => {
    const ids = await manyItems(200, 'Bulk ');
    const lines = Array.from({ length: 500 }, (_, i) => ({
      title: `Line ${i}`,
      itemId: ids[i % 200],
    }));
    // children.replace, through a revision that replaces its copied lines.
    const made = await save(owner, { title: 'Bulk', items: [] });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    resetCount();
    const revised = await as(owner)('POST', `/api/sheets/${made.body.value.sheet.id}/revise`, {
      items: lines,
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body.value.items).toHaveLength(500);
    expect(itemQueries).toEqual({ find: 0, findMany: 1 });
    // children.insert.
    resetCount();
    const added = await as(owner)('POST', `/api/sheets/${made.body.value.sheet.id}/lines`, {
      items: lines,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(itemQueries).toEqual({ find: 0, findMany: 1 });
    // A save checks in its load (before it could park) and again in run: two, never 500.
    resetCount();
    const saved = await save(owner, {
      title: 'Bulk saved',
      items: lines.map((l, i) => ({ ...l, ref: `r${i}` })),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(itemQueries).toEqual({ find: 0, findMany: 2 });
  });

  it('two fields naming the same entity share one query', async () => {
    const res = await save(owner, {
      title: 'Two fields',
      items: [{ ref: 'a', title: 'Both', itemId: ownerItem, altItemId: staffItem }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(itemQueries).toEqual({ find: 0, findMany: 2 });
  });

  it('refuses the whole write alike for an unknown item, another business’s and one they cannot read', async () => {
    const bodies = [];
    for (const itemId of forStaff()) {
      const res = await save(staff, {
        title: 'Refused sheet',
        items: [
          { ref: 'a', title: 'Fine', itemId: staffItem },
          { ref: 'b', title: 'Bad', itemId },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      bodies.push(res.body);
    }
    for (const body of bodies) expect(body).toEqual(refusedAt(['items', 1, 'itemId'], 'b'));
    expect(await sheetsTitled('Refused sheet')).toBe(0);
    // A line under another: its path in the tree, and its ref.
    const nested = await save(staff, {
      title: 'Refused sheet',
      items: [
        { ref: 'a', title: 'Group' },
        { ref: 'b', parent: 'a', title: 'Bad', altItemId: unknown },
      ],
    });
    expect(nested.body).toEqual(refusedAt(['items', 0, 'children', 0, 'altItemId'], 'b'));
    // Owners reach every item of the business, never another business's.
    expect(
      (await save(owner, { title: 'Ours', items: [{ ref: 'a', title: 'x', itemId: staffItem }] }))
        .status,
    ).toBe(200);
    expect(
      (await save(owner, { title: 'Ours', items: [{ ref: 'a', title: 'x', itemId: otherItem }] }))
        .body,
    ).toEqual(refusedAt(['items', 0, 'itemId'], 'a'));
  });

  it('writes nothing to a stored sheet, and audits the refusal as denied', async () => {
    const made = await save(staff, {
      title: 'Stored',
      items: [{ ref: 'a', title: 'Kept', itemId: staffItem }],
    });
    const sheetId = made.body.value.sheet.id;
    const lineId = made.body.value.items[0].id;
    const version = made.body.value.sheet.version;
    const before = await pool.query(
      `select count(*)::int n from audit.events
       where tenant_id = $1 and action = 'sheet.save' and outcome = 'denied'`,
      [tenantId],
    );
    const res = await as(staff)('POST', `/api/sheets/${sheetId}/lines`, {
      items: [{ title: 'Ok' }, { title: 'Bad', itemId: ownerItem }],
    });
    expect(res.body).toEqual(refusedAt(['items', 1, 'itemId']));
    const changed = await save(staff, {
      sheetId,
      title: 'Renamed',
      items: [
        { ref: 'a', id: lineId, title: 'Kept' },
        { ref: 'b', title: 'Bad', itemId: unknown },
      ],
    });
    expect(changed.body).toEqual(refusedAt(['items', 1, 'itemId'], 'b'));
    expect(await linesIn(sheetId)).toBe(1);
    expect((await as(staff)('GET', `/api/sheets/${sheetId}`)).body).toMatchObject({
      title: 'Stored',
      version,
    });
    const after = await pool.query(
      `select rule, reason from audit.events
       where tenant_id = $1 and action = 'sheet.save' and outcome = 'denied'
       order by at desc`,
      [tenantId],
    );
    expect(after.rows.length).toBeGreaterThan(before.rows[0].n);
    expect(after.rows[0]).toEqual({ rule: 'unknown_reference', reason: 'No such price item' });
  });

  it('a changed line keeping its item makes no reference query; a new item is checked', async () => {
    const made = await save(staff, {
      title: 'Changes',
      items: [{ ref: 'a', title: 'Line', itemId: staffItem }],
    });
    const sheetId = made.body.value.sheet.id;
    const lineId = made.body.value.items[0].id;
    // Linked when it was readable (here: by the database), the owner's item is out of reach now.
    await pool.query('update app.fixture_sheets_lines set item_id = $1 where id = $2', [
      ownerItem,
      lineId,
    ]);
    resetCount();
    const kept = await save(staff, {
      sheetId,
      title: 'Changes',
      items: [{ ref: 'a', id: lineId, title: 'Line renamed', itemId: ownerItem }],
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.value.items[0]).toMatchObject({ title: 'Line renamed', itemId: ownerItem });
    expect(itemQueries).toEqual({ find: 0, findMany: 0 });
    for (const itemId of forStaff().slice(0, 2)) {
      const res = await save(staff, {
        sheetId,
        title: 'Changes',
        items: [{ ref: 'a', id: lineId, title: 'Line', itemId }],
      });
      expect(res.body).toEqual(refusedAt(['items', 0, 'itemId'], 'a'));
    }
    resetCount();
    const moved = await save(staff, {
      sheetId,
      title: 'Changes',
      items: [{ ref: 'a', id: lineId, title: 'Line', itemId: staffItem }],
    });
    expect(moved.body.value.items[0]).toMatchObject({ itemId: staffItem });
    // Checked once in the load and once in the tree write; never again by repo.update.
    expect(itemQueries).toEqual({ find: 0, findMany: 2 });
    // Unlinking always passes.
    const unlinked = await save(staff, {
      sheetId,
      title: 'Changes',
      items: [{ ref: 'a', id: lineId, title: 'Line', itemId: null }],
    });
    expect(unlinked.body.value.items[0]).toMatchObject({ itemId: null });
  });

  it('more than 1,000 different items in one write is 400 too_many_references', async () => {
    const ids = await manyItems(1001, 'Many ');
    const made = await save(owner, { title: 'Too many', items: [] });
    const res = await as(owner)('POST', `/api/sheets/${made.body.value.sheet.id}/lines`, {
      items: ids.map((itemId, i) => ({ title: `L${i}`, itemId })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ error: 'too_many_references', field: 'itemId' });
    expect(itemQueries.findMany).toBe(0);
    expect(await linesIn(made.body.value.sheet.id)).toBe(0);
  });
});

describe('every way a tree is written', () => {
  it('the assistant is refused before its save waits; a waiting save whose item went fails', async () => {
    const ask = asAssistant(`user:${staff.id}`, { 'x-tenant-id': tenantId });
    for (const itemId of forStaff()) {
      const res = await ask('POST', '/api/sheets/save', {
        title: 'By the assistant',
        items: [{ ref: 'a', title: 'x', itemId }],
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refusedAt(['items', 0, 'itemId'], 'a'));
    }
    const doomed = await item(owner, 'Doomed');
    const forOwner = asAssistant(`user:${owner.id}`, { 'x-tenant-id': tenantId });
    const parked = await forOwner('POST', '/api/sheets/save', {
      title: 'Too late',
      items: [{ ref: 'a', title: 'x', itemId: doomed }],
    });
    expect(parked.body.status, JSON.stringify(parked.body)).toBe('needs_approval');
    expect((await as(owner)('DELETE', `/api/priceItems/${doomed}`)).status).toBe(200);
    const decided = await as(owner)('POST', `/api/approvals/${parked.body.approval.id}/approve`);
    expect(decided.body).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(decided.body)).toContain('No such price item');
    expect(await sheetsTitled('Too late')).toBe(0);
  });

  it('an MCP client is refused alike', async () => {
    mcp = await connectMcp(staff, 'sheets:write');
    for (const itemId of forStaff()) {
      const res = await mcp.call('sheets_write', {
        action: 'save-sheet',
        input: { title: 'Over MCP', items: [{ ref: 'a', title: 'x', itemId }] },
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('No such price item');
    }
    const made = await mcp.call('sheets_write', {
      action: 'save-sheet',
      input: { title: 'Over MCP', items: [{ ref: 'a', title: 'x', itemId: staffItem }] },
    });
    expect(made.isError, made.text).toBe(false);
  });

  it('an offline replay (the same idempotency key) is refused every time, and writes nothing', async () => {
    const key = randomUUID();
    const body = { title: 'Offline sheet', items: [{ ref: 'a', title: 'x', itemId: ownerItem }] };
    for (let i = 0; i < 2; i++) {
      const res = await staff.call('POST', '/api/sheets/save', body, {
        'x-tenant-id': tenantId,
        'idempotency-key': key,
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(refusedAt(['items', 0, 'itemId'], 'a'));
    }
    expect(await sheetsTitled('Offline sheet')).toBe(0);
  });

  it('a revision keeps its copied lines as they are; the lines it writes are checked', async () => {
    const made = await save(staff, {
      title: 'Revised',
      items: [{ ref: 'a', title: 'Line', itemId: staffItem }],
    });
    const sheetId = made.body.value.sheet.id;
    // Linked when it was readable, the owner's item is out of reach now: a copy keeps it, as a
    // revision keeps its parent's own link (V2 decision 4, V10).
    await pool.query('update app.fixture_sheets_lines set item_id = $1 where sheet_id = $2', [
      ownerItem,
      sheetId,
    ]);
    const kept = await as(staff)('POST', `/api/sheets/${sheetId}/revise`, {});
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.value.items[0]).toMatchObject({ itemId: ownerItem });
    for (const itemId of forStaff()) {
      const res = await as(staff)('POST', `/api/sheets/${sheetId}/revise`, {
        items: [{ title: 'New line', itemId }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(refusedAt(['items', 0, 'itemId']));
    }
    const series = await pool.query(
      'select count(*)::int n from app.fixture_sheets where coalesce(series_id, id) = $1',
      [sheetId],
    );
    expect(series.rows[0].n).toBe(2);
  });

  it('undoing a save puts a removed line back only while its item is still theirs', async () => {
    const lent = await item(staff, 'Lent item');
    const made = await save(staff, {
      title: 'Undo me',
      items: [{ ref: 'a', title: 'Line', itemId: lent }],
    });
    expect(made.body.undo).toMatchObject({ id: expect.any(String) });
    const sheetId = made.body.value.sheet.id;
    const emptied = await save(staff, { sheetId, title: 'Undo me', items: [] });
    expect(emptied.body.undo).toMatchObject({ id: expect.any(String) });
    await pool.query('update app.fixture_sheets_items set owner_id = $1 where id = $2', [
      owner.id,
      lent,
    ]);
    const undone = await as(staff)('POST', `/api/undo/${emptied.body.undo.id}`);
    expect(undone.status, JSON.stringify(undone.body)).toBe(404);
    expect(undone.body).toMatchObject({ error: 'not_found', message: 'No such price item' });
    expect(await linesIn(sheetId)).toBe(0);

    const back = await save(staff, {
      title: 'Undo back',
      items: [{ ref: 'a', title: 'Line', itemId: staffItem }],
    });
    const again = await save(staff, {
      sheetId: back.body.value.sheet.id,
      title: 'Undo back',
      items: [],
    });
    expect((await as(staff)('POST', `/api/undo/${again.body.undo.id}`)).status).toBe(200);
    expect(await linesIn(back.body.value.sheet.id)).toBe(1);
  });

  it('an import cannot write lines around the check: lines are written only through their sheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'r1-'));
    const path = join(dir, 'lines.csv');
    await writeFile(path, ['title,itemId', `Imported,${otherItem}`, ''].join('\n'));
    const before = await pool.query('select count(*)::int n from app.fixture_sheets_lines');
    const out = await api
      .importFile(server.app as never, {
        entity: 'sheetLine',
        path,
        as: owner.email,
        everyMs: 100,
        log: () => {},
      })
      .then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    if (out.ok) expect(out.r.result).toMatchObject({ created: 0 });
    const after = await pool.query('select count(*)::int n from app.fixture_sheets_lines');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('the database key', () => {
  it('refuses to delete an item a line names (NO ACTION) as 409, and clears the SET NULL one', async () => {
    const named = await item(owner, 'Named');
    const alt = await item(owner, 'Alternative');
    const made = await save(owner, {
      title: 'Keys',
      items: [{ ref: 'a', title: 'Line', itemId: named, altItemId: alt }],
    });
    const lineId = made.body.value.items[0].id;
    const res = await as(owner)('DELETE', `/api/priceItems/${named}`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'in_use',
      message: 'Other records still name this price item',
    });
    expect((await as(owner)('DELETE', `/api/priceItems/${alt}`)).status).toBe(200);
    const line = await pool.query(
      'select item_id, alt_item_id from app.fixture_sheets_lines where id = $1',
      [lineId],
    );
    expect(line.rows[0]).toEqual({ item_id: named, alt_item_id: null });
  });

  it('refuses a line naming another business’s item even when written with SQL', async () => {
    const made = await save(owner, {
      title: 'Raw',
      items: [{ ref: 'a', title: 'Line', itemId: ownerItem }],
    });
    await expect(
      pool.query('update app.fixture_sheets_lines set item_id = $1 where id = $2', [
        otherItem,
        made.body.value.items[0].id,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('labels on read', () => {
  let sheetId = '';
  beforeAll(async () => {
    const ids = await manyItems(3, 'Label ');
    const made = await save(owner, {
      title: 'Labelled',
      items: Array.from({ length: 100 }, (_, i) => ({
        ref: `r${i}`,
        title: `Line ${i}`,
        itemId: i === 0 ? staffItem : ids[i % 3],
        altItemId: i === 0 ? staffItem : null,
      })),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    sheetId = made.body.value.sheet.id;
    // Staff may write lines of their own sheet only: hand it to them, its lines too.
    await pool.query('update app.fixture_sheets set owner_id = $1 where id = $2', [
      staff.id,
      sheetId,
    ]);
    await pool.query('update app.fixture_sheets_lines set owner_id = $1 where sheet_id = $2', [
      staff.id,
      sheetId,
    ]);
  });

  it('a page of 100 lines reads its items’ labels with one query per target', async () => {
    resetCount();
    const page = await as(owner)('GET', `/api/sheetLines?sheetId=${sheetId}&limit=100`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.items).toHaveLength(100);
    expect(itemQueries).toEqual({ find: 0, findMany: 1 });
    expect(page.body.items[0].references).toEqual({
      itemId: { id: staffItem, label: 'Laminate' },
      altItemId: { id: staffItem, label: '100' },
    });
    expect(page.body.items[1].references.itemId.label).toMatch(/^Label /);
    // A line naming none reads no label for it.
    expect(page.body.items[1].references.altItemId).toBeUndefined();
  });

  it('an item the reader cannot see reads label null, and so does a field hidden from them', async () => {
    const page = await as(staff)('GET', `/api/sheetLines?sheetId=${sheetId}&limit=100`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    // Their own item: its name, but not its cost (owners only).
    expect(page.body.items[0].references).toEqual({
      itemId: { id: staffItem, label: 'Laminate' },
      altItemId: { id: staffItem, label: null },
    });
    // The owner's items: staff may not read them, so no name.
    expect(page.body.items[1].references.itemId).toEqual({
      id: page.body.items[1].itemId,
      label: null,
    });
    const one = await as(staff)('GET', `/api/sheetLines/${page.body.items[1].id}`);
    expect(one.body.references.itemId.label).toBeNull();
  });
});
