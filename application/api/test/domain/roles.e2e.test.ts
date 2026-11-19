// The to-dos module's own role and capability (A4): a buyer reaches only the to-dos granted to
// them, and a to-do's cost is seen and set only with `todos.cost.read` (owners, admins, buyers).

import { addMember, boot, me, Person, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Roles');
const ops = new Person('Ops Roles');
const staff = new Person('Staff Roles');
const buyer = new Person('Buyer Roles');
let tenantId = '';

const inBusiness = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, ops, staff, buyer]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(ops, tenantId, ['ops']);
  await addMember(staff, tenantId, ['staff']);
  await addMember(buyer, tenantId, ['buyer']);
});
afterAll(shutdown);

describe('the buyer role and the cost of a to-do', () => {
  let tiles: { id: string };
  let paint: { id: string };

  it('the owner sets and sees the cost', async () => {
    tiles = (await owner.call('POST', '/api/todos', { title: 'Order tiles', cost: 25_000 })).body
      .value;
    paint = (await owner.call('POST', '/api/todos', { title: 'Order paint', cost: 9_000 })).body
      .value;
    expect(tiles).toMatchObject({ title: 'Order tiles', cost: 25_000 });
  });

  it('ops reach every to-do but not its cost, and cannot filter by it', async () => {
    const seen = await inBusiness(ops)('GET', `/api/todos/${tiles.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).not.toHaveProperty('cost');
    const filtered = await inBusiness(ops)('GET', '/api/todos?cost[gt]=10000');
    expect(filtered.status).toBe(403);
    expect(filtered.body.rule).toBe('field_hidden');
    expect((await owner.call('GET', '/api/todos?cost[gt]=10000')).body.items).toHaveLength(1);
  });

  it('staff cannot set a cost', async () => {
    const res = await inBusiness(staff)('POST', '/api/todos', { title: 'Mine', cost: 1 });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('field_hidden');
  });

  it('a buyer reaches only the to-dos granted to them, with their cost', async () => {
    expect((await inBusiness(buyer)('GET', '/api/me')).body).toMatchObject({
      roles: ['buyer'],
      capabilities: ['members.read', 'todos.cost.read'],
    });
    expect((await inBusiness(buyer)('GET', '/api/todos')).body.items).toEqual([]);
    const granted = await owner.call('POST', '/api/grants', {
      resourceType: 'todo',
      resourceId: tiles.id,
      userId: buyer.id,
    });
    expect(granted.status).toBe(200);
    const items = (await inBusiness(buyer)('GET', '/api/todos')).body.items;
    expect(items).toEqual([expect.objectContaining({ id: tiles.id, cost: 25_000 })]);
    expect((await inBusiness(buyer)('GET', `/api/todos/${paint.id}`)).status).toBe(404);
    expect(
      (await inBusiness(buyer)('PATCH', `/api/todos/${tiles.id}`, { cost: 24_000 })).body.value,
    ).toMatchObject({ cost: 24_000 });
  });

  it('the roles list names the buyer as the application declares it', async () => {
    const { roles } = (await owner.call('GET', '/api/members/roles')).body;
    expect(roles.find((r: { name: string }) => r.name === 'buyer')).toMatchObject({
      label: { en: 'Buyer' },
      source: 'application',
      capabilities: ['members.read', 'todos.cost.read'],
    });
  });
});
