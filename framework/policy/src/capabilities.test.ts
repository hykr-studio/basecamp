import {
  ASSURANCE_ORDER,
  atLeast,
  capabilities,
  capabilitiesOf,
  checkRoles,
  defineCapability,
  defineRole,
  FrameworkCapabilities,
  featureEnabled,
  knownRoles,
  type Principal,
  roles,
  TenantRole,
} from '@hykr/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Access, accessFor, rowAllowed } from './access.js';
import { can } from './capabilities.js';

const label = { en: 'x', hi: 'x', te: 'x' };
const person = (extra: Partial<Principal> = {}): Principal => ({
  actor: { kind: 'user', id: 'alice' },
  scopes: [],
  subject: { kind: 'user', userId: 'alice' },
  tenantId: 't1',
  roles: ['owner'],
  assurance: 'session',
  ...extra,
});
const access: Access = {
  read: { owner: 'own', ops: 'tenant' },
  write: { owner: 'own', ops: 'tenant' },
};

describe('the framework roles and capabilities', () => {
  it('give what the hard-coded role checks gave, and settings to owners and admins (A11)', () => {
    // Deciding: owner and ops decided the business's requests, owner and admin marketing sends.
    // Plus the members feature's (A4): the team reads members, owner and admin manage them,
    // and owner, admin and ops give access to single records. Owners and admins import records
    // from files (B20).
    expect(capabilitiesOf(['owner'])).toEqual([
      'approvals.decide',
      'backoffice.use',
      'channels.manage',
      'customers.message',
      'imports.run',
      'marketing.approve',
      'members.manage',
      'members.read',
      'queues.admin',
      'records.grant',
      'settings.manage',
    ]);
    expect(capabilitiesOf(['admin'])).toEqual([
      'backoffice.use',
      'channels.manage',
      'customers.message',
      'history.all',
      'imports.run',
      'marketing.approve',
      'members.manage',
      'members.read',
      'queues.admin',
      'records.grant',
      'settings.manage',
    ]);
    expect(capabilitiesOf(['ops'])).toEqual([
      'approvals.decide',
      'backoffice.use',
      'customers.message',
      'history.all',
      'members.read',
      'records.grant',
    ]);
    expect(capabilitiesOf(['staff'])).toEqual([
      'backoffice.use',
      'customers.message',
      'members.read',
    ]);
    expect(capabilitiesOf(['customer'])).toEqual([]);
  });

  it('an unknown role grants nothing, and is not kept', () => {
    expect(capabilitiesOf(['wizard'])).toEqual([]);
    expect(knownRoles(['wizard', 'ops', 'ops', 'owner'])).toEqual(['ops', 'owner']);
    expect(TenantRole.safeParse('Team Lead').success).toBe(false);
    expect(TenantRole.safeParse('team_lead').success).toBe(true);
  });
});

describe('roles and capabilities added by an application', () => {
  // Registered once, after the framework's own are checked: registries are process-global.
  beforeAll(() => {
    capabilities.register(
      defineCapability({ name: 'unit.reports.read', label, roles: ['owner', 'unit_auditor'] }),
    );
    roles.register(defineRole({ name: 'unit_auditor', label, capabilities: ['history.all'] }));
  });

  it('a capability can name its roles, and a role its capabilities', () => {
    expect(capabilitiesOf(['unit_auditor'])).toEqual(['history.all', 'unit.reports.read']);
    expect(capabilitiesOf(['owner'])).toContain('unit.reports.read');
    expect(capabilitiesOf(['staff'])).not.toContain('unit.reports.read');
  });

  it('a role naming a capability nobody defines stops the start', () => {
    expect(() => checkRoles()).not.toThrow();
    roles.register(defineRole({ name: 'unit_typo', label, capabilities: ['history.alll'] }));
    expect(() => checkRoles()).toThrow('Role "unit_typo" names capability "history.alll"');
  });

  it('names are checked', () => {
    expect(() => defineCapability({ name: 'reports', label })).toThrow('<area>.<action>');
    expect(() => defineRole({ name: 'Team Lead', label })).toThrow('lower case');
    expect(() => defineRole({ name: 'lead', label, capabilities: ['nope'] })).toThrow(
      'is not a capability',
    );
    expect(() => roles.register(defineRole({ name: 'owner', label }))).toThrow(
      'The role "owner" is registered twice',
    );
  });
});

describe('can', () => {
  it("reads the principal's capabilities: none means no", () => {
    const ops = person({ roles: ['ops'], capabilities: capabilitiesOf(['ops']) });
    expect(can(ops, 'history.all')).toBe(true);
    expect(can(ops, FrameworkCapabilities.wholeHistory)).toBe(true);
    expect(can(ops, 'queues.admin')).toBe(false);
    // Roles alone, without what the server worked out, allow nothing.
    expect(can(person({ roles: ['ops'] }), 'history.all')).toBe(false);
  });

  it('takes a Me as well', () => {
    expect(can({ capabilities: ['backoffice.use'] }, 'backoffice.use')).toBe(true);
  });

  it('a capability nobody defined is a mistake, not a quiet no', () => {
    expect(() => can(person(), 'backoffice.usee')).toThrow('Unknown capability "backoffice.usee"');
  });
});

describe('access for the new actor kinds', () => {
  const system: Principal = {
    actor: { kind: 'system', id: 'unit.sweeper' },
    tenantId: 't1',
    roles: [],
    scopes: [],
    channel: 'background',
  };

  it('the system reaches every row of its one business', () => {
    expect(accessFor(system, access, 'write')).toEqual({
      kind: 'grants',
      grants: ['tenant'],
      rules: [{ grant: 'tenant' }],
    });
    expect(rowAllowed(system, ['tenant'], { ownerId: 'bob' })).toBe(true);
    expect(accessFor({ ...system, tenantId: undefined }, access, 'read')).toEqual({
      kind: 'none',
    });
  });

  it('a guest reaches nothing by role', () => {
    const guest: Principal = { actor: { kind: 'guest', id: 'share:1' }, scopes: [], roles: [] };
    expect(accessFor(guest, access, 'read')).toEqual({ kind: 'none' });
  });

  it("a role named like an object's own key is just an unknown role", () => {
    expect(accessFor(person({ roles: ['constructor'] }), access, 'read')).toEqual({ kind: 'none' });
  });
});

describe('assurance and features', () => {
  it('a one-time code sits between a WhatsApp number and a session', () => {
    expect(ASSURANCE_ORDER).toEqual(['whatsapp_number', 'otp', 'session']);
    expect(atLeast('otp', 'whatsapp_number')).toBe(true);
    expect(atLeast('otp', 'session')).toBe(false);
    expect(atLeast(undefined, 'otp')).toBe(false);
  });

  it('only true switches a feature on', () => {
    expect(featureEnabled({ features: { beta: true } }, 'beta')).toBe(true);
    expect(featureEnabled({ features: { beta: 'yes' } }, 'beta')).toBe(false);
    expect(featureEnabled({ features: {} }, 'beta')).toBe(false);
    expect(featureEnabled(undefined, 'beta')).toBe(false);
  });
});
