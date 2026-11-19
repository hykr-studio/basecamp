// Joining a business with an invitation: a party's (the person becomes a participant of that
// business, never a member) or its team's (a member). No React here, so it is tested on its own.
import { type ApiClient, ApiError } from '@hykr/api-client';
import type { WriteResult } from '@hykr/contracts';

/** The app's path for an invitation link: `/businesses/join?token=…`. */
export const JOIN_PATH = '/businesses/join';

/**
 * The token in what the person typed or pasted: a bare code, or a link that carries
 * `token=…` (the app's own join link, or any link with it in its query or fragment).
 */
export function invitationToken(input: string): string {
  const text = input.trim();
  const found = /[?&#]token=([^&#\s]+)/.exec(text);
  if (!found) return text;
  try {
    return decodeURIComponent(found[1]);
  } catch {
    return found[1];
  }
}

/** The business joined, and how the person is there now. */
export type Joined = { tenantId: string; as: 'participant' | 'member' };

function done<V>(r: WriteResult<V>): V {
  // Neither invitation parks; anything else is not a join (fail closed).
  if (r.status !== 'done') throw new Error('The invitation was not accepted');
  return r.value;
}

/**
 * Accept an invitation. A party's is tried first. A token no party invitation has (404) is then
 * tried as an invitation to the team. Any other refusal is the answer and the token goes no
 * further: one for another email address, a sign-in that is not a session, a malformed code.
 */
export async function acceptInvitation(
  client: Pick<ApiClient, 'parties' | 'members'>,
  token: string,
): Promise<Joined> {
  try {
    return { tenantId: done(await client.parties.join(token)).tenantId, as: 'participant' };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  return { tenantId: done(await client.members.acceptInvite(token)).tenantId, as: 'member' };
}

/**
 * Whether the Businesses destination shows: for several businesses (to switch) and for none
 * (to join one), not for exactly one, and not while the count is unknown.
 */
export const showsBusinesses = (count: number | undefined): boolean =>
  count !== undefined && count !== 1;
