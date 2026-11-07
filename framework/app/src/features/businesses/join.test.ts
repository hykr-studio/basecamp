// Joining a business by invitation from the app: the code or link the person pastes, which kind
// of invitation it is (a party's first, then the team's), and when the Businesses destination
// shows.
import { ApiError } from '@hykr/api-client';
import { describe, expect, it, vi } from 'vitest';
import { acceptInvitation, invitationToken, showsBusinesses } from './join';

const done = <V>(value: V) => ({ status: 'done' as const, value });
const notFound = () => new ApiError(404, { error: 'not_found' });

type Client = Parameters<typeof acceptInvitation>[0];
function client(party: () => Promise<unknown>, team: () => Promise<unknown>) {
  const join = vi.fn(party);
  const acceptInvite = vi.fn(team);
  const api = { parties: { join }, members: { acceptInvite } } as unknown as Client;
  return { join, acceptInvite, api };
}

describe('invitationToken', () => {
  it('takes a bare code as it is, trimmed', () => {
    expect(invitationToken('  abc123DEF-_xyz  ')).toBe('abc123DEF-_xyz');
    expect(invitationToken('   ')).toBe('');
  });

  it('takes the token out of a link, decoded', () => {
    expect(invitationToken('https://app.example.com/businesses/join?token=t0k3n')).toBe('t0k3n');
    expect(invitationToken('myapp://businesses/join?x=1&token=a%2Bb&y=2')).toBe('a+b');
    expect(invitationToken('https://app.example.com/#token=frag')).toBe('frag');
  });

  it('keeps a token that does not decode as it was', () => {
    expect(invitationToken('/businesses/join?token=%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('acceptInvitation', () => {
  it("is a party's invitation first: the person is a participant there", async () => {
    const c = client(
      async () => done({ member: {}, tenantId: 't-party' }),
      async () => done({ tenantId: 't-team', roles: [] }),
    );
    await expect(acceptInvitation(c.api, 'tok')).resolves.toEqual({
      tenantId: 't-party',
      as: 'participant',
    });
    expect(c.join).toHaveBeenCalledWith('tok');
    expect(c.acceptInvite).not.toHaveBeenCalled();
  });

  it("is tried as the team's when no party invitation has the token (404)", async () => {
    const c = client(
      async () => {
        throw notFound();
      },
      async () => done({ tenantId: 't-team', roles: ['staff'] }),
    );
    await expect(acceptInvitation(c.api, 'tok')).resolves.toEqual({
      tenantId: 't-team',
      as: 'member',
    });
    expect(c.acceptInvite).toHaveBeenCalledWith('tok');
  });

  it('answers 404 when neither has it', async () => {
    const c = client(
      async () => {
        throw notFound();
      },
      async () => {
        throw notFound();
      },
    );
    await expect(acceptInvitation(c.api, 'tok')).rejects.toMatchObject({ status: 404 });
  });

  it("does not offer the token to the team when the party's refuses it otherwise", async () => {
    for (const status of [400, 403]) {
      const c = client(
        async () => {
          throw new ApiError(status, { error: 'forbidden', rule: 'invite_email' });
        },
        async () => done({ tenantId: 't-team', roles: [] }),
      );
      await expect(acceptInvitation(c.api, 'tok')).rejects.toMatchObject({ status });
      expect(c.acceptInvite).not.toHaveBeenCalled();
    }
  });

  it('is not a join unless the write is done', async () => {
    const c = client(
      async () => ({ status: 'needs_approval', approval: {} }),
      async () => done({ tenantId: 't-team', roles: [] }),
    );
    await expect(acceptInvitation(c.api, 'tok')).rejects.toThrow('not accepted');
  });
});

describe('showsBusinesses', () => {
  it('shows for none (to join one) and for several (to switch), not for one', () => {
    expect(showsBusinesses(0)).toBe(true);
    expect(showsBusinesses(2)).toBe(true);
    expect(showsBusinesses(1)).toBe(false);
  });

  it('waits while the count is unknown', () => {
    expect(showsBusinesses(undefined)).toBe(false);
  });
});
