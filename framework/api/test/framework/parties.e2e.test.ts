// Parties, participations and the participant grant (B7). The fixture's src/features/parties adds
// a `cases` module whose cases people outside the team participate in, in participant roles the
// application declares (a client who may change a case, an observer who reads it, a partner
// organisation), notes that follow their case, a budget only some capabilities read, and a
// notification to everyone on a case.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { checkParticipantRoles } from '@hykr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  Person,
  pool,
  seedContact,
  server,
  settingsChanged,
  shutdown,
} from '../../dist/testing.js';
import { partiesServer } from '../fixture/dist/features/parties/index.js';

const ana = new Person('Ana Parties');
const staffer = new Person('Staff Parties');
const sita = new Person('Sita Parties');
const ravi = new Person('Ravi Parties');
const outsider = new Person('Outsider Parties');
const stranger = new Person('Stranger Parties');
const mallory = new Person('Mallory Parties');
let tenantId = '';
let strangerTenant = '';

/** A stand-in for the WhatsApp Cloud API: records what the adapter sends. */
const sent: { to: string; type?: string }[] = [];
let stub: Server;
const secret = 'test-app-secret';
const NUMBER = `pn-parties-${Date.now()}`;
let seq = 0;
const phone = () => `9177${String(Date.now()).slice(-6)}${seq++ % 10}`;

/** A person's calls inside Ana's business. */
const inAna = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

const audits = async (action: string, outcome?: string) =>
  (
    await pool.query(
      `select action, outcome, rule, resource_id, before, after from audit.events
       where tenant_id = $1 and action = $2 ${outcome ? 'and outcome = $3' : ''} order by at`,
      outcome ? [tenantId, action, outcome] : [tenantId, action],
    )
  ).rows;

const newCase = async (title: string, budget = 5000) =>
  (await ana.call('POST', '/api/cases', { title, budget })).body.value as { id: string };
const newParty = async (kind: 'person' | 'organisation', name: string, who = ana) =>
  (await who.call('POST', '/api/parties', { kind, name })).body.value as { id: string };
const put = (partyId: string, resourceId: string, role: string, resourceType = 'case') =>
  ana.call('POST', '/api/participants', { resourceType, resourceId, partyId, role });
/** An emailed invitation to a party, accepted by the person it was for. */
async function joined(partyId: string, person: Person) {
  const added = await ana.call('POST', `/api/parties/${partyId}/members`, { email: person.email });
  expect(added.status).toBe(200);
  const res = await person.call('POST', '/api/parties/join', { token: added.body.value.token });
  expect(res.status).toBe(200);
  return res.body.value;
}

