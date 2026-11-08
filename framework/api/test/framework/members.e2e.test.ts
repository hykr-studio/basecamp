// Roles, members, invitations, per-record grants and field policy (A4). The fixture's
// src/features/members adds a `projects` module (a cost only some capabilities read, steps that
// follow their project's grants, a command hiding the cost), its own roles and capabilities, an
// override of the framework's staff, and the roles a creator and a contact get. Also (H1): a
// notification's words read as each recipient may, and requests by someone outside the team.
import { entitySpec, type Principal } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  eventFor,
  fieldPolicyProblems,
  PrincipalResolver,
  TenantConfigService,
  toEnvelope,
} from '@hykr/core';
import { domainEvents } from '@hykr/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  shutdown,
  stamp,
} from '../../dist/testing.js';
import { membersServer } from '../fixture/dist/features/members/index.js';

const ana = new Person('Ana Members');
const crew = new Person('Crew Members');
const estimator = new Person('Estimator Members');
const staffer = new Person('Staff Members');
const lead = new Person('Lead Members');
const invitee = new Person('Invitee Members');
const outsider = new Person('Outsider Members');
const stranger = new Person('Stranger Members');
const strangerStaff = new Person('Stranger Staff Members');
const client = new Person('Client Members');
let tenantId = '';
let strangerTenant = '';

/** A person's calls inside Ana's business. */
const inAna = (p: Person) => (method: string, path: string, body?: unknown) =>
  p.call(method, path, body, { 'x-tenant-id': tenantId });

/** What the server resolves for a member of Ana's business, as a principal. */
async function principalOf(person: Person, tenant = tenantId): Promise<Principal> {
  const resolver = server.app?.get(PrincipalResolver) as PrincipalResolver;
  const standing = await resolver.forUser(person.id, { tenantId: tenant });
  return { actor: { kind: 'user', id: person.id }, scopes: [], ...standing };
}

const audits = async (action: string, outcome?: string) =>
  (
    await pool.query(
      `select action, outcome, rule, resource_id, before, after from audit.events
       where tenant_id = $1 and action = $2 ${outcome ? 'and outcome = $3' : ''} order by at`,
      outcome ? [tenantId, action, outcome] : [tenantId, action],
    )
  ).rows;

const newProject = async (body: { title: string; cost?: number }, who = ana) =>
  (await inAna(who)('POST', '/api/projects', body)).body.value;

beforeAll(async () => {
  await boot(membersServer);
  for (const p of [
    ana,
    crew,
    estimator,
    staffer,
    lead,
    invitee,
    outsider,
    stranger,
    strangerStaff,
    client,
  ])
    await p.signUp();
  tenantId = (await me(ana)).tenantId;
  strangerTenant = (await me(stranger)).tenantId;
  await addMember(crew, tenantId, ['fixture_crew']);
  await addMember(estimator, tenantId, ['fixture_estimator']);
  await addMember(staffer, tenantId, ['staff']);
  await addMember(lead, tenantId, ['staff']);
  await addMember(strangerStaff, strangerTenant, ['staff']);
  // A client with an account: in Ana's business they hold only the role contacts get.
  await addMember(client, tenantId, ['fixture_client']);
});
afterAll(shutdown);

/** A person's in-app inbox item for a notification, in any business. */
const inboxItem = async (p: Person, dedupe: string) =>
  (
    await pool.query(
      'select tenant_id, title, body from channel.inbox_items where user_id = $1 and dedupe = $2',
      [p.id, dedupe],
    )
  ).rows[0] as { tenant_id: string; title: string; body: string } | undefined;

/** The text of the email with this subject sent to this person, from Mailpit. */
async function mailText(p: Person, subject: string): Promise<string | undefined> {
  // By address only: the search syntax would take apart a subject that holds a double mark.
  const query = encodeURIComponent(`to:"${p.email}"`);
  const found = (await (
    await fetch(`http://localhost:8025/api/v1/search?query=${query}`)
  ).json()) as {
    messages: { ID: string; Subject: string }[];
  };
  const hit = found.messages.find((m) => m.Subject === subject);
  if (!hit) return undefined;
  const one = (await (await fetch(`http://localhost:8025/api/v1/message/${hit.ID}`)).json()) as {
    Text: string;
  };
  return one.Text;
}

