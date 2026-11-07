// The MCP clients' OAuth tokens, as the authorization server (Better Auth's oauth-provider) stores
// them: hashed, in public.oauth_*. Checking one here is a read of those tables with the provider's
// own rules, so the API never trusts a token the provider would call inactive.
import { createHash } from 'node:crypto';
import {
  type Database,
  type DbOrTx,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
} from '@hykr/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { ACCESS_PREFIX } from './config.js';

/** What a valid access token grants: a client, acting for a person, in one business. */
export interface McpGrant {
  /** The token itself, as sent (the MCP server forwards it to the API). */
  token: string;
  clientId: string;
  /** The name the client registered with, as it says (unverified). */
  clientName: string;
  userId: string;
  tenantId: string;
  scopes: string[];
  expiresAt: Date;
}

/** The stored form of a token: SHA-256, base64url without padding (the provider's "hashed"). */
export const storedToken = (raw: string) => createHash('sha256').update(raw).digest('base64url');

/** Whether a bearer value is one of ours (an MCP access token), by its prefix. */
export const isAccessToken = (value: string) =>
  value.startsWith(ACCESS_PREFIX) && value.length > ACCESS_PREFIX.length;

/**
 * The grant behind an access token, or null when it is not valid: unknown, revoked, expired, its
 * client gone or disabled, the session it was issued in over, bound to another resource, or
 * without a person or business.
 */
export async function verifyAccessToken(
  db: Database,
  raw: string,
  resource: string,
): Promise<McpGrant | null> {
  if (!isAccessToken(raw)) return null;
  const hashed = storedToken(raw.slice(ACCESS_PREFIX.length));
  const [row] = await db
    .select({
      token: oauthAccessToken,
      clientName: oauthClient.name,
      clientDisabled: oauthClient.disabled,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .where(eq(oauthAccessToken.token, hashed))
    .limit(1);
  if (!row) return null;
  const t = row.token;
  const now = new Date();
  if (!t.expiresAt || t.expiresAt < now || t.revoked || row.clientDisabled) return null;
  if (!t.userId || !t.referenceId) return null;
  if (t.resources?.length && !t.resources.includes(resource)) return null;
  if (t.sessionId) {
    const [s] = await db
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.id, t.sessionId))
      .limit(1);
    if (!s || s.expiresAt < now) return null;
  }
  return {
    token: raw,
    clientId: t.clientId,
    clientName: row.clientName ?? t.clientId,
    userId: t.userId,
    tenantId: t.referenceId,
    scopes: [...t.scopes],
    expiresAt: t.expiresAt,
  };
}

/** One client a person allowed, in one business. */
export interface McpConnection {
  clientId: string;
  name: string;
  uri: string | null;
  scopes: string[];
  connectedAt: string | null;
  updatedAt: string | null;
}

/** The clients a person allowed in this business, newest first. */
export async function connectionsOf(
  db: Database,
  userId: string,
  tenantId: string,
): Promise<McpConnection[]> {
  const rows = await db
    .select({ consent: oauthConsent, name: oauthClient.name, uri: oauthClient.uri })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.referenceId, tenantId)))
    .orderBy(desc(oauthConsent.updatedAt));
  return rows.map((r) => ({
    clientId: r.consent.clientId,
    name: r.name ?? r.consent.clientId,
    uri: r.uri,
    scopes: [...r.consent.scopes],
    connectedAt: r.consent.createdAt?.toISOString() ?? null,
    updatedAt: r.consent.updatedAt?.toISOString() ?? null,
  }));
}

/**
 * Disconnect a client from a person in one business, inside the caller's transaction: its consent
 * goes, and every access and refresh token it holds for them there is revoked at once. Whether
 * there was anything to take back.
 */
export async function revokeConnection(
  tx: DbOrTx,
  a: { userId: string; tenantId: string; clientId: string },
): Promise<boolean> {
  const gone = await tx
    .delete(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, a.userId),
        eq(oauthConsent.referenceId, a.tenantId),
        eq(oauthConsent.clientId, a.clientId),
      ),
    )
    .returning({ id: oauthConsent.id });
  const now = new Date();
  const access = await tx
    .update(oauthAccessToken)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthAccessToken.userId, a.userId),
        eq(oauthAccessToken.referenceId, a.tenantId),
        eq(oauthAccessToken.clientId, a.clientId),
        isNull(oauthAccessToken.revoked),
      ),
    )
    .returning({ id: oauthAccessToken.id });
  const refresh = await tx
    .update(oauthRefreshToken)
    .set({ revoked: now })
    .where(
      and(
        eq(oauthRefreshToken.userId, a.userId),
        eq(oauthRefreshToken.referenceId, a.tenantId),
        eq(oauthRefreshToken.clientId, a.clientId),
        isNull(oauthRefreshToken.revoked),
      ),
    )
    .returning({ id: oauthRefreshToken.id });
  return gone.length + access.length + refresh.length > 0;
}
