// A calendar sign-in under way (decisions B17, 36 and 37). The state Google carries is a random
// token; the server keeps, under its SHA-256, who started the sign-in, in which business, the
// PKCE verifier (sealed for the row) and where the browser returns. The row is taken once, and
// only the person who started it, signed in, in that business, gets to exchange the code.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { calendarOauthStates, type Database } from '@hykr/db';
import { eq, lt } from 'drizzle-orm';
import { requireSecretBox } from '../integrations/settings.js';

export type SignInRow = typeof calendarOauthStates.$inferSelect;

/** A sign-in is good for this long: the person has ten minutes to agree at the provider. */
export const SIGN_IN_TTL_MS = 10 * 60_000;

const STATE = /^cs[A-Za-z0-9_-]{43}$/;
const hashOf = (state: string) => createHash('sha256').update(state).digest('hex');
/** Where a sealed verifier belongs: it opens only for this row, person and business. */
const verifierAad = (row: Pick<SignInRow, 'id' | 'tenantId' | 'userId'>) =>
  `calendar-oauth:${row.tenantId}:${row.userId}:${row.id}`;

/** Keep a new sign-in; the state to send the provider. */
export async function beginSignIn(
  db: Database,
  a: { tenantId: string; userId: string; provider: string; verifier: string; returnTo: string },
): Promise<string> {
  const state = `cs${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  await forgetOldSignIns(db);
  await db.insert(calendarOauthStates).values({
    id,
    tenantId: a.tenantId,
    userId: a.userId,
    provider: a.provider,
    stateHash: hashOf(state),
    verifierSealed: requireSecretBox().seal(
      a.verifier,
      verifierAad({ id, tenantId: a.tenantId, userId: a.userId }),
    ),
    returnTo: a.returnTo,
    expiresAt: new Date(Date.now() + SIGN_IN_TTL_MS),
  });
  return state;
}

/** The live sign-in a state names, left in place (the callback only reads where to return). */
export async function findSignIn(db: Database, state: unknown): Promise<SignInRow | undefined> {
  if (typeof state !== 'string' || !STATE.test(state)) return undefined;
  const [row] = await db
    .select()
    .from(calendarOauthStates)
    .where(eq(calendarOauthStates.stateHash, hashOf(state)));
  return row && row.expiresAt > new Date() ? row : undefined;
}

/**
 * Take the sign-in a state names, once: whoever asks, it is gone afterwards, so a refused try
 * also ends it. Undefined when there is none, it was taken, or it is too old.
 */
export async function takeSignIn(db: Database, state: unknown): Promise<SignInRow | undefined> {
  if (typeof state !== 'string' || !STATE.test(state)) return undefined;
  const [row] = await db
    .delete(calendarOauthStates)
    .where(eq(calendarOauthStates.stateHash, hashOf(state)))
    .returning();
  return row && row.expiresAt > new Date() ? row : undefined;
}

/** The PKCE verifier of a sign-in taken. */
export const verifierOf = (row: SignInRow) =>
  requireSecretBox().open(row.verifierSealed, verifierAad(row));

/** Sign-ins nobody can finish any more. */
export async function forgetOldSignIns(db: Database): Promise<number> {
  const gone = await db
    .delete(calendarOauthStates)
    .where(lt(calendarOauthStates.expiresAt, new Date()))
    .returning({ id: calendarOauthStates.id });
  return gone.length;
}