/** Mailpit's messages to one address. */
async function mailTo(email: string) {
  const res = await fetch(
    `http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
  );
  const body = (await res.json()) as { messages: { Subject: string }[] };
  return body.messages;
}

/** One inbound WhatsApp text, signed as Meta signs it. */
async function inbound(from: string, text: string) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: NUMBER },
              messages: [
                {
                  from,
                  id: `m-parties-${Date.now()}-${seq++}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await fetch(`${server.base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  expect(res.status).toBe(200);
}

const contactOf = async (address: string, tenant = tenantId) =>
  (
    await pool.query(
      'select id, customer_id, user_id from channel.contacts where tenant_id = $1 and address = $2',
      [tenant, address],
    )
  ).rows[0] as { id: string; customer_id: string | null; user_id: string | null } | undefined;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
        return;
      }
      sent.push(JSON.parse(data));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messages: [{ id: `wamid.${Date.now()}.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  process.env.WA_GRAPH_URL = `http://localhost:${(stub.address() as { port: number }).port}`;
  process.env.WA_APP_SECRET = secret;
  process.env.WA_VERIFY_TOKEN = 'test-verify';
  await boot(partiesServer);
  for (const p of [ana, staffer, sita, ravi, outsider, stranger, mallory]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  strangerTenant = (await me(stranger)).tenantId;
  await addMember(staffer, tenantId, ['staff']);
  expect(
    (await ana.call('POST', '/api/channels/whatsapp/number', { phoneNumberId: NUMBER })).status,
  ).toBe(201);
});
afterAll(async () => {
  stub.close();
  await shutdown();
});

describe('parties', () => {
  it('the team adds, reads, changes and removes them; every write is audited', async () => {
    const made = await ana.call('POST', '/api/parties', { kind: 'person', name: 'Leela' });
    expect(made.status).toBe(200);
    expect(made.body.value).toMatchObject({ kind: 'person', name: 'Leela', customerId: null });
    const id = made.body.value.id;
    expect((await ana.call('GET', '/api/parties?kind=person&q=lee')).body).toEqual([
      expect.objectContaining({ id, name: 'Leela' }),
    ]);
    const edited = await ana.call('PATCH', `/api/parties/${id}`, { name: 'Leela R' });
    expect(edited.body.value.name).toBe('Leela R');
    expect((await ana.call('GET', `/api/parties/${id}`)).body).toMatchObject({
      name: 'Leela R',
      members: [],
    });
    expect((await ana.call('DELETE', `/api/parties/${id}`)).status).toBe(200);
    expect((await ana.call('GET', `/api/parties/${id}`)).status).toBe(404);
    // The command's row, and one per record it touched.
    expect((await audits('parties.create')).length).toBeGreaterThanOrEqual(1);
    for (const action of ['party.create', 'parties.edit', 'party.update', 'parties.remove'])
      expect((await audits(action)).map((a) => a.resource_id)).toContain(id);
    const [removed] = (await audits('party.delete')).filter((a) => a.resource_id === id);
    expect(removed.before).toMatchObject({ name: 'Leela R' });
  });

  it('staff read them but may not change them; another business never sees them', async () => {
    const party = await newParty('organisation', 'Acme Glass');
    expect((await inAna(staffer)('GET', `/api/parties/${party.id}`)).status).toBe(200);
    const refused = await inAna(staffer)('PATCH', `/api/parties/${party.id}`, { name: 'Mine' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'parties_manage' });
    expect((await audits('parties.edit', 'denied')).length).toBeGreaterThanOrEqual(1);
    expect((await stranger.call('GET', `/api/parties/${party.id}`)).status).toBe(404);
    expect((await stranger.call('PATCH', `/api/parties/${party.id}`, { name: 'X' })).status).toBe(
      404,
    );
    expect((await stranger.call('GET', '/api/parties')).body).toEqual([]);
  });

  it('belongs to a customer of its own business only (several people of one customer)', async () => {
    const theirs = await seedContact(tenantId, 'Grouped Customer', phone());
    const made = await ana.call('POST', '/api/parties', {
      kind: 'person',
      name: 'Grouped member',
      customerId: theirs.customerId,
    });
    expect(made.body.value.customerId).toBe(theirs.customerId);
    expect(
      (await ana.call('GET', `/api/parties?customerId=${theirs.customerId}`)).body.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([made.body.value.id]);
    const other = await seedContact(strangerTenant, 'Not Ana Customer', phone());
    expect(
      (
        await ana.call('POST', '/api/parties', {
          kind: 'person',
          name: 'Nope',
          customerId: other.customerId,
        })
      ).status,
    ).toBe(404);
  });
});

describe('party members', () => {
  it("by number: the business's contact for it, with no customer record, once", async () => {
    const party = await newParty('organisation', 'Numbers Ltd');
    const address = phone();
    const added = await ana.call('POST', `/api/parties/${party.id}/members`, {
      address,
      name: 'Dispatch desk',
    });
    expect(added.status).toBe(200);
    expect(added.body.value.member).toMatchObject({ address, name: 'Dispatch desk' });
    expect(added.body.value.token).toBeUndefined();
    const contact = await contactOf(address);
    expect(contact?.customer_id).toBeNull();
    const again = await ana.call('POST', `/api/parties/${party.id}/members`, { address });
    expect(again.body.value.member.id).toBe(added.body.value.member.id);
    expect((await ana.call('GET', `/api/parties/${party.id}`)).body.members).toHaveLength(1);
    // Not a number, or both kinds at once: 400.
    expect(
      (await ana.call('POST', `/api/parties/${party.id}/members`, { address: '+91 98' })).status,
    ).toBe(400);
    expect(
      (
        await ana.call('POST', `/api/parties/${party.id}/members`, {
          address,
          email: 'x@test.local',
        })
      ).status,
    ).toBe(400);
  });

  it('by email: the link works once, for that account, before it expires', async () => {
    const party = await newParty('person', 'Sita');
    const added = await ana.call('POST', `/api/parties/${party.id}/members`, { email: sita.email });
    const { token, member } = added.body.value;
    expect(token).toEqual(expect.any(String));
    expect(member).toMatchObject({ email: sita.email, userId: null, joinedAt: null });
    // The audit row keeps no token.
    const [row] = await audits('parties.members.add');
    expect(JSON.stringify(row)).not.toContain(token);
    // Another account: 403. Then the right one.
    const wrong = await outsider.call('POST', '/api/parties/join', { token });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ rule: 'invite_email' });
    const ok = await sita.call('POST', '/api/parties/join', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toMatchObject({ tenantId, member: { userId: sita.id } });
    expect((await sita.call('POST', '/api/parties/join', { token })).status).toBe(404);
    // An expired one is 404 like an unknown one.
    const late = await ana.call('POST', `/api/parties/${party.id}/members`, { email: ravi.email });
    await pool.query(
      "update app.party_members set expires_at = now() - interval '1 minute' where id = $1",
      [late.body.value.member.id],
    );
    expect(
      (await ravi.call('POST', '/api/parties/join', { token: late.body.value.token })).status,
    ).toBe(404);
    expect(
      (await ravi.call('POST', '/api/parties/join', { token: 'no-such-token-at-all' })).status,
    ).toBe(404);
    // Joining a party makes nobody a member of the business.
    const { rows } = await pool.query(
      'select 1 from app.memberships where tenant_id = $1 and user_id = $2',
      [tenantId, sita.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("another business's members are 404, to see or remove", async () => {
    const party = await newParty('organisation', 'Removal Co');
    const added = await ana.call('POST', `/api/parties/${party.id}/members`, { address: phone() });
    const memberId = added.body.value.member.id;
    expect(
      (await stranger.call('DELETE', `/api/parties/${party.id}/members/${memberId}`)).status,
    ).toBe(404);
    expect((await ana.call('DELETE', `/api/parties/${party.id}/members/${memberId}`)).status).toBe(
      200,
    );
    expect((await ana.call('GET', `/api/parties/${party.id}`)).body.members).toEqual([]);
  });
});

describe('participations', () => {
  it('a declared role, on a record and a party it fits, that the caller reaches', async () => {
    const kase = await newCase('Fit check');
    const person = await newParty('person', 'Fit person');
    const org = await newParty('organisation', 'Fit org');
    const bad = async (partyId: string, role: string, resourceType = 'case', id = kase.id) => {
      const res = await put(partyId, id, role, resourceType);
      expect(res.status).toBe(400);
      return res.body.reason;
    };
    expect(await bad(person.id, 'fixture_nobody')).toMatch(/not a participant role/);
    expect(await bad(person.id, 'fixture_partner')).toMatch(/A person cannot be/);
    expect(await bad(org.id, 'fixture_client')).toMatch(/An? organisation cannot be/);
    const task = (await ana.call('POST', '/api/tasks', { title: 'Not a case' })).body.value;
    expect(await bad(person.id, 'fixture_client', 'task', task.id)).toMatch(/not a role on a task/);
    // A record or a party of another business: 404.
    const theirCase = (await stranger.call('POST', '/api/cases', { title: 'Theirs' })).body.value;
    expect((await put(person.id, theirCase.id, 'fixture_client')).status).toBe(404);
    const theirParty = await newParty('person', 'Theirs', stranger);
    expect((await put(theirParty.id, kase.id, 'fixture_client')).status).toBe(404);
    // Staff do not manage them, not even on their own case.
    const staffCase = (await inAna(staffer)('POST', '/api/cases', { title: 'Staff case' })).body
      .value;
    const asStaff = await inAna(staffer)('POST', '/api/participants', {
      resourceType: 'case',
      resourceId: staffCase.id,
      partyId: person.id,
      role: 'fixture_client',
    });
    expect(asStaff.status).toBe(403);
    expect(asStaff.body).toMatchObject({ rule: 'parties_manage' });
    // Twice is once.
    const first = await put(person.id, kase.id, 'fixture_client');
    expect(first.body.value).toMatchObject({
      role: 'fixture_client',
      party: { name: 'Fit person', kind: 'person' },
    });
    expect((await put(person.id, kase.id, 'fixture_client')).body.value.id).toBe(
      first.body.value.id,
    );
    expect((await audits('participants.add')).length).toBeGreaterThanOrEqual(1);
  });

  it("lists a record's participants for the team that reaches it", async () => {
    const kase = await newCase('Listing');
    const person = await newParty('person', 'Listed');
    await put(person.id, kase.id, 'fixture_observer');
    const list = await ana.call('GET', `/api/participants?resourceType=case&resourceId=${kase.id}`);
    expect(list.body).toEqual([
      expect.objectContaining({ partyId: person.id, role: 'fixture_observer' }),
    ]);
    // Staff reach only their own cases: Ana's is 404 to them; another business's to anyone.
    expect(
      (await inAna(staffer)('GET', `/api/participants?resourceType=case&resourceId=${kase.id}`))
        .status,
    ).toBe(404);
    expect(
      (await stranger.call('GET', `/api/participants?resourceType=case&resourceId=${kase.id}`))
        .status,
    ).toBe(404);
    const roles = (await ana.call('GET', '/api/participants/roles')).body;
    expect(roles.map((r: { name: string }) => r.name)).toEqual([
      'fixture_client',
      'fixture_observer',
      'fixture_partner',
    ]);
    expect(roles[0]).toMatchObject({ kinds: ['person'], on: ['case'] });
    expect(roles[1]).toMatchObject({ kinds: ['person', 'organisation'] });
  });

  it('participant roles naming an entity nobody serves stop the start', () => {
    expect(() => checkParticipantRoles(new Set(['case']))).not.toThrow();
    expect(() => checkParticipantRoles(new Set(['task']))).toThrow(/"case", which is no entity/);
  });
});

describe('the participant grant', () => {
  let shared: { id: string };
  let other: { id: string };
  let clientParty: { id: string };
  let observerParty: { id: string };

  beforeAll(async () => {
    shared = await newCase('Shared case', 9000);
    other = await newCase('Not shared', 7000);
    clientParty = await newParty('person', 'Sita client');
    await joined(clientParty.id, sita);
    observerParty = await newParty('person', 'Ravi observer');
    await joined(observerParty.id, ravi);
    await put(clientParty.id, shared.id, 'fixture_client');
    await put(observerParty.id, shared.id, 'fixture_observer');
  });

  it('reaches only the records their parties are on, without hidden fields', async () => {
    const list = await inAna(sita)('GET', '/api/cases');
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([shared.id]);
    expect(list.body.items[0]).not.toHaveProperty('budget');
    expect((await inAna(sita)('GET', `/api/cases/${other.id}`)).status).toBe(404);
    const one = await inAna(ravi)('GET', `/api/cases/${shared.id}`);
    expect(one.body).toMatchObject({ id: shared.id, title: 'Shared case' });
    expect(one.body).not.toHaveProperty('budget');
    // Filtering on it is refused, as for anyone who cannot read it.
    const filtered = await inAna(sita)('GET', '/api/cases?budget[gte]=1');
    expect(filtered.status).toBe(403);
    expect(filtered.body).toMatchObject({ rule: 'field_hidden' });
  });

  it('writes only in the roles the rule names: a client changes, an observer does not', async () => {
    const changed = await inAna(sita)('PATCH', `/api/cases/${shared.id}`, { title: 'Shared case' });
    expect(changed.status).toBe(200);
    expect((await inAna(ravi)('PATCH', `/api/cases/${shared.id}`, { title: 'No' })).status).toBe(
      404,
    );
    expect((await inAna(sita)('PATCH', `/api/cases/${other.id}`, { title: 'No' })).status).toBe(
      404,
    );
    // Nobody participates in a new record: a participant makes none.
    expect((await inAna(sita)('POST', '/api/cases', { title: 'Mine' })).status).toBe(403);
    // A field they cannot read, they cannot write.
    expect((await inAna(sita)('PATCH', `/api/cases/${shared.id}`, { budget: 1 })).status).toBe(403);
  });

  it('children follow their record: a client adds notes under it, an observer reads them', async () => {
    const note = await inAna(sita)('POST', '/api/caseNotes', { caseId: shared.id, text: 'Hello' });
    expect(note.status).toBe(201);
    expect(note.body.value).toMatchObject({ caseId: shared.id, text: 'Hello' });
    expect(
      (await inAna(sita)('POST', '/api/caseNotes', { caseId: other.id, text: 'No' })).status,
    ).toBe(403);
    expect(
      (await inAna(ravi)('POST', '/api/caseNotes', { caseId: shared.id, text: 'No' })).status,
    ).toBe(403);
    const notes = await inAna(ravi)('GET', `/api/caseNotes?caseId=${shared.id}`);
    expect(notes.body.items.map((n: { text: string }) => n.text)).toEqual(['Hello']);
    await ana.call('POST', '/api/caseNotes', { caseId: other.id, text: 'Team only' });
    expect(
      (await inAna(ravi)('GET', '/api/caseNotes')).body.items.map((n: { text: string }) => n.text),
    ).toEqual(['Hello']);
  });

  it('an organisation reached on WhatsApp reads what it is on, through the assistant', async () => {
    const org = await newParty('organisation', 'Partner Org');
    const address = phone();
    const { member } = (
      await ana.call('POST', `/api/parties/${org.id}/members`, { address, name: 'Partner desk' })
    ).body.value;
    await put(org.id, shared.id, 'fixture_partner');
    const asDesk = asAssistant(`contact:${member.contactId}`);
    const list = await asDesk('GET', '/api/cases');
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([shared.id]);
    expect(list.body.items[0]).not.toHaveProperty('budget');
    expect((await asDesk('GET', `/api/cases/${other.id}`)).status).toBe(404);
    // A partner reads; only a client changes. Its assistant's change waits for the business
    // (as anyone's does here), and approving it changes nothing: the row is not theirs to write.
    const asked = await asDesk('PATCH', `/api/cases/${shared.id}`, { title: 'No' });
    expect(asked.body.status).toBe('needs_approval');
    await ana.call('POST', `/api/approvals/${asked.body.approval.id}/approve`);
    expect((await ana.call('GET', `/api/cases/${shared.id}`)).body.title).toBe('Shared case');
    // It writes in on WhatsApp: the assistant answers it as that contact, never as a customer.
    await inbound(address, 'hello');
    await eventually(() => sent.find((s) => s.to === address && s.type === 'text'), 15_000);
    expect((await contactOf(address))?.customer_id).toBeNull();
  });

  it("another business's participation reaches nothing here", async () => {
    // Mallory is a member of a party of the stranger's business, put (by hand) on Ana's case.
    const theirs = await newParty('person', 'Mallory', stranger);
    await pool.query(
      `insert into app.party_members (tenant_id, party_id, user_id, joined_at, added_by)
       values ($1, $2, $3, now(), $4)`,
      [strangerTenant, theirs.id, mallory.id, stranger.id],
    );
    await pool.query(
      `insert into app.participations (tenant_id, resource_type, resource_id, party_id, role, added_by)
       values ($1, 'case', $2, $3, 'fixture_client', $4)`,
      [strangerTenant, shared.id, theirs.id, stranger.id],
    );
    const inStranger = (m: string, p: string) =>
      mallory.call(m, p, undefined, { 'x-tenant-id': strangerTenant });
    expect((await inStranger('GET', `/api/cases/${shared.id}`)).status).toBe(404);
    expect((await inStranger('GET', '/api/cases')).body.items).toEqual([]);
    const inAnas = await mallory.call('GET', '/api/cases', undefined, { 'x-tenant-id': tenantId });
    expect(inAnas.status).toBe(403);
    expect(inAnas.body).toMatchObject({ rule: 'not_a_member' });
  });

  it("an assistant's change for a participant parks, and the park is audited", async () => {
    const forSita = asAssistant(`user:${sita.id}`, { 'x-tenant-id': tenantId, 'x-channel': 'app' });
    const parked = await forSita('PATCH', `/api/cases/${shared.id}`, {
      title: 'Asked by assistant',
    });
    expect(parked.body.status).toBe('needs_approval');
    expect((await audits('case.update', 'needs_approval')).length).toBeGreaterThanOrEqual(1);
  });

  it('taking a party off a record ends its reach; deleting the record ends its participations', async () => {
    const kase = await newCase('Short lived');
    const added = await put(clientParty.id, kase.id, 'fixture_client');
    expect((await inAna(sita)('GET', `/api/cases/${kase.id}`)).status).toBe(200);
    expect((await stranger.call('DELETE', `/api/participants/${added.body.value.id}`)).status).toBe(
      404,
    );
    expect((await ana.call('DELETE', `/api/participants/${added.body.value.id}`)).status).toBe(200);
    expect((await inAna(sita)('GET', `/api/cases/${kase.id}`)).status).toBe(404);
    await put(clientParty.id, kase.id, 'fixture_client');
    expect((await ana.call('DELETE', `/api/cases/${kase.id}`)).status).toBe(200);
    const { rows } = await pool.query(
      "select 1 from app.participations where resource_type = 'case' and resource_id = $1",
      [kase.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('participants are never members', () => {
  it('/api/me lists every business, as member or participant, and x-tenant-id switches', async () => {
    const mine = (await sita.call('GET', '/api/me')).body;
    // Her own business (sign-up made one) is the default; Ana's is one she participates in.
    expect(mine.as).toBe('member');
    expect(mine.businesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: mine.tenantId, as: 'member', isDefault: true }),
        expect.objectContaining({
          tenantId,
          name: expect.any(String),
          as: 'participant',
          roles: ['customer'],
          participantRoles: ['fixture_client'],
          isDefault: false,
        }),
      ]),
    );
    const there = (await inAna(sita)('GET', '/api/me')).body;
    expect(there).toMatchObject({ tenantId, as: 'participant', roles: ['customer'] });
    expect(there.capabilities).not.toContain('members.read');
    expect(there.capabilities).not.toContain('parties.read');
    // No team screens: members, parties.
    expect((await inAna(sita)('GET', '/api/members')).status).toBe(403);
    expect((await inAna(sita)('GET', '/api/parties')).status).toBe(403);
    // Ana's member list does not hold her.
    const members = (await ana.call('GET', '/api/members')).body.map(
      (m: { userId: string }) => m.userId,
    );
    expect(members).not.toContain(sita.id);
    // A business she is not in: 403.
    expect(
      (await sita.call('GET', '/api/me', undefined, { 'x-tenant-id': strangerTenant })).status,
    ).toBe(403);
  });

  it('a default business is one of their memberships, never a participant one', async () => {
    await addMember(ana, strangerTenant, ['staff']);
    const changed = await ana.call('PUT', '/api/me/default', { tenantId: strangerTenant });
    expect(changed.status).toBe(200);
    expect((await me(ana)).tenantId).toBe(strangerTenant);
    expect((await ana.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
    expect((await me(ana)).tenantId).toBe(tenantId);
    const [row] = await audits('me.default');
    expect(row).toMatchObject({ outcome: 'committed' });
    expect((await sita.call('PUT', '/api/me/default', { tenantId })).status).toBe(404);
    expect((await outsider.call('PUT', '/api/me/default', { tenantId })).status).toBe(404);
  });

  it("a number linked to a participant's account acts as that person", async () => {
    const address = phone();
    const contact = await seedContact(tenantId, 'Sita phone', address);
    await pool.query('update channel.contacts set user_id = $1, linked_at = now() where id = $2', [
      sita.id,
      contact.contactId,
    ]);
    const viaPhone = asAssistant(`contact:${contact.contactId}`);
    const list = await viaPhone('GET', '/api/cases');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
  });
});

describe('notifications to parties', () => {
  it("everyone on a record, in the roles named, hears it; a partner's number does not", async () => {
    const kase = await newCase('Notify me');
    const clients = await newParty('person', 'Notify Sita');
    await joined(clients.id, sita);
    const observers = await newParty('person', 'Notify Ravi');
    await joined(observers.id, ravi);
    await put(clients.id, kase.id, 'fixture_client');
    await put(observers.id, kase.id, 'fixture_observer');
    expect(
      (await ana.call('PATCH', `/api/cases/${kase.id}`, { title: 'Notify me now' })).status,
    ).toBe(200);
    for (const person of [sita, ravi])
      await eventually(async () => {
        const mails = await mailTo(person.email);
        return mails.find((m) => m.Subject === 'Case changed: Notify me now');
      }, 20_000);
  });

  it('expands a party and a record into people, once each, in the business only', async () => {
    const { partiesTo } = await import('../../dist/channels/notify/parties-to.js');
    const { DB } = await import('../../dist/infra/db.module.js');
    const conn = server.app?.get(DB);
    const party = await newParty('organisation', 'Expand Org');
    const address = phone();
    const { member } = (await ana.call('POST', `/api/parties/${party.id}/members`, { address }))
      .body.value;
    // A pending invitation reaches nobody.
    await ana.call('POST', `/api/parties/${party.id}/members`, { email: 'pending@test.local' });
    expect(await partiesTo(conn, tenantId, { partyId: party.id })).toEqual([
      { contactId: member.contactId },
    ]);
    // Another business's party: nobody.
    expect(await partiesTo(conn, strangerTenant, { partyId: party.id })).toEqual([]);
    const kase = await newCase('Expand');
    await put(party.id, kase.id, 'fixture_partner');
    const sitaParty = await newParty('person', 'Expand Sita');
    await joined(sitaParty.id, sita);
    await put(sitaParty.id, kase.id, 'fixture_client');
    const everyone = await partiesTo(conn, tenantId, {
      participantsOf: { type: 'case', id: kase.id },
    });
    expect(everyone).toEqual(
      expect.arrayContaining([{ contactId: member.contactId }, { userId: sita.id }]),
    );
    expect(everyone).toHaveLength(2);
    expect(
      await partiesTo(conn, tenantId, {
        participantsOf: { type: 'case', id: kase.id },
        as: ['fixture_client'],
      }),
    ).toEqual([{ userId: sita.id }]);
  });
});

describe('unknown senders, erasure and export', () => {
  it("as the business's setting says: a customer (the default), or only a contact", async () => {
    const first = phone();
    await inbound(first, 'hi there');
    await eventually(async () => (await contactOf(first))?.id);
    expect((await contactOf(first))?.customer_id).toEqual(expect.any(String));
    await pool.query(
      `update app.tenants set settings = settings || '{"parties":{"unknownSenders":"contact"}}'
       where id = $1`,
      [tenantId],
    );
    await settingsChanged(tenantId);
    const second = phone();
    await inbound(second, 'hello');
    await eventually(async () => (await contactOf(second))?.id);
    expect((await contactOf(second))?.customer_id).toBeNull();
    await pool.query("update app.tenants set settings = settings - 'parties' where id = $1", [
      tenantId,
    ]);
    await settingsChanged(tenantId);
  });

  it('erasing a contact removes its memberships, and a person party left with nobody', async () => {
    const { ErasureService } = await import('../../dist/channels/maintenance/erasure.service.js');
    const { exportPersonalData } = await import('../../dist/privacy/contributors.js');
    const { DB } = await import('../../dist/infra/db.module.js');
    const kase = await newCase('Erase me');
    const person = await newParty('person', 'Only by phone');
    const org = await newParty('organisation', 'Keeps going');
    const address = phone();
    const { member } = (await ana.call('POST', `/api/parties/${person.id}/members`, { address }))
      .body.value;
    await ana.call('POST', `/api/parties/${org.id}/members`, { address });
    await put(person.id, kase.id, 'fixture_observer');
    const exported = await exportPersonalData({
      subject: { kind: 'contact', contactId: member.contactId },
      tenantId,
      db: server.app?.get(DB),
    });
    expect(exported.parties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          party: expect.objectContaining({ id: person.id }),
          participations: [{ resourceType: 'case', resourceId: kase.id, role: 'fixture_observer' }],
        }),
        expect.objectContaining({ party: expect.objectContaining({ id: org.id }) }),
      ]),
    );
    await server.app?.get(ErasureService).erase(member.contactId);
    expect((await ana.call('GET', `/api/parties/${person.id}`)).status).toBe(404);
    expect((await ana.call('GET', `/api/parties/${org.id}`)).body.members).toEqual([]);
    expect(
      (await ana.call('GET', `/api/participants?resourceType=case&resourceId=${kase.id}`)).body,
    ).toEqual([]);
    const [erased] = (
      await pool.query(
        "select after from audit.events where action = 'channel.contact.erased' and resource_id = $1",
        [member.contactId],
      )
    ).rows;
    expect(erased.after.contributors.parties).toBe(3);
  });
});
