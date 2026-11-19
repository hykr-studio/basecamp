// X1: who is outside a business's team is decided by the roles the framework hands outsiders (a
// contact's and a participant's, as the application names them), never by a role's name.
import {
  defineRole,
  outsiderRoles,
  roleDefaults,
  roles,
  standingIn,
  teamRoles,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';

const label = (en: string) => ({ en, hi: en, te: en });

describe('the roles that make someone part of the team', () => {
  it("are any but a contact's or a participant's: the framework's customer by default", () => {
    expect([...outsiderRoles()]).toEqual(['customer']);
    expect(teamRoles(['customer'])).toEqual([]);
    expect(teamRoles(['customer', 'staff', 'staff'])).toEqual(['staff']);
    expect(teamRoles([])).toEqual([]);
  });

  it('follow the application when it names its own outsider roles', () => {
    roles.register(
      defineRole({ name: 'unit_client', label: label('Client') }),
      defineRole({ name: 'unit_guest', label: label('Guest') }),
    );
    roleDefaults.register({ name: 'contact', roles: ['unit_client'] });
    expect([...outsiderRoles()]).toEqual(['unit_client']);
    // A renamed outsider is outside; the framework's customer is then an ordinary role.
    expect(teamRoles(['unit_client'])).toEqual([]);
    expect(teamRoles(['customer'])).toEqual(['customer']);
    roleDefaults.register({ name: 'participant', roles: ['unit_guest'] });
    expect([...outsiderRoles()].sort()).toEqual(['unit_client', 'unit_guest']);
    expect(teamRoles(['unit_guest', 'unit_client'])).toEqual([]);
    expect(teamRoles(['unit_guest', 'admin'])).toEqual(['admin']);
  });

  it('count only roles the business has: a name nobody declared makes nobody part of it', () => {
    const { roles: held } = standingIn(['unit_ghost']);
    expect(teamRoles(held)).toEqual([]);
    const made = standingIn(['desk'], {
      roles: { defined: [{ name: 'desk', label: label('Desk'), capabilities: [] }], edits: {} },
    });
    expect(teamRoles(made.roles)).toEqual(['desk']);
  });
});