describe('roles the application declares and overrides', () => {
  it('a creator gets the roles the application names', async () => {
    const mine = (await ana.call('GET', '/api/me')).body;
    expect(mine.roles).toEqual(['owner', 'admin']);
    expect(mine.capabilities).toEqual(
      expect.arrayContaining([
        'members.manage',
        'members.read',
        'records.grant',
        'fixture.cost.read',
      ]),
    );
  });

  it("an override relabels the framework's staff and replaces what it may do", async () => {
    expect((await inAna(staffer)('GET', '/api/me')).body.capabilities).toEqual([
      'backoffice.use',
      'members.read',
    ]);
    const { roles } = (await inAna(staffer)('GET', '/api/members/roles')).body;
    expect(roles.find((r: { name: string }) => r.name === 'staff')).toMatchObject({
      label: { en: 'Team member' },
      source: 'framework',
      edited: false,
      capabilities: ['backoffice.use', 'members.read'],
    });
    expect(roles.find((r: { name: string }) => r.name === 'fixture_crew')).toMatchObject({
      source: 'application',
    });
  });

  it('a contact gets the role the application names for contacts', async () => {
    const { contactId } = await seedContact(tenantId, 'Kiran', `+9198${Date.now() % 1e8}`);
    const resolver = server.app?.get(PrincipalResolver) as PrincipalResolver;
    expect((await resolver.forContact(contactId)).roles).toEqual(['fixture_client']);
  });
});

