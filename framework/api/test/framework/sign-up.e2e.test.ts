// Signing up without a business of one's own (B7): `defineServer({ signUp: { createBusiness:
// false } })`. A new account is in no business until someone invites them (a member) or makes
// them a party member (a participant somewhere).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, me, Person, pool, shutdown } from '../../dist/testing.js';
import { noBusinessServer } from '../fixture/dist/features/parties/index.js';

const owner = new Person('Owner Nobiz');
const guest = new Person('Guest Nobiz');
const joiner = new Person('Joiner Nobiz');
let tenantId = '';

beforeAll(async () => {
  await boot(noBusinessServer);
  for (const p of [owner, guest, joiner]) await p.signUp();
  // Someone has to run a business: made here as an operator would (sign-up made none).
  const { rows } = await pool.query(
    "insert into app.tenants (name, default_owner_id) values ('Nobiz Business', $1) returning id",
    [owner.id],
  );
  tenantId = rows[0].id;
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, is_default)
     values ($1, $2, '{owner}', true)`,
    [tenantId, owner.id],
  );
});
afterAll(shutdown);

describe('a sign-up with no business', () => {
  it('is signed in, in no business: /api/me says so', async () => {
    const res = await guest.call('GET', '/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: guest.id,
      tenantId: null,
      roles: [],
      capabilities: [],
      customerId: null,
      as: null,
      businesses: [],
      features: [],
    });
    const { rows } = await pool.query('select 1 from app.memberships where user_id = $1', [
      guest.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('reaches nothing, and has nobody to talk to', async () => {
    const tasks = await guest.call('GET', '/api/tasks');
    expect(tasks.status).toBe(403);
    expect(tasks.body).toMatchObject({ rule: 'no_tenant' });
    expect((await guest.call('POST', '/api/tasks', { title: 'Nope' })).status).toBe(403);
    const chat = await guest.chat('hello');
    expect(chat.status).toBe(403);
    expect(chat.body).toMatchObject({ rule: 'no_tenant' });
    // Naming a business they are not in changes nothing.
    expect(
      (await guest.call('GET', '/api/tasks', undefined, { 'x-tenant-id': tenantId })).status,
    ).toBe(403);
  });

  it('joins a party by link and then works there as a participant, by default', async () => {
    const kase = (await owner.call('POST', '/api/cases', { title: 'Nobiz case', budget: 10 })).body
      .value;
    const party = (await owner.call('POST', '/api/parties', { kind: 'person', name: 'Guest' })).body
      .value;
    await owner.call('POST', '/api/participants', {
      resourceType: 'case',
      resourceId: kase.id,
      partyId: party.id,
      role: 'fixture_client',
    });
    const { token } = (
      await owner.call('POST', `/api/parties/${party.id}/members`, { email: guest.email })
    ).body.value;
    // A party's code is no team invitation (the app's join tries the party first).
    expect((await guest.call('POST', '/api/members/invites/accept', { token })).status).toBe(404);
    expect((await guest.call('POST', '/api/parties/join', { token })).status).toBe(200);
    const mine = (await guest.call('GET', '/api/me')).body;
    expect(mine).toMatchObject({ tenantId, as: 'participant', roles: ['customer'] });
    expect(mine.businesses).toEqual([
      expect.objectContaining({
        tenantId,
        name: 'Nobiz Business',
        as: 'participant',
        participantRoles: ['fixture_client'],
        isDefault: false,
      }),
    ]);
    const list = await guest.call('GET', '/api/cases');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([kase.id]);
    expect(list.body.items[0]).not.toHaveProperty('budget');
    // Still never a member.
    expect((await guest.call('GET', '/api/members')).status).toBe(403);
  });

  it('accepts an invitation to the team and works there as a member', async () => {
    const { token } = (
      await owner.call('POST', '/api/members/invites', { email: joiner.email, roles: ['staff'] })
    ).body.value;
    // A team's code is no party's: 404, so the app's join tries it as a team invitation next.
    expect((await joiner.call('POST', '/api/parties/join', { token })).status).toBe(404);
    expect((await joiner.call('POST', '/api/members/invites/accept', { token })).status).toBe(200);
    expect(await me(joiner)).toMatchObject({ tenantId, roles: ['staff'] });
    expect((await joiner.call('GET', '/api/me')).body.as).toBe('member');
  });
});
