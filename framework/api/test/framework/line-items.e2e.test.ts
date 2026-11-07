// Records with a parent (B5): a basket's items as a tree (groups and lines), saved whole in one
// write, reached only through a basket the caller reaches, audited row by row, and parked and
// approved as one operation. The fixture's baskets (fixture/src/features/line-items).
import { buildTree, type Money, type Principal } from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, insertMany } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  origin,
  Person,
  pool,
  server,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { BasketDef, BasketItemDef, lineItems } from '../fixture/dist/features/line-items/index.js';

const owner = new Person('Owner Lines');
const staff = new Person('Staff Lines');
const admin = new Person('Admin Lines');
const stranger = new Person('Stranger Lines');
let tenantId = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });

const db = () => {
  if (!server.app) throw new Error('The app is not booted');
  return (server.app.get(CORE_OPTIONS, { strict: false }) as CoreOptions).db;
};

/** As the server builds it for the signed-in owner. */
const asOwner = (): Principal => ({
  actor: { kind: 'user', id: owner.id },
  subject: { kind: 'user', userId: owner.id },
  tenantId,
  roles: ['owner'],
  assurance: 'session',
  scopes: [],
});

type Item = {
  id: string;
  parentItemId: string | null;
  position: number;
  title: string;
  price: Money | null;
  cost?: Money | null;
  amount: Money;
};

/** `groups` groups of `lines` priced lines each, flat, as a save sends them. */
function flat(groups: number, lines: number, title = (g: number, l: number) => `Line ${g}.${l}`) {
  const items: object[] = [];
  for (let g = 0; g < groups; g++) {
    items.push({ ref: `g${g}`, title: `Group ${g}` });
    for (let l = 0; l < lines; l++)
      items.push({
        ref: `g${g}l${l}`,
        parent: `g${g}`,
        title: title(g, l),
        quantity: 2,
        price: '1.50',
        cost: { minor: 100 },
      });
  }
  return items;
}

const save = (person: Person, body: object, headers: Record<string, string> = {}) =>
  person.call('POST', '/api/baskets/save', { currency: 'EUR', ...body }, headers);

const auditOf = async (requestId: string) =>
  (
    await pool.query(
      'select action, outcome, resource_id, before, after, approved_by from audit.events where request_id = $1',
      [requestId],
    )
  ).rows;

const items = async (person: Person, basketId: string, headers: Record<string, string> = {}) =>
  (await person.call('GET', `/api/basketItems?basketId=${basketId}&limit=1000`, undefined, headers))
    .body.items as Item[];

