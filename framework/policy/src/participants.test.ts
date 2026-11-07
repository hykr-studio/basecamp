// B7: the participant grant as access sees it, participant roles and their checks, and the roles a
// participant is given.
import {
  checkParticipantRoles,
  defineParticipantRole,
  givenRoles,
  type Principal,
  participantRoles,
  participationProblem,
  roleDefaults,
} from '@hykr/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Access, accessFor, rowAllowed } from './access.js';

const label = (en: string) => ({ en, hi: en, te: en });
const base = (extra: Partial<Principal> = {}): Principal => ({
  actor: { kind: 'user', id: 'sita' },
  scopes: [],
  subject: { kind: 'user', userId: 'sita' },
  tenantId: 't1',
  roles: ['customer'],
  assurance: 'session',
  ...extra,
});

const ACCESS: Access = {
  read: { owner: 'tenant', customer: ['customer', { grant: 'participant' }] },
  write: { owner: 'tenant', customer: { grant: 'participant', as: ['unit_client'] } },
};

beforeAll(() => {
  participantRoles.register(
    defineParticipantRole({ name: 'unit_client', label: label('Client'), kinds: ['person'] }),
    defineParticipantRole({ name: 'unit_partner', label: label('Partner'), on: ['unit_case'] }),
  );
});

describe('the participant grant', () => {
  it('passes its options (as, of, via) through to the query', () => {
    const write = accessFor(base(), ACCESS, 'write');
    expect(write).toEqual({
      kind: 'grants',
      grants: ['participant'],
      rules: [{ grant: 'participant', as: ['unit_client'] }],
    });
  });

  it('a person and a contact participate; nobody else does', () => {
    const contact = base({
      actor: { kind: 'agent', id: 'assistant' },
      subject: { kind: 'contact', contactId: 'c1' },
    });
    expect(accessFor(contact, ACCESS, 'read')).toMatchObject({ grants: ['participant'] });
    const nobody = base({ actor: { kind: 'agent', id: 'assistant' }, subject: undefined });
    expect(accessFor(nobody, ACCESS, 'read').kind).toBe('none');
  });

  it('a loaded row is left to the query (the scoped where decides)', () => {
    expect(rowAllowed(base(), ['participant'], { ownerId: 'someone' })).toBe(true);
  });
});

describe('participant roles', () => {
  it('are checked when declared: a name, known kinds, a non-empty list', () => {
    expect(() => defineParticipantRole({ name: 'Bad Name', label: label('x') })).toThrow();
    expect(() =>
      defineParticipantRole({ name: 'x', label: label('x'), kinds: ['robot' as 'person'] }),
    ).toThrow(/not a kind of party/);
    expect(() => defineParticipantRole({ name: 'x', label: label('x'), kinds: [] })).toThrow();
    expect(() => defineParticipantRole({ name: 'x', label: label('x'), on: [] })).toThrow();
    expect(() =>
      participantRoles.register(defineParticipantRole({ name: 'unit_client', label: label('x') })),
    ).toThrow(/registered twice/);
  });

  it('say which parties and records fit', () => {
    expect(participationProblem('unit_client', { kind: 'person' }, 'anything')).toBeNull();
    expect(participationProblem('unit_client', { kind: 'organisation' }, 'x')).toMatch(/cannot be/);
    expect(participationProblem('unit_partner', { kind: 'organisation' }, 'unit_case')).toBeNull();
    expect(participationProblem('unit_partner', { kind: 'person' }, 'other')).toMatch(
      /not a role on/,
    );
    expect(participationProblem('unit_nobody', { kind: 'person' }, 'x')).toMatch(
      /not a participant role/,
    );
  });

  it('naming an entity nobody serves stops the start', () => {
    expect(() => checkParticipantRoles(new Set(['unit_case']))).not.toThrow();
    expect(() => checkParticipantRoles(new Set())).toThrow(/"unit_case", which is no entity/);
  });
});

describe('the roles a participant holds', () => {
  it("are the contact's unless the application names its own", () => {
    expect(givenRoles('participant')).toEqual(givenRoles('contact'));
    roleDefaults.register({ name: 'participant', roles: ['staff'] });
    expect(givenRoles('participant')).toEqual(['staff']);
  });
});
