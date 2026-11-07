// A4: how an application overrides declared roles and names the roles the framework hands out,
// how a business's own roles and edits resolve, access by capability and by record grant, and
// the field policy helpers.
import {
  capabilities,
  capabilitiesOf,
  capabilityProblem,
  checkRoles,
  defineCapability,
  defineRole,
  fieldCapability,
  givenRoles,
  hiddenFields,
  type Principal,
  parseTenantSettings,
  roleDefaults,
  roleOverrides,
  roles,
  rolesOfBusiness,
  standingIn,
  withoutFields,
} from '@hykr/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Access, accessFor, rowAllowed } from './access.js';

const label = (en: string) => ({ en, hi: en, te: en });
const person = (extra: Partial<Principal> = {}): Principal => ({
  actor: { kind: 'user', id: 'alice' },
  scopes: [],
  subject: { kind: 'user', userId: 'alice' },
  tenantId: 't1',
  roles: [],
  assurance: 'session',
  ...extra,
});

beforeAll(() => {
  capabilities.register(
    defineCapability({ name: 'unit.cost.read', label: label('See cost'), roles: ['owner'] }),
    defineCapability({ name: 'unit.all.read', label: label('Every record') }),
    // Only code gives it (the owner, here): a business may not.
    defineCapability({
      name: 'unit.code.only',
      label: label('Code only'),
      roles: ['owner'],
      grantable: false,
    }),
  );
  roles.register(
    defineRole({ name: 'unit_buyer', label: label('Buyer'), capabilities: ['unit.cost.read'] }),
  );
});

describe('the application overrides declared roles', () => {
  it('relabels a framework role and replaces its capabilities', () => {
    expect(capabilitiesOf(['staff'])).toContain('customers.message');
    roleOverrides.register({
      role: 'staff',
      label: label('Team member'),
      capabilities: ['backoffice.use', 'unit.cost.read'],
    });
    expect(capabilitiesOf(['staff'])).toEqual(['backoffice.use', 'unit.cost.read']);
    const staff = rolesOfBusiness().find((r) => r.name === 'staff');
    expect(staff).toMatchObject({
      label: label('Team member'),
      source: 'framework',
      edited: false,
    });
    expect(() => checkRoles()).not.toThrow();
  });

  it('names the roles a creator and a contact get; the framework gives owner and customer', () => {
    expect(givenRoles('creator')).toEqual(['owner']);
    expect(givenRoles('contact')).toEqual(['customer']);
    roleDefaults.register({ name: 'creator', roles: ['owner', 'unit_buyer'] });
    expect(givenRoles('creator')).toEqual(['owner', 'unit_buyer']);
    expect(givenRoles('contact')).toEqual(['customer']);
  });

  it('stops the start on an override or default naming what nobody declares', () => {
    roleOverrides.register({ role: 'unit_ghost', label: label('Ghost') });
    expect(() => checkRoles()).toThrow('The override of role "unit_ghost" names a role nobody');
  });
});

describe("a business's own roles and edits", () => {
  const settings = parseTenantSettings({
    roles: {
      defined: [
        {
          name: 'site_lead',
          label: { en: 'Site lead' },
          capabilities: ['unit.all.read', 'unit.code.only'],
        },
        // Shadowed: the application declares this name, so code wins.
        { name: 'unit_buyer', label: { en: 'Mine' }, capabilities: [] },
      ],
      edits: {
        owner: { capabilities: ['backoffice.use', 'unit.code.only'] },
        unit_buyer: {
          label: { en: 'Purchaser' },
          capabilities: ['unit.cost.read', 'unit.code.only'],
        },
      },
    },
  });

  it('resolves names to roles and capabilities, edits first', () => {
    expect(standingIn(['site_lead', 'wizard'], settings)).toEqual({
      roles: ['site_lead'],
      // unit.code.only is not grantable: a business cannot add it.
      capabilities: ['unit.all.read'],
      unknown: ['wizard'],
    });
    // The owner keeps unit.code.only (code gave it), and loses the rest by the edit.
    expect(standingIn(['owner'], settings).capabilities).toEqual([
      'backoffice.use',
      'unit.code.only',
    ]);
    expect(standingIn(['unit_buyer'], settings).capabilities).toEqual(['unit.cost.read']);
    const views = rolesOfBusiness(settings);
    expect(views.find((r) => r.name === 'unit_buyer')).toMatchObject({
      label: { en: 'Purchaser', hi: 'Purchaser', te: 'Purchaser' },
      source: 'application',
      edited: true,
    });
    expect(views.filter((r) => r.name === 'unit_buyer')).toHaveLength(1);
    expect(views.find((r) => r.name === 'site_lead')).toMatchObject({ source: 'business' });
  });

  it('says why a business may not give a capability', () => {
    expect(capabilityProblem(['unit.all.read'])).toBeNull();
    expect(capabilityProblem(['unit.code.only'])).toContain('cannot be given by a business');
    expect(capabilityProblem(['unit.code.only'], ['unit.code.only'])).toBeNull();
    expect(capabilityProblem(['nope.nothing'])).toContain('is not a capability');
  });

  it('a business with no settings has the declared roles only', () => {
    expect(standingIn(['site_lead'], undefined).unknown).toEqual(['site_lead']);
  });
});