beforeAll(async () => {
  await boot(lineItems);
  for (const p of [owner, staff, admin, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  await addMember(admin, tenantId, ['admin']);
});
afterAll(shutdown);

describe('a whole tree in one write', () => {
  let basketId = '';
  let saved: Item[] = [];

  it('saves 200 lines in 10 groups in one request, audited row by row in the same write', async () => {
    const res = await save(owner, { title: 'Two hundred', items: flat(10, 20) });
    expect(res.status).toBe(200);
    const { basket, items: rows } = res.body.value;
    basketId = basket.id;
    saved = rows;
    expect(rows).toHaveLength(210);
    // A parent before its children, siblings by position.
    expect(rows[0]).toMatchObject({ title: 'Group 0', parentItemId: null, position: 0 });
    expect(rows[1]).toMatchObject({ title: 'Line 0.0', parentItemId: rows[0].id, position: 0 });
    expect(rows[21]).toMatchObject({ title: 'Group 1', position: 1 });
    // Each line 2 × 1.50; each group the sum of its lines; a 10% levy on the lines.
    expect(rows[1].amount).toEqual({ minor: 300, currency: 'EUR' });
    expect(rows[0].amount).toEqual({ minor: 6000, currency: 'EUR' });
    expect(basket.taxTotal).toEqual({ minor: 6000, currency: 'EUR' });
    expect(basket.total).toEqual({ minor: 66000, currency: 'EUR' });

    const requestId = (
      await pool.query(
        "select request_id from audit.events where action = 'basket.save' and resource_type = 'basket' and after->'touched' is not null order by at desc limit 1",
      )
    ).rows[0].request_id;
    const trail = await auditOf(requestId);
    expect(trail.filter((a) => a.action === 'basketItem.create')).toHaveLength(210);
    expect(trail.filter((a) => a.action === 'basket.create')).toHaveLength(1);
    expect(trail.filter((a) => a.action === 'basket.save')).toHaveLength(1);
  });

  it('reads back as the same tree', async () => {
    const read = await items(owner, basketId);
    expect(read).toHaveLength(210);
    const tree = buildTree(read, { key: 'id', parent: 'parentItemId', order: 'position' });
    expect(tree).toHaveLength(10);
    expect(tree.every((g) => g.children.length === 20)).toBe(true);
    expect(tree[3].children[7].title).toBe('Line 3.7');
  });

  it('keeps, changes, moves, removes and adds in one save, and audits each', async () => {
    const byTitle = new Map(saved.map((i) => [i.title, i]));
    const group = (g: number) => byTitle.get(`Group ${g}`) as Item;
    const line = (g: number, l: number) => byTitle.get(`Line ${g}.${l}`) as Item;
    const keep = (i: Item, parent?: Item, extra: object = {}) => ({
      ref: i.id,
      id: i.id,
      ...(parent ? { parent: parent.id } : {}),
      title: i.title,
      quantity: 2,
      price: '1.50',
      cost: { minor: 100 },
      ...extra,
    });
    const next: object[] = [];
    for (let g = 0; g < 10; g++) {
      if (g === 2) continue; // group 2 goes, with its 20 lines
      next.push({ ref: group(g).id, id: group(g).id, title: `Group ${g}` });
      for (let l = 0; l < 20; l++) {
        if (g === 1 && l === 0) continue; // moved into group 0
        next.push(keep(line(g, l), group(g), g === 0 && l === 0 ? { price: '9.99' } : {}));
      }
      if (g === 0) next.push(keep(line(1, 0), group(0)));
      if (g === 1) next.push({ ref: 'new', parent: group(1).id, title: 'Added', price: '5' });
    }
    const res = await save(owner, { basketId, title: 'Two hundred, changed', items: next });
    expect(res.status).toBe(200);
    expect(res.body.value.items).toHaveLength(190);

    const requestId = (
      await pool.query(
        "select request_id from audit.events where action = 'basket.save' and resource_id = $1 order by at desc limit 1",
        [basketId],
      )
    ).rows[0].request_id;
    const trail = await auditOf(requestId);
    const of = (action: string) => trail.filter((a) => a.action === action);
    expect(of('basketItem.delete')).toHaveLength(21);
    expect(of('basketItem.create')).toHaveLength(1);
    const repriced = of('basketItem.update').find((a) => a.resource_id === line(0, 0).id);
    expect(repriced?.before.price).toBe(150);
    expect(repriced?.after.price).toBe(999);
    const moved = of('basketItem.update').find((a) => a.resource_id === line(1, 0).id);
    expect(moved?.after.parentItemId).toBe(group(0).id);
    // Lines that neither changed nor moved are not written.
    expect(of('basketItem.update').find((a) => a.resource_id === line(5, 5).id)).toBeUndefined();

    const read = await items(owner, basketId);
    expect(read).toHaveLength(190);
    const tree = buildTree(read, { key: 'id', parent: 'parentItemId', order: 'position' });
    expect(tree.map((g) => g.title)).not.toContain('Group 2');
    expect(tree[0].children.at(-1)?.title).toBe('Line 1.0');
  });

  it('a node id that is not this basket’s is a 404, and nothing changes', async () => {
    const otherBasket = await save(owner, { title: 'Other', items: flat(1, 1) });
    const foreign = otherBasket.body.value.items[1] as Item;
    const before = await items(owner, basketId);
    const res = await save(owner, {
      basketId,
      title: 'Smuggled',
      items: [{ ref: foreign.id, id: foreign.id, title: 'Not mine' }],
    });
    expect(res.status).toBe(404);
    expect(await items(owner, basketId)).toEqual(before);
    // Another business's item id: the same 404.
    await setTenantSettings((await me(stranger)).tenantId, { money: { currency: 'EUR' } });
    const theirs = await save(stranger, { title: 'Theirs', items: flat(1, 1) });
    const theirItem = theirs.body.value.items[0] as Item;
    const smuggled = await save(owner, {
      basketId,
      title: 'Smuggled',
      items: [{ ref: theirItem.id, id: theirItem.id, title: 'Not mine' }],
    });
    expect(smuggled.status).toBe(404);
  });

  it('refuses a tree deeper than allowed', async () => {
    const deep = Array.from({ length: 9 }, (_, i) => ({
      ref: `n${i}`,
      ...(i ? { parent: `n${i - 1}` } : {}),
      title: `Level ${i}`,
    }));
    const res = await save(owner, { title: 'Deep', items: deep });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_deep');
  });

  it('takes a body well past 100 KB, and refuses one past the limit', async () => {
    const long = flat(30, 29, (g, l) => `${'x'.repeat(250)} ${g}.${l}`);
    expect(JSON.stringify(long).length).toBeGreaterThan(250_000);
    const res = await save(owner, { title: 'Big', items: long });
    expect(res.status).toBe(200);
    expect(res.body.value.items).toHaveLength(900);
    const huge = await fetch(`${server.base}/api/baskets/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: owner.cookie },
      body: JSON.stringify({ title: 'Huge', items: [], padding: 'y'.repeat(2_000_000) }),
    });
    expect(huge.status).toBe(413);
  });
});

describe('who reaches the items', () => {
  let basketId = '';
  let item: Item;

  beforeAll(async () => {
    const res = await save(owner, { title: 'Reach', items: flat(1, 2) });
    basketId = res.body.value.basket.id;
    item = res.body.value.items[1];
  });

  it('another business gets 404 for the basket, its items and a save on it', async () => {
    expect((await stranger.call('GET', `/api/baskets/${basketId}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/basketItems/${item.id}`)).status).toBe(404);
    expect(await items(stranger, basketId)).toEqual([]);
    const res = await save(stranger, { basketId, title: 'Mine now', items: [] });
    expect(res.status).toBe(404);
  });

  it('staff reach the items of their own baskets only, and never see a cost', async () => {
    // Staff work on their own: the owner's basket and its items are not theirs.
    expect(
      (await staff.call('GET', `/api/basketItems/${item.id}`, undefined, inTenant())).status,
    ).toBe(404);
    expect(await items(staff, basketId, inTenant())).toEqual([]);
    const own = await save(staff, { title: 'Staff basket', items: flat(1, 2) }, inTenant());
    expect(own.status).toBe(200);
    for (const i of own.body.value.items) expect(i).not.toHaveProperty('cost');
    const read = await items(staff, own.body.value.basket.id, inTenant());
    expect(read).toHaveLength(3);
    for (const i of read) expect(i).not.toHaveProperty('cost');
    // An admin reaches the whole business, cost included.
    const seen = await items(admin, own.body.value.basket.id, inTenant());
    expect(seen.find((i) => i.parentItemId)?.cost).toEqual({ minor: 100, currency: 'EUR' });
  });

  it('a child whose mirror drifted from its parent is out of reach', async () => {
    await pool.query('update app.fixture_baskets_items set owner_id = $2 where id = $1', [
      item.id,
      admin.id,
    ]);
    expect((await owner.call('GET', `/api/basketItems/${item.id}`)).status).toBe(404);
    expect(
      (await admin.call('GET', `/api/basketItems/${item.id}`, undefined, inTenant())).status,
    ).toBe(404);
    await pool.query('update app.fixture_baskets_items set owner_id = $2 where id = $1', [
      item.id,
      owner.id,
    ]);
    expect((await owner.call('GET', `/api/basketItems/${item.id}`)).status).toBe(200);
  });

  it("the database refuses an item that points at another business's basket", async () => {
    const theirs = await save(stranger, { title: 'Theirs again', items: [] });
    await expect(
      pool.query(
        `insert into app.fixture_baskets_items (tenant_id, basket_id, owner_id, title, currency)
         values ($1, $2, $3, 'Sneaky', 'EUR')`,
        [tenantId, theirs.body.value.basket.id, owner.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('plain CRUD never adds, moves or removes an item; its own fields may change', async () => {
    const add = await owner.call('POST', '/api/basketItems', { title: 'Loose', quantity: 1 });
    expect(add.status).toBe(403);
    expect(add.body.rule).toBe('children_through_parent');
    const move = await owner.call('PATCH', `/api/basketItems/${item.id}`, { parentItemId: null });
    expect(move.body.rule).toBe('tree_through_parent');
    const elsewhere = await owner.call('PATCH', `/api/basketItems/${item.id}`, {
      basketId: '00000000-0000-4000-8000-000000000000',
    });
    expect(elsewhere.body.rule).toBe('parent_fixed');
    const del = await owner.call('DELETE', `/api/basketItems/${item.id}`);
    expect(del.body.rule).toBe('tree_through_parent');
    const renamed = await owner.call('PATCH', `/api/basketItems/${item.id}`, { title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.value).toMatchObject({ title: 'Renamed', parentItemId: item.parentItemId });
    const { rows } = await pool.query(
      "select rule from audit.events where action = 'basketItem.create' and outcome = 'denied' and actor_id = $1",
      [owner.id],
    );
    expect(rows.map((r) => r.rule)).toContain('children_through_parent');
  });
});

describe('a whole tree parked and approved as one', () => {
  it("an assistant's 200-line save waits as one approval, then runs in one write", async () => {
    const asks = asAssistant(`user:${owner.id}`, { 'x-channel': 'app' });
    const asked = `Asked for ${owner.id}`;
    const parked = await asks('POST', '/api/baskets/save', {
      title: asked,
      currency: 'EUR',
      items: flat(10, 20),
    });
    expect(parked.body.status).toBe('needs_approval');
    const approvalId = parked.body.approval.id;
    // Nothing is written while it waits; the park itself is audited.
    const none = await pool.query('select id from app.fixture_baskets where title = $1', [asked]);
    expect(none.rows).toHaveLength(0);
    const { rows: parkedTrail } = await pool.query(
      "select outcome, after from audit.events where action = 'basket.save' and outcome = 'needs_approval' and after->>'approvalId' = $1",
      [approvalId],
    );
    expect(parkedTrail).toHaveLength(1);
    const card = await owner.call('GET', `/api/approvals/${approvalId}`);
    expect(card.body.input.items).toHaveLength(210);

    const approved = await owner.call('POST', `/api/approvals/${approvalId}/approve`);
    expect(approved.body.status).toBe('approved');
    const basket = (
      await pool.query('select id from app.fixture_baskets where title = $1', [asked])
    ).rows[0];
    expect(await items(owner, basket.id)).toHaveLength(210);
    const { rows } = await pool.query(
      "select count(*)::int as n, count(distinct request_id)::int as requests from audit.events where action = 'basketItem.create' and approved_by = $1 and resource_id in (select id from app.fixture_baskets_items where basket_id = $2)",
      [owner.id, basket.id],
    );
    expect(rows[0]).toEqual({ n: 210, requests: 1 });
  });

  it('a hidden field stays hidden on the approval card', async () => {
    const asks = asAssistant(`user:${staff.id}`, { 'x-channel': 'app', 'x-tenant-id': tenantId });
    const parked = await asks('POST', '/api/baskets/save', {
      title: 'Staff asked',
      currency: 'EUR',
      items: flat(1, 3),
    });
    expect(parked.body.status).toBe('needs_approval');
    for (const i of parked.body.approval.input.items) expect(i).not.toHaveProperty('cost');
    const card = await staff.call(
      'GET',
      `/api/approvals/${parked.body.approval.id}`,
      undefined,
      inTenant(),
    );
    expect(card.body.input.items).toHaveLength(4);
    for (const i of card.body.input.items) expect(i).not.toHaveProperty('cost');
  });
});

describe('appending, and many records of any entity', () => {
  it('children.insert appends under a node, after its children; a stored id or a foreign node is refused', async () => {
    const res = await save(owner, { title: 'Append', items: flat(2, 2) });
    const basket = (
      await pool.query('select * from app.fixture_baskets where id = $1', [
        res.body.value.basket.id,
      ])
    ).rows[0];
    const row = await db().transaction((tx) => BasketDef.repo.get(tx, asOwner(), basket.id));
    const group = res.body.value.items[0] as Item;
    const added = await db().transaction((tx) =>
      BasketItemDef.children.insert(
        tx,
        asOwner(),
        row,
        [{ title: 'Late line', quantity: 1, price: { minor: 5 }, amount: { minor: 5 } }],
        { via: 'test.append' },
        { under: group.id },
      ),
    );
    expect(added.created).toHaveLength(1);
    expect(added.created[0]).toMatchObject({
      parentItemId: group.id,
      position: 2,
      currency: 'EUR',
    });
    expect(added.rows).toHaveLength(7);
    expect(added.touched).toEqual([
      expect.objectContaining({ type: 'basketItem', change: 'created' }),
    ]);
    await expect(
      db().transaction((tx) =>
        BasketItemDef.children.insert(tx, asOwner(), row, [{ id: group.id, title: 'Again' }], {
          via: 'test.append',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const other = await save(owner, { title: 'Elsewhere', items: flat(1, 1) });
    await expect(
      db().transaction((tx) =>
        BasketItemDef.children.insert(
          tx,
          asOwner(),
          row,
          [{ title: 'Lost' }],
          { via: 'test' },
          {
            under: other.body.value.items[0].id,
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('insertMany writes each record through its repository, with one touched list', async () => {
    const made = await db().transaction((tx) =>
      insertMany(
        tx,
        asOwner(),
        BasketDef,
        [
          { title: 'Many 1', currency: 'EUR', total: '1' },
          { title: 'Many 2', currency: 'EUR', total: '2' },
        ],
        { via: 'test.many' },
      ),
    );
    expect(made.rows.map((r) => [r.title, r.total, r.ownerId])).toEqual([
      ['Many 1', 100, owner.id],
      ['Many 2', 200, owner.id],
    ]);
    expect(made.touched.map((t) => t.change)).toEqual(['created', 'created']);
  });
});
