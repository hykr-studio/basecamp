import type { Principal } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { type Access, accessFor, rowAllowed } from './access.js';
import { subjectOf, userIdOf } from './subject.js';

const person = (extra: Partial<Principal> = {}): Principal => ({
  actor: { kind: 'user', id: 'alice', role: 'owner' },
  scopes: [],
  subject: { kind: 'user', userId: 'alice' },
  tenantId: 't1',
  roles: ['owner'],
  assurance: 'session',
  ...extra,
});
const contact: Principal = {
  actor: { kind: 'agent', id: 'assistant', role: 'agent' },
  actingFor: { contactId: 'c1' },
  scopes: [],
  subject: { kind: 'contact', contactId: 'c1' },
  tenantId: 't1',
  roles: ['customer'],
  customerId: 'cust1',
  assurance: 'whatsapp_number',
};

describe('subjectOf', () => {
  it('a person acts for themselves; the agent for whom it names', () => {
    expect(subjectOf(person())).toEqual({ kind: 'user', userId: 'alice' });
    expect(subjectOf(contact)).toEqual({ kind: 'contact', contactId: 'c1' });
    expect(userIdOf(contact)).toBeNull();
  });

  it('older principals (before tenants) still name their person', () => {
    const agent = { actor: { kind: 'agent', id: 'assistant', role: 'agent' }, scopes: [] } as const;
    expect(subjectOf({ ...agent, actingFor: { userId: 'bob' } } as Principal)).toEqual({
      kind: 'user',
      userId: 'bob',
    });
    expect(subjectOf(agent as unknown as Principal)).toBeNull();
  });
});

describe('accessFor', () => {
  const meetings: Access = {
    read: { owner: 'own', ops: 'tenant', customer: 'customer' },
    write: {
      owner: 'own',
      ops: 'tenant',
      customer: { grant: 'customer', minAssurance: 'session' },
    },
  };

  it('each role reaches its own rows', () => {
    expect(accessFor(person(), meetings, 'read')).toEqual({ kind: 'grants', grants: ['own'] });
    expect(accessFor(person({ roles: ['owner', 'ops'] }), meetings, 'read')).toEqual({
      kind: 'grants',
      grants: ['own', 'tenant'],
    });
    expect(accessFor(contact, meetings, 'read')).toEqual({ kind: 'grants', grants: ['customer'] });
  });

  it('a WhatsApp number alone cannot do what needs a signed-in account', () => {
    expect(accessFor(contact, meetings, 'write')).toEqual({
      kind: 'needs_assurance',
      need: 'session',
    });
  });

  it('a role with no rule, or a grant it cannot use, gives nothing', () => {
    expect(accessFor(person({ roles: ['staff'] }), meetings, 'read')).toEqual({ kind: 'none' });
    expect(accessFor({ ...contact, customerId: undefined }, meetings, 'read')).toEqual({
      kind: 'none',
    });
  });

  it('a row is inside a grant only if it is really theirs', () => {
    expect(rowAllowed(person(), ['own'], { ownerId: 'alice' })).toBe(true);
    expect(rowAllowed(person(), ['own'], { ownerId: 'bob' })).toBe(false);
    expect(rowAllowed(contact, ['customer'], { customerId: 'cust1' })).toBe(true);
    expect(rowAllowed(contact, ['customer'], { customerId: 'cust2' })).toBe(false);
  });
});
