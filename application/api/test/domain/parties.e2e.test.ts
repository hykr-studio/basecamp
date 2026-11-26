// Participants in the sample (B7): people of a customer's household on a meeting (the meetings
// module's `household` role), and the organisation that supplies an order (the orders module's
// `supplier` role), reached on WhatsApp. They read what they are on, nothing else, and never the
// cost; they are never members of the business.
import { asAssistant, boot, me, Person, pool, seedContact, shutdown } from '@hykr/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { server as application } from '../../dist/server.js';

const owner = new Person('Owner Parties');
const stranger = new Person('Stranger Parties');
let tenantId = '';
let seq = 0;
const phone = () => `9166${String(Date.now()).slice(-6)}${seq++ % 10}`;

const meeting = (person: Person, title: string) => {
  const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
  return person.call('POST', '/api/meetings', {
    title,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
  });
};
const party = async (kind: 'person' | 'organisation', name: string, customerId?: string) =>
  (await owner.call('POST', '/api/parties', { kind, name, ...(customerId ? { customerId } : {}) }))
    .body.value as { id: string };
/** A party's person on WhatsApp: the contact the business keeps for the number. */
const byNumber = async (partyId: string, name: string) =>
  (await owner.call('POST', `/api/parties/${partyId}/members`, { address: phone(), name })).body
    .value.member as { contactId: string };
const put = (resourceType: string, resourceId: string, partyId: string, role: string) =>
  owner.call('POST', '/api/participants', { resourceType, resourceId, partyId, role });

beforeAll(async () => {
  await boot(application);
  for (const p of [owner, stranger]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
});
afterAll(shutdown);

describe("a customer's household on a meeting", () => {
  it('each person the business puts on it reads it, and only it', async () => {
    const customer = await seedContact(tenantId, 'Mehta family', phone());
    const site = (await meeting(owner, 'Site walk with the Mehtas')).body.value;
    const other = (await meeting(owner, 'Another client')).body.value;
    const people = [];
    for (const name of ['Asha Mehta', 'Rohan Mehta']) {
      const p = await party('person', name, customer.customerId);
      const member = await byNumber(p.id, name);
      expect((await put('meeting', site.id, p.id, 'household')).status).toBe(200);
      people.push(member);
    }
    // The household is the customer's: its parties are listed under it.
    expect(
      (await owner.call('GET', `/api/parties?customerId=${customer.customerId}`)).body,
    ).toHaveLength(2);
    expect(
      (await owner.call('GET', `/api/participants?resourceType=meeting&resourceId=${site.id}`))
        .body,
    ).toHaveLength(2);
    for (const member of people) {
      const theirs = asAssistant(`contact:${member.contactId}`);
      const list = await theirs('GET', '/api/meetings');
      expect(list.status).toBe(200);
      expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([site.id]);
      expect((await theirs('GET', `/api/meetings/${other.id}`)).status).toBe(404);
      // Reading only: changing it is refused.
      expect((await theirs('PATCH', `/api/meetings/${site.id}`, { title: 'Ours' })).status).toBe(
        403,
      );
    }
    // Never members of the business.
    const { rows } = await pool.query(
      'select count(*)::int as n from app.memberships where tenant_id = $1',
      [tenantId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a supplier role does not fit a person, nor a household role an order', async () => {
    const someone = await party('person', 'Not a supplier');
    const items = [{ ref: 'a', title: 'One line', quantity: 1, unitPrice: '10.00', taxRateBp: 0 }];
    const order = (await owner.call('POST', '/api/orders/save', { title: 'Fit', items })).body.value
      .order;
    expect((await put('order', order.id, someone.id, 'supplier')).status).toBe(400);
    expect((await put('order', order.id, someone.id, 'household')).status).toBe(400);
  });

  it("another business's meeting cannot be given a participant", async () => {
    const theirs = (await meeting(stranger, 'Stranger meeting')).body.value;
    const p = await party('person', 'Stranger guest');
    expect((await put('meeting', theirs.id, p.id, 'household')).status).toBe(404);
  });
});

describe('the organisation that supplies an order', () => {
  it('reads the order and its lines on WhatsApp, without what they cost', async () => {
    const items = [
      { ref: 'g', kind: 'group', title: 'Glass' },
      {
        ref: 'g1',
        parent: 'g',
        title: 'Panels',
        quantity: 4,
        unitPrice: '250.00',
        taxRateBp: 1800,
        cost: '150.00',
      },
    ];
    const supplied = (await owner.call('POST', '/api/orders/save', { title: 'Glass', items })).body
      .value.order;
    const notTheirs = (await owner.call('POST', '/api/orders/save', { title: 'Other', items })).body
      .value.order;
    const glassCo = await party('organisation', 'Clear Glass Co');
    const desk = await byNumber(glassCo.id, 'Clear Glass desk');
    expect((await put('order', supplied.id, glassCo.id, 'supplier')).status).toBe(200);

    const asDesk = asAssistant(`contact:${desk.contactId}`);
    const orders = await asDesk('GET', '/api/orders');
    expect(orders.status).toBe(200);
    expect(orders.body.items.map((o: { id: string }) => o.id)).toEqual([supplied.id]);
    expect((await asDesk('GET', `/api/orders/${notTheirs.id}`)).status).toBe(404);
    const lines = await asDesk('GET', `/api/orderItems?orderId=${supplied.id}`);
    expect(lines.status).toBe(200);
    expect(lines.body.items.map((i: { title: string }) => i.title).sort()).toEqual([
      'Glass',
      'Panels',
    ]);
    for (const line of lines.body.items) expect(line).not.toHaveProperty('cost');
    expect((await asDesk('GET', `/api/orderItems?orderId=${notTheirs.id}`)).body.items).toEqual([]);
    // Its number is a contact, not a customer of the business.
    const { rows } = await pool.query('select customer_id from channel.contacts where id = $1', [
      desk.contactId,
    ]);
    expect(rows[0].customer_id).toBeNull();
    // Another business sees none of it.
    expect((await stranger.call('GET', `/api/parties/${glassCo.id}`)).status).toBe(404);
  });
});