describe('access by capability and by record grant', () => {
  const access: Access = {
    read: {
      owner: 'tenant',
      unit_buyer: ['own', { grant: 'granted' }],
      'unit.all.read': 'tenant',
    },
    write: { owner: 'tenant', unit_buyer: { grant: 'granted', of: 'parent', via: 'parentId' } },
  };

  it('a capability key reaches rows for whoever holds it, whatever their role', () => {
    const lead = person({ roles: ['site_lead'], capabilities: ['unit.all.read'] });
    expect(accessFor(lead, access, 'read')).toMatchObject({ kind: 'grants', grants: ['tenant'] });
    expect(accessFor(person({ roles: ['site_lead'] }), access, 'read')).toEqual({ kind: 'none' });
  });

  it('a list of rules gives each of them, with its options', () => {
    const buyer = person({ roles: ['unit_buyer'] });
    expect(accessFor(buyer, access, 'read')).toEqual({
      kind: 'grants',
      grants: ['own', 'granted'],
      rules: [{ grant: 'own' }, { grant: 'granted' }],
    });
    expect(accessFor(buyer, access, 'write')).toMatchObject({
      rules: [{ grant: 'granted', of: 'parent', via: 'parentId' }],
    });
  });

  it('only a person holds record grants', () => {
    const contact = person({
      roles: ['unit_buyer'],
      subject: { kind: 'contact', contactId: 'c1' },
    });
    expect(accessFor(contact, access, 'read')).toEqual({ kind: 'none' });
  });

  it('a grant the framework does not answer itself is left to the query', () => {
    const buyer = person({ roles: ['unit_buyer'] });
    expect(rowAllowed(buyer, ['granted'], { ownerId: 'someone' })).toBe(true);
    expect(rowAllowed(buyer, ['own'], { ownerId: 'someone' })).toBe(false);
  });

  it('a capability key nobody defines is a mistake', () => {
    const typo: Access = { read: { 'unit.al.read': 'tenant' }, write: {} };
    expect(() => accessFor(person(), typo, 'read')).toThrow(
      'Access names capability "unit.al.read"',
    );
  });
});

describe('field policy helpers', () => {
  const policy = {
    cost: 'unit.cost.read',
    margin: { read: 'unit.cost.read', write: 'unit.all.read' },
  };

  it('hides what the capabilities do not cover, for reading and writing', () => {
    expect(hiddenFields(policy, { capabilities: [] })).toEqual(['cost', 'margin']);
    expect(hiddenFields(policy, { capabilities: ['unit.cost.read'] })).toEqual([]);
    expect(hiddenFields(policy, { capabilities: ['unit.cost.read'] }, 'write')).toEqual(['margin']);
    expect(hiddenFields(undefined, {})).toEqual([]);
    expect(fieldCapability(policy.margin, 'write')).toBe('unit.all.read');
    expect(fieldCapability(policy.cost, 'write')).toBe('unit.cost.read');
  });

  it('removes fields, never blanks them, and leaves the input alone', () => {
    const row = { id: '1', cost: 5, title: 'x' };
    expect(withoutFields(row, ['cost'])).toEqual({ id: '1', title: 'x' });
    expect(row.cost).toBe(5);
  });
});
