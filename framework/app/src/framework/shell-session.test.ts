// Who the shell shows (decisions B12, decision 17), without React Native. Opened without a
// network, the shell shows the last person signed in here and the offline plugin restores what
// they read. When the network is back and the server no longer knows them, or knows someone else,
// those answers leave the query client before anyone else is shown, so the next person to sign in
// on the phone neither sees them nor has them saved under their own name.
import { ApiError, NetworkError } from '@hykr/api-client';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { SessionUser } from '../session';
import { createShellSession } from './shell-session';

const asha: SessionUser = { id: 'u1', name: 'Asha', email: 'asha@example.com' };
const ravi: SessionUser = { id: 'u2', name: 'Ravi', email: 'ravi@example.com' };

const cached = (client: QueryClient) => client.getQueryCache().getAll().length;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A shell over a real query client: the server answers from a script, the network is a switch. */
function setup(answers: (SessionUser | null | Error)[], last: SessionUser | null = asha) {
  const client = new QueryClient();
  const rendered: (SessionUser | null)[] = [];
  /** How many queries the client held as each person (or nobody) was drawn. */
  const sizes: number[] = [];
  const kept = { last };
  const listeners = new Set<(online: boolean) => void>();
  const session = createShellSession({
    me: async () => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('No answer scripted');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    render: (user) => {
      rendered.push(user);
      sizes.push(cached(client));
    },
    clear: () => client.clear(),
    last: () => kept.last,
    remember: (user) => {
      kept.last = user;
    },
    forget: () => {
      kept.last = null;
    },
    onNetwork: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const online = async () => {
    for (const l of listeners) l(true);
    await tick();
  };
  /** What the offline plugin restores for the person shown: their to-dos and approvals. */
  const restore = () => {
    client.setQueryData(['me'], { id: 'u1', businesses: ['b1'] });
    client.setQueryData(['todos', 'list', {}], { pages: [{ items: [{ id: 't1' }] }] });
    client.setQueryData(['approvals'], [{ id: 'a1' }]);
  };
  return { client, rendered, sizes, kept, session, online, restore, listeners };
}

describe('the shell session', () => {
  it('opened on the last session, a refused re-check leaves no cached queries', async () => {
    const t = setup([new NetworkError(new TypeError('Network request failed')), null]);
    t.session.start();
    await tick();
    expect(t.session.shown()).toEqual(asha);
    t.restore();
    expect(cached(t.client)).toBe(3);

    await t.online();
    expect(cached(t.client)).toBe(0);
    expect(t.session.shown()).toBeNull();
    expect(t.rendered).toEqual([asha, null]);
    expect(t.sizes).toEqual([0, 0]);
    expect(t.kept.last).toBeNull();
  });

  it('a re-check refused with an error, not an answer, leaves none either', async () => {
    const t = setup([new TypeError('Failed to fetch'), new ApiError(500, { error: 'internal' })]);
    t.session.start();
    await tick();
    t.restore();
    await t.online();
    expect(cached(t.client)).toBe(0);
    expect(t.session.shown()).toBeNull();
    expect(t.kept.last).toBeNull();
  });

  it('a re-check that finds someone else drops the last person’s answers before showing them', async () => {
    const t = setup([new NetworkError(undefined), ravi]);
    t.session.start();
    await tick();
    t.restore();
    await t.online();
    expect(t.session.shown()).toEqual(ravi);
    expect(t.sizes).toEqual([0, 0]);
    expect(cached(t.client)).toBe(0);
    expect(t.kept.last).toEqual(ravi);
  });

  it('a re-check that confirms the person keeps what they read', async () => {
    const t = setup([new NetworkError(undefined), asha]);
    t.session.start();
    await tick();
    t.restore();
    await t.online();
    expect(cached(t.client)).toBe(3);
    expect(t.rendered).toEqual([asha, asha]);
  });

  it('checks again only after a check that could not reach the server', async () => {
    const t = setup([asha]);
    t.session.start();
    await tick();
    t.restore();
    await t.online();
    expect(t.rendered).toEqual([asha]);
    expect(cached(t.client)).toBe(3);
  });

  it('with nobody signed in here, a start without a network shows the sign-in screen', async () => {
    const t = setup([new NetworkError(undefined)], null);
    t.session.start();
    await tick();
    expect(t.session.shown()).toBeNull();
  });

  it('nobody shown yet: the first answer clears nothing (a public page’s answers stay)', async () => {
    const t = setup([asha]);
    t.client.setQueryData(['share', 'tok'], { title: 'Shared' });
    t.session.start();
    await tick();
    expect(cached(t.client)).toBe(1);
  });

  it('signing out forgets the person and the cache; the next person starts empty', async () => {
    const t = setup([asha]);
    t.session.start();
    await tick();
    t.restore();
    t.session.signedOut();
    expect(cached(t.client)).toBe(0);
    expect(t.kept.last).toBeNull();
    t.session.signedIn(ravi);
    expect(t.session.shown()).toEqual(ravi);
    expect(t.kept.last).toEqual(ravi);
    expect(t.rendered).toEqual([asha, null, ravi]);
  });

  it('once stopped, a late answer changes nothing', async () => {
    const t = setup([new NetworkError(undefined), null]);
    const stop = t.session.start();
    await tick();
    t.restore();
    stop();
    expect(t.listeners.size).toBe(0);
    await t.online();
    expect(cached(t.client)).toBe(3);
    expect(t.session.shown()).toEqual(asha);
  });
});
