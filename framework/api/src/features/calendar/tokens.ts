// A connection's OAuth tokens: sealed for its row with SECRETS_KEY (the integration bus's box),
// opened only to call the provider, refreshed when they are about to expire.
import { SecretBoxError } from '@hykr/connectors';
import {
  GoogleApiError,
  type GoogleTokens,
  refreshAccessToken,
} from '@hykr/connectors/google-calendar';
import { calendarConnections, type Database } from '@hykr/db';
import { eq } from 'drizzle-orm';
import { requireSecretBox, secretBox } from '../integrations/settings.js';
import type { GoogleSettings } from './settings.js';

export type ConnectionRow = typeof calendarConnections.$inferSelect;

/** What is sealed: the grant's tokens. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Where a sealed value belongs: it opens only for this business and row. */
export const tokensAad = (tenantId: string, id: string) => `calendar:${tenantId}:${id}`;

export function sealTokens(tenantId: string, id: string, t: StoredTokens): string {
  return requireSecretBox().seal(JSON.stringify(t), tokensAad(tenantId, id));
}

/** The tokens, or null when they do not open here (another key, a copied value). */
export function openTokens(row: Pick<ConnectionRow, 'tenantId' | 'id' | 'tokensSealed'>) {
  const box = secretBox();
  if (!box) return null;
  try {
    return JSON.parse(box.open(row.tokensSealed, tokensAad(row.tenantId, row.id))) as StoredTokens;
  } catch (e) {
    if (e instanceof SecretBoxError || e instanceof SyntaxError) return null;
    throw e;
  }
}

/** Google said the grant is gone: the person must connect again. */
export class GrantRevoked extends Error {
  override readonly name = 'GrantRevoked';
}

const isRevoked = (e: unknown) =>
  e instanceof GoogleApiError && (e.reason === 'invalid_grant' || e.status === 401);

/**
 * An access token good for a minute more: the stored one, or a fresh one (stored sealed again).
 * Throws `GrantRevoked` when the grant no longer works (the connection is marked).
 */
export async function accessTokenFor(
  db: Database,
  google: GoogleSettings,
  row: ConnectionRow,
): Promise<string> {
  const tokens = openTokens(row);
  if (!tokens) {
    await markReauth(db, row.id, 'The stored grant does not open on this server');
    throw new GrantRevoked('The stored grant does not open');
  }
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
  let fresh: GoogleTokens;
  try {
    fresh = await refreshAccessToken(google.transport, {
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      endpoints: google.endpoints,
      refreshToken: tokens.refreshToken,
    });
  } catch (e) {
    if (isRevoked(e)) {
      await markReauth(db, row.id, 'Google no longer accepts this connection: connect again');
      throw new GrantRevoked('Google refused the grant');
    }
    throw e;
  }
  const next: StoredTokens = {
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken ?? tokens.refreshToken,
    expiresAt: fresh.expiresAt,
  };
  await db
    .update(calendarConnections)
    .set({ tokensSealed: sealTokens(row.tenantId, row.id, next), updatedAt: new Date() })
    .where(eq(calendarConnections.id, row.id));
  return next.accessToken;
}

export async function markReauth(db: Database, id: string, reason: string) {
  await db
    .update(calendarConnections)
    .set({ status: 'needs_reauth', lastError: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(calendarConnections.id, id));
}