describe("a business's own roles", () => {
  it('a manager defines a role from capabilities; members holding it reach rows through them', async () => {
    const defined = await ana.call('POST', '/api/members/roles', {
      name: 'site_lead',
      label: { en: 'Site lead' },
      capabilities: ['fixture.projects.all', 'members.read'],
    });
    expect(defined.status).toBe(200);
    expect(defined.body.value).toMatchObject({
      name: 'site_lead',
      label: { en: 'Site lead', hi: 'Site lead', te: 'Site lead' },
      source: 'business',
      capabilities: ['fixture.projects.all', 'members.read'],
    });
    const project = await newProject({ title: 'Lead sees every project', cost: 100 });
    expect((await inAna(lead)('GET', `/api/projects/${project.id}`)).status).toBe(404);

    expect(
      (await ana.call('PATCH', `/api/members/${lead.id}`, { roles: ['site_lead'] })).status,
    ).toBe(200);
    expect((await inAna(lead)('GET', '/api/me')).body).toMatchObject({
      roles: ['site_lead'],
      capabilities: ['fixture.projects.all', 'members.read'],
    });
    // The capability key in the projects' access reaches every project; the cost stays hidden.
    const seen = await inAna(lead)('GET', `/api/projects/${project.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body).not.toHaveProperty('cost');

    // Taking the capability away takes the rows away.
    const edited = await ana.call('PATCH', '/api/members/roles/site_lead', {
      capabilities: ['members.read'],
      label: { en: 'Lead', hi: 'लीड' },
    });
    expect(edited.body.value).toMatchObject({ label: { en: 'Lead', hi: 'लीड', te: 'Lead' } });
    expect((await inAna(lead)('GET', `/api/projects/${project.id}`)).status).toBe(404);
    expect(await audits('roles.edit')).toHaveLength(1);
  });

  it('refuses a declared name, a capability only code gives, and one nobody defines', async () => {
    const define = (name: string, capabilities: string[]) =>
      ana.call('POST', '/api/members/roles', { name, label: { en: name }, capabilities });
    expect((await define('owner', [])).body).toMatchObject({ rule: 'role_exists' });
    expect((await define('site_lead', [])).body).toMatchObject({ rule: 'role_exists' });
    expect((await define('watcher', ['shared.publish'])).body).toMatchObject({
      rule: 'bad_capability',
    });
    expect((await define('watcher', ['nope.nothing'])).body).toMatchObject({
      rule: 'bad_capability',
    });
    expect((await define('Watcher Two', [])).status).toBe(400);
    expect((await audits('roles.define', 'denied')).length).toBeGreaterThanOrEqual(4);
  });

  it('only people who manage members change roles', async () => {
    const res = await inAna(staffer)('POST', '/api/members/roles', {
      name: 'sneaky',
      label: { en: 'Sneaky' },
      capabilities: ['members.manage'],
    });
    expect(res.status).toBe(403);
    expect(res.body.rule).toBe('members_manage');
    expect((await inAna(crew)('GET', '/api/members/roles')).body.rule).toBe('members_read');
  });

  it('a business edits a declared role for itself only, and puts it back', async () => {
    const edit = await ana.call('PATCH', '/api/members/roles/staff', {
      label: { en: 'Crew lead' },
      capabilities: ['backoffice.use', 'members.read', 'fixture.cost.read'],
    });
    expect(edit.body.value).toMatchObject({ name: 'staff', edited: true, source: 'framework' });
    expect((await inAna(staffer)('GET', '/api/me')).body.capabilities).toContain(
      'fixture.cost.read',
    );
    // Another business's staff keeps the application's staff.
    expect(
      (await strangerStaff.call('GET', '/api/me', undefined, { 'x-tenant-id': strangerTenant }))
        .body.capabilities,
    ).toEqual(['backoffice.use', 'members.read']);
    // A capability only code gives cannot be added by an edit either.
    expect(
      (await ana.call('PATCH', '/api/members/roles/staff', { capabilities: ['shared.publish'] }))
        .body.rule,
    ).toBe('bad_capability');

    await ana.call('PATCH', '/api/members/roles/staff', { label: null, capabilities: null });
    const { roles } = (await ana.call('GET', '/api/members/roles')).body;
    expect(roles.find((r: { name: string }) => r.name === 'staff')).toMatchObject({
      label: { en: 'Team member' },
      edited: false,
    });
    expect((await ana.call('DELETE', '/api/members/roles/staff')).body.rule).toBe('declared_role');
  });

  it('deleting a business role takes it from every member', async () => {
    await ana.call('POST', '/api/members/roles', {
      name: 'temp_role',
      label: { en: 'Temporary' },
      capabilities: ['members.read'],
    });
    await ana.call('PATCH', `/api/members/${lead.id}`, { roles: ['site_lead', 'temp_role'] });
    expect((await ana.call('DELETE', '/api/members/roles/temp_role')).status).toBe(200);
    const { rows } = await pool.query(
      'select roles from app.memberships where tenant_id = $1 and user_id = $2',
      [tenantId, lead.id],
    );
    expect(rows[0].roles).toEqual(['site_lead']);
    expect((await ana.call('DELETE', '/api/members/roles/temp_role')).status).toBe(404);
  });

  it('never leaves the business without someone who manages members', async () => {
    expect(
      (await ana.call('PATCH', `/api/members/${ana.id}`, { roles: ['staff'] })).body.rule,
    ).toBe('last_manager');
    // Owner without members.manage is fine while Ana is also an admin...
    expect(
      (await ana.call('PATCH', '/api/members/roles/owner', { capabilities: ['backoffice.use'] }))
        .status,
    ).toBe(200);
    // ...but not admin too.
    expect(
      (await ana.call('PATCH', '/api/members/roles/admin', { capabilities: ['backoffice.use'] }))
        .body.rule,
    ).toBe('last_manager');
    await ana.call('PATCH', '/api/members/roles/owner', { capabilities: null });
    expect((await ana.call('GET', '/api/me')).body.capabilities).toContain('members.manage');
  });

  it('a roles section that does not parse leaves the roles but no capability (fail closed)', async () => {
    const config = server.app?.get(TenantConfigService) as TenantConfigService;
    await pool.query(
      `update app.tenants set settings = '{"roles": {"defined": "every"}}' where id = $1`,
      [strangerTenant],
    );
    config.invalidate(strangerTenant);
    try {
      expect((await stranger.call('GET', '/api/me')).body).toMatchObject({
        roles: ['owner', 'admin'],
        capabilities: [],
      });
      expect((await stranger.call('GET', '/api/members/roles')).status).toBe(403);
    } finally {
      await pool.query(`update app.tenants set settings = '{}' where id = $1`, [strangerTenant]);
      config.invalidate(strangerTenant);
    }
    expect((await stranger.call('GET', '/api/me')).body.capabilities).toContain('members.manage');
  });

  it('another section that does not parse leaves the capabilities, so it can be repaired', async () => {
    const config = server.app?.get(TenantConfigService) as TenantConfigService;
    expect((await stranger.call('GET', '/api/me')).body.capabilities).toContain('history.all');
    await pool.query(
      `update app.tenants set settings = '{"marketingPerWeek": "lots", "roles": {"edits": {"admin": {"capabilities": ["members.read"]}}}}' where id = $1`,
      [strangerTenant],
    );
    config.invalidate(strangerTenant);
    try {
      await expect(config.get(strangerTenant)).rejects.toThrow();
      expect((await config.section(strangerTenant, 'roles')).edits).toHaveProperty('admin');
      // The roles section still parses, its edits included: the owner's capabilities stay,
      // and the admin's edit took `history.all` (which only the admin held) away.
      const now = (await stranger.call('GET', '/api/me')).body;
      expect(now.roles).toEqual(['owner', 'admin']);
      expect(now.capabilities).toContain('members.manage');
      expect(now.capabilities).not.toContain('history.all');
      const roles = (await stranger.call('GET', '/api/members/roles')).body.roles;
      expect(roles.find((r: { name: string }) => r.name === 'admin')).toMatchObject({
        capabilities: ['members.read'],
        edited: true,
      });
    } finally {
      await pool.query(`update app.tenants set settings = '{}' where id = $1`, [strangerTenant]);
      config.invalidate(strangerTenant);
    }
  });

  it("another business never sees or changes this one's roles and members", async () => {
    const theirs = (await stranger.call('GET', '/api/members/roles')).body.roles;
    expect(theirs.map((r: { name: string }) => r.name)).not.toContain('site_lead');
    expect(
      (await stranger.call('PATCH', '/api/members/roles/site_lead', { label: { en: 'x' } })).status,
    ).toBe(404);
    expect(
      (await stranger.call('PATCH', `/api/members/${crew.id}`, { roles: ['staff'] })).status,
    ).toBe(404);
    expect((await stranger.call('DELETE', `/api/members/${crew.id}`)).status).toBe(404);
    const names = (await stranger.call('GET', '/api/members')).body.map(
      (m: { userId: string }) => m.userId,
    );
    expect(names).toEqual(expect.arrayContaining([stranger.id, strangerStaff.id]));
    expect(names).not.toContain(crew.id);
  });
});

describe('members and invitations', () => {
  it('lists members with their roles, for the team only', async () => {
    const list = (await inAna(staffer)('GET', '/api/members')).body;
    expect(list.find((m: { userId: string }) => m.userId === crew.id)).toMatchObject({
      name: 'Crew Members',
      email: crew.email,
      roles: ['fixture_crew'],
    });
    expect((await inAna(crew)('GET', '/api/members')).status).toBe(403);
  });

  it('an invitation is accepted once, by the account with its email, within its days', async () => {
    const created = await ana.call('POST', '/api/members/invites', {
      email: invitee.email.toUpperCase(),
      roles: ['fixture_crew'],
    });
    expect(created.status).toBe(200);
    const { invite, token } = created.body.value;
    expect(invite).toMatchObject({
      email: invitee.email,
      roles: ['fixture_crew'],
      acceptedAt: null,
    });
    const listed = (await ana.call('GET', '/api/members/invites')).body;
    expect(listed[0]).toMatchObject({ id: invite.id });
    expect(JSON.stringify(listed)).not.toContain(token);
    // Neither the audit row nor the table keeps the token.
    const { rows } = await pool.query(
      `select count(*)::int as n from audit.events where after::text like $1`,
      [`%${token}%`],
    );
    expect(rows[0].n).toBe(0);

    expect((await outsider.call('POST', '/api/members/invites/accept', { token })).body.rule).toBe(
      'invite_email',
    );
    const accepted = await invitee.call('POST', '/api/members/invites/accept', { token });
    expect(accepted.body.value).toEqual({ tenantId, roles: ['fixture_crew'] });
    // The business they joined is their default now.
    expect(await me(invitee)).toMatchObject({ tenantId, roles: ['fixture_crew'] });
    expect((await invitee.call('POST', '/api/members/invites/accept', { token })).status).toBe(404);
    expect(await audits('invites.accept')).toHaveLength(1);
  });

  it('a revoked, expired or unknown invitation is not valid', async () => {
    const make = async () =>
      (await ana.call('POST', '/api/members/invites', { email: outsider.email, roles: ['staff'] }))
        .body.value;
    const revoked = await make();
    expect(
      (await stranger.call('DELETE', `/api/members/invites/${revoked.invite.id}`)).status,
    ).toBe(404);
    expect((await ana.call('DELETE', `/api/members/invites/${revoked.invite.id}`)).status).toBe(
      200,
    );
    expect(
      (await outsider.call('POST', '/api/members/invites/accept', { token: revoked.token })).status,
    ).toBe(404);

    const expired = await make();
    await pool.query(
      `update app.member_invites set expires_at = now() - interval '1 minute' where id = $1`,
      [expired.invite.id],
    );
    expect(
      (await outsider.call('POST', '/api/members/invites/accept', { token: expired.token })).status,
    ).toBe(404);
    expect(
      (await outsider.call('POST', '/api/members/invites/accept', { token: 'x'.repeat(43) }))
        .status,
    ).toBe(404);
    expect(
      (await ana.call('POST', '/api/members/invites', { email: outsider.email, roles: ['nobody'] }))
        .body.rule,
    ).toBe('unknown_role');
    expect((await inAna(staffer)('GET', '/api/members/invites')).status).toBe(403);
  });

  it('removes a member and their record grants; never the default owner', async () => {
    const project = await newProject({ title: 'Invitee project' });
    await ana.call('POST', '/api/grants', {
      resourceType: 'project',
      resourceId: project.id,
      userId: invitee.id,
    });
    expect((await ana.call('DELETE', `/api/members/${invitee.id}`)).status).toBe(200);
    const { rows } = await pool.query(
      'select count(*)::int as n from app.record_grants where tenant_id = $1 and user_id = $2',
      [tenantId, invitee.id],
    );
    expect(rows[0].n).toBe(0);
    expect((await ana.call('DELETE', `/api/members/${ana.id}`)).body.rule).toBe('default_owner');
  });
});

describe('record grants', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    a = await newProject({ title: 'Project A', cost: 500 });
    b = await newProject({ title: 'Project B', cost: 700 });
  });

  it('a granted role reaches only the records granted to its person', async () => {
    const before = (await inAna(crew)('GET', '/api/projects')).body.items;
    expect(before.map((j: { id: string }) => j.id)).not.toContain(a.id);
    const granted = await ana.call('POST', '/api/grants', {
      resourceType: 'project',
      resourceId: a.id,
      userId: crew.id,
    });
    expect(granted.body.value).toMatchObject({
      resourceType: 'project',
      resourceId: a.id,
      userId: crew.id,
    });
    // The same grant again is the same grant.
    const again = await ana.call('POST', '/api/grants', {
      resourceType: 'project',
      resourceId: a.id,
      userId: crew.id,
    });
    expect(again.body.value.id).toBe(granted.body.value.id);

    const items = (await inAna(crew)('GET', '/api/projects')).body.items;
    expect(items.map((j: { id: string }) => j.id)).toEqual([a.id]);
    // Their own projects too (the rule is a list): one they make is theirs.
    const mine = (await inAna(crew)('POST', '/api/projects', { title: 'Crew project' })).body.value;
    const both = (await inAna(crew)('GET', '/api/projects')).body.items;
    expect(both.map((j: { id: string }) => j.id)).toEqual([a.id, mine.id]);
    expect((await inAna(crew)('GET', `/api/projects/${a.id}`)).status).toBe(200);
    expect((await inAna(crew)('GET', `/api/projects/${b.id}`)).status).toBe(404);
    expect(
      (await inAna(crew)('PATCH', `/api/projects/${b.id}`, { title: 'Not mine' })).status,
    ).toBe(404);
    expect(
      (await inAna(crew)('PATCH', `/api/projects/${a.id}`, { title: 'Project A, crew' })).body
        .value,
    ).toMatchObject({ title: 'Project A, crew' });

    const grants = (await ana.call('GET', `/api/grants?resourceType=project&resourceId=${a.id}`))
      .body;
    expect(grants.map((g: { userId: string }) => g.userId)).toEqual([crew.id]);
    expect(
      (await inAna(crew)('GET', `/api/grants?resourceType=project&resourceId=${a.id}`)).status,
    ).toBe(403);
  });

  it("a child follows its parent's grant: read, and created only under a granted parent", async () => {
    const stepA = (await ana.call('POST', '/api/steps', { projectId: a.id, title: 'Measure' })).body
      .value;
    await ana.call('POST', '/api/steps', { projectId: b.id, title: 'Not for crew' });
    const steps = (await inAna(crew)('GET', '/api/steps')).body.items;
    expect(steps.map((s: { id: string }) => s.id)).toEqual([stepA.id]);

    const added = await inAna(crew)('POST', '/api/steps', { projectId: a.id, title: 'Cut' });
    expect(added.status).toBe(201);
    const refused = await inAna(crew)('POST', '/api/steps', { projectId: b.id, title: 'Sneak in' });
    expect(refused.status).toBe(403);
    expect(refused.body.rule).toBe('no_access');
  });

  it("another business's record or person cannot be granted", async () => {
    const theirs = (await stranger.call('POST', '/api/projects', { title: 'Stranger project' }))
      .body.value;
    expect(
      (
        await ana.call('POST', '/api/grants', {
          resourceType: 'project',
          resourceId: theirs.id,
          userId: crew.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ana.call('POST', '/api/grants', {
          resourceType: 'project',
          resourceId: a.id,
          userId: stranger.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await ana.call('POST', '/api/grants', {
          resourceType: 'nothing',
          resourceId: a.id,
          userId: crew.id,
        })
      ).status,
    ).toBe(404);
    // Reaching the record is not enough: giving access needs records.grant.
    const own = await newProject({ title: 'Staff project' }, staffer);
    expect(
      (
        await inAna(staffer)('POST', '/api/grants', {
          resourceType: 'project',
          resourceId: own.id,
          userId: crew.id,
        })
      ).body.rule,
    ).toBe('records_grant');
    // Stranger cannot read Ana's grants, or take one back.
    const [grant] = (await ana.call('GET', `/api/grants?resourceType=project&resourceId=${a.id}`))
      .body;
    expect((await stranger.call('DELETE', `/api/grants/${grant.id}`)).status).toBe(404);
    expect(
      (await stranger.call('GET', `/api/grants?resourceType=project&resourceId=${a.id}`)).status,
    ).toBe(404);
  });

  it('revoking hides the record again, and a deleted record takes its grants', async () => {
    const [grant] = (await ana.call('GET', `/api/grants?resourceType=project&resourceId=${a.id}`))
      .body;
    expect((await ana.call('DELETE', `/api/grants/${grant.id}`)).status).toBe(200);
    expect((await inAna(crew)('GET', `/api/projects/${a.id}`)).status).toBe(404);
    expect(await audits('grants.remove')).toHaveLength(1);

    const c = await newProject({ title: 'Project C' });
    await ana.call('POST', '/api/grants', {
      resourceType: 'project',
      resourceId: c.id,
      userId: crew.id,
    });
    expect((await ana.call('DELETE', `/api/projects/${c.id}`)).status).toBe(200);
    const { rows } = await pool.query(
      `select count(*)::int as n from app.record_grants where resource_type = 'project' and resource_id = $1`,
      [c.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('field policy', () => {
  let project: { id: string };

  beforeAll(async () => {
    project = await newProject({ title: 'Costed project', cost: 1200 });
    await ana.call('POST', '/api/grants', {
      resourceType: 'project',
      resourceId: project.id,
      userId: crew.id,
    });
  });

  it('a field is hidden from whoever lacks its capability, in lists, gets and tool calls', async () => {
    expect((await ana.call('GET', `/api/projects/${project.id}`)).body.cost).toBe(1200);
    const listed = (await inAna(crew)('GET', '/api/projects')).body.items;
    expect(listed.find((j: { id: string }) => j.id === project.id)).not.toHaveProperty('cost');
    expect((await inAna(crew)('GET', `/api/projects/${project.id}`)).body).not.toHaveProperty(
      'cost',
    );
    // The assistant's tools call the same API, so they see what the person sees.
    const agent = asAssistant(`user:${crew.id}`, { 'x-tenant-id': tenantId });
    const viaTool = await agent('GET', `/api/projects/${project.id}`);
    expect(viaTool.status).toBe(200);
    expect(viaTool.body).not.toHaveProperty('cost');
  });

  it('refuses a filter or a sort on it', async () => {
    const filtered = await inAna(crew)('GET', '/api/projects?cost[gt]=100');
    expect(filtered.status).toBe(403);
    expect(filtered.body.rule).toBe('field_hidden');
    expect((await inAna(crew)('GET', '/api/projects?sort=-cost')).body.rule).toBe('field_hidden');
    expect((await ana.call('GET', '/api/projects?cost[gt]=100')).status).toBe(200);
  });

  it('refuses a summary that names it, even to someone who reaches no record', async () => {
    for (const q of ['sum=cost', 'avg=cost&groupBy=title', 'cost[gt]=100', 'max=cost']) {
      const res = await inAna(crew)('GET', `/api/projects/summary?${q}`);
      expect(res.status, q).toBe(403);
      expect(res.body.rule, q).toBe('field_hidden');
    }
    // Staff reach only their own projects, and have none: still refused, not zeros.
    const none = await inAna(staffer)('GET', '/api/projects/summary?sum=cost');
    expect(none.status).toBe(403);
    expect(none.body.rule).toBe('field_hidden');
    // A summary that does not name it counts what the crew member reaches.
    const counted = await inAna(crew)('GET', '/api/projects/summary');
    expect(counted.status).toBe(200);
    expect(counted.body.totals[0].count).toBeGreaterThanOrEqual(1);
    // Its holder sums it.
    const held = await ana.call('GET', '/api/projects/summary?sum=cost&title=Costed%20project');
    expect(held.status).toBe(200);
    expect(held.body.totals[0].sum).toEqual({ cost: 1200 });
  });

  it('refuses a write to it, on CRUD and inside a command, and audits the refusal', async () => {
    const crud = await inAna(crew)('PATCH', `/api/projects/${project.id}`, { cost: 1 });
    expect(crud.status).toBe(403);
    expect(crud.body.rule).toBe('field_hidden');
    expect((await inAna(crew)('POST', '/api/projects', { title: 'Mine', cost: 3 })).status).toBe(
      403,
    );
    const cmd = await inAna(crew)('POST', `/api/projects/${project.id}/reprice`, { cost: 2 });
    expect(cmd.status).toBe(403);
    expect(cmd.body.rule).toBe('field_hidden');
    expect((await audits('project.update', 'denied')).some((r) => r.rule === 'field_hidden')).toBe(
      true,
    );
    expect((await ana.call('GET', `/api/projects/${project.id}`)).body.cost).toBe(1200);
  });

  it("hides a command's own output field from whoever may write but not read it", async () => {
    const set = await inAna(estimator)('POST', `/api/projects/${project.id}/reprice`, {
      cost: 900,
    });
    expect(set.status).toBe(200);
    expect(set.body.value).toEqual({ projectId: project.id, title: 'Costed project' });
    expect(
      (await ana.call('POST', `/api/projects/${project.id}/reprice`, { cost: 950 })).body.value,
    ).toEqual({
      projectId: project.id,
      title: 'Costed project',
      cost: 950,
    });
  });

  it('a parked write is audited, and its approval hides the field from a decider without it', async () => {
    const agent = asAssistant(`user:${ana.id}`, { 'x-tenant-id': tenantId });
    const parked = await agent('PATCH', `/api/projects/${project.id}`, { cost: 1234 });
    expect(parked.body.status).toBe('needs_approval');
    const id = parked.body.approval.id;
    expect((await audits('project.update', 'needs_approval')).length).toBeGreaterThanOrEqual(1);

    const forCrew = (await inAna(crew)('GET', '/api/approvals')).body.find(
      (x: { id: string }) => x.id === id,
    );
    expect(forCrew.input).toEqual({});
    expect((await inAna(crew)('GET', `/api/approvals/${id}`)).body.input).toEqual({});
    const forAna = (await ana.call('GET', `/api/approvals/${id}`)).body;
    expect(forAna.input).toEqual({ cost: 1234 });
    // Another business sees nothing of it.
    expect((await stranger.call('GET', `/api/approvals/${id}`)).status).toBe(404);
  });

  it('a stored event leaves without the field for a reader who lacks it', async () => {
    const options = server.app?.get(CORE_OPTIONS, { strict: false }) as CoreOptions;
    const db = options.db;
    const [row] = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.resourceId, project.id), eq(domainEvents.name, 'project.created')))
      .orderBy(desc(domainEvents.seq))
      .limit(1);
    const event = toEnvelope(row);
    expect(eventFor(event, await principalOf(ana))?.row).toMatchObject({ cost: 1200 });
    const seen = eventFor(event, await principalOf(crew));
    expect(seen?.row).toMatchObject({ id: project.id, title: 'Costed project' });
    expect(seen?.row).not.toHaveProperty('cost');
    expect(eventFor(event, await principalOf(stranger, strangerTenant))).toBeNull();
  });

  it('checks every policy at start: optional, not searched or default-sorted, real capabilities', () => {
    const spec = entitySpec({
      name: 'gadget',
      schemas: {
        read: z.object({ id: z.string(), price: z.number(), name: z.string().optional() }),
        create: z.object({}),
        update: z.object({}),
      },
      list: {
        filterable: {},
        sortable: ['price'],
        defaultSort: [['price', 'asc']],
        search: ['name'],
        pageSize: { default: 10, max: 10 },
      },
      traits: {
        fieldPolicy: {
          price: 'fixture.cost.read',
          name: 'nobody.has_this',
          size: 'fixture.cost.read',
        },
      },
    });
    const problems = fieldPolicyProblems(spec, (c) => c.startsWith('fixture.'));
    expect(problems).toEqual([
      'gadget: field policy on "price": make it optional in the read schema (it is removed when hidden)',
      'gadget: field policy on "price": it cannot be in defaultSort',
      'gadget: field policy on "name": it cannot be searched (q)',
      'gadget: field policy on "name": "nobody.has_this" is not a capability',
      'gadget: field policy on "size": the read schema has no such field',
    ]);
  });
});

describe("a notification's words, as each recipient may read the record (H1)", () => {
  it('a field reaches only recipients holding its capability, in the inbox and by email', async () => {
    const title = `Told ${stamp}`;
    const project = await newProject({ title, cost: 4321 });
    const dedupe = `fixture.project-told:${project.id}`;
    // Ana holds fixture.cost.read; the estimator hears of projects but may not read their cost.
    expect((await eventually(() => inboxItem(ana, dedupe))).body).toBe('cost 4321');
    expect((await eventually(() => inboxItem(estimator, dedupe))).body).toBe('cost not shown');
    const toAna = await eventually(() => mailText(ana, `New project ${title}`));
    expect(toAna).toContain('cost 4321');
    const toEstimator = await eventually(() => mailText(estimator, `New project ${title}`));
    expect(toEstimator).toContain('cost not shown');
    expect(toEstimator).not.toContain('4321');
    // The record's own columns that no read shows stay out of the words, for everyone.
    expect(toAna).toContain('owner not shown');
    expect(toAna).not.toContain(ana.id);
    // Nobody else hears of it: not crew (no capability), not another business's owner.
    expect(await inboxItem(crew, dedupe)).toBeUndefined();
    expect(await inboxItem(stranger, dedupe)).toBeUndefined();
    expect(await mailText(stranger, `New project ${title}`)).toBeUndefined();
  });
});

describe('requests by someone outside the team, with the contact role renamed (H1)', () => {
  it("a signed-in client's assistant's request goes to the business, never to the client", async () => {
    const mine = await newProject({ title: 'Client project' }, client);
    const agent = asAssistant(`user:${client.id}`, { 'x-tenant-id': tenantId });
    const parked = await agent('DELETE', `/api/projects/${mine.id}`);
    expect(parked.body).toMatchObject({
      status: 'needs_approval',
      approval: {
        canDecide: false,
        decider: { by: 'capability', capability: 'approvals.decide' },
      },
    });
    const id = parked.body.approval.id;
    expect(
      (await audits('project.delete', 'needs_approval')).some((r) => r.after?.approvalId === id),
    ).toBe(true);
    // The client may follow it, never decide it.
    expect((await inAna(client)('GET', `/api/approvals/${id}`)).body).toMatchObject({
      canDecide: false,
    });
    expect(await inAna(client)('POST', `/api/approvals/${id}/approve`)).toMatchObject({
      status: 403,
      body: { rule: 'own_request' },
    });
    expect((await stranger.call('GET', `/api/approvals/${id}`)).status).toBe(404);
    // The business decides it.
    expect((await ana.call('POST', `/api/approvals/${id}/approve`)).body).toMatchObject({
      status: 'approved',
    });
    expect((await inAna(client)('GET', `/api/projects/${mine.id}`)).status).toBe(404);
  });

  it('a named approver who is only a client gives way to the business; a team member decides alone', async () => {
    const project = await newProject({ title: 'Reviewed project' });
    const toClient = await ana.call('POST', `/api/projects/${project.id}/review`, {
      reviewerId: client.id,
    });
    expect(toClient.body).toMatchObject({
      status: 'needs_approval',
      approval: { decider: { by: 'capability', capability: 'approvals.decide' } },
    });
    const toEstimator = await ana.call('POST', `/api/projects/${project.id}/review`, {
      reviewerId: estimator.id,
    });
    expect(toEstimator.body.approval.decider).toEqual({ by: 'person', userId: estimator.id });
    expect(
      (await inAna(estimator)('GET', `/api/approvals/${toEstimator.body.approval.id}`)).body,
    ).toMatchObject({ canDecide: true });
  });
});
