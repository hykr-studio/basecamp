// An OAuth connection's grant (decisions B24): sealed for its row with SECRETS_KEY (the bus's box;
// what is refreshed is sealed again with the current key), opened only to call the provider,
// refreshed when fewer than 60 seconds remain, and marked `needs_reauth` (audited, with a stored
// event its managers are told of) when the provider stops taking it.
import {
  type ConnectorRequestInit,
  isOAuthError,
  type OAuthContext,
  type OAuthCredentials,
  type OAuthResponse,
  type OAuthTokens,
  oauthCredentials,
  oauthRefresh,
  oauthRevoke,
  SecretBoxError,
} from '@hykr/connectors';
import { recordEvents, systemPrincipal } from '@hykr/core';
import { type Database, integrationAccounts, integrationConnections, writeAudit } from '@hykr/db';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { IntegrationEvent } from '../ops.js';
import { connectors } from '../registry.js';
import { connectionAad, requireSecretBox, secretBox } from '../settings.js';
import { oauthHttp } from './http.js';
import {
  isOAuthConnector,
  type OAuthConnector,
  oauthEndpoints,
  requireClient,
} from './settings.js';

const log = new Logger('OAuthConnections');

export type ConnectionRow = typeof integrationConnections.$inferSelect;

/** Refreshed when fewer than this many milliseconds remain. */
export const REFRESH_MARGIN_MS = 60_000;

/** Where an account's own token belongs: this business, connection and account only. */
export const accountAad = (tenantId: string, connectionId: string, accountId: string) =>
  `account:${tenantId}:${connectionId}:${accountId}`;

/** The provider no longer takes the connection's grant: someone must sign it in again. */
export class ConnectionNeedsReauth extends ConflictException {
  constructor(readonly connectionId: string) {
    super({
      error: 'conflict',
      rule: 'connection_needs_reauth',
      reason: 'This connection needs signing in again before it can be used',
    });
  }
}

export const isNeedsReauth = (e: unknown): e is ConnectionNeedsReauth =>
  e instanceof ConnectionNeedsReauth;

/** The grant, sealed for the connection's row. */
export const sealGrant = (tenantId: string, id: string, tokens: OAuthTokens) =>
  requireSecretBox().seal(
    JSON.stringify(oauthCredentials.parse(tokens)),
    connectionAad(tenantId, id),
  );

/** The grant, or null when it does not open here (another key, a copied value). */
export function openGrant(row: Pick<ConnectionRow, 'tenantId' | 'id' | 'credentialsSealed'>) {
  const box = secretBox();
  if (!box) return null;
  try {
    const plain = box.open(row.credentialsSealed, connectionAad(row.tenantId, row.id));
    const parsed = oauthCredentials.safeParse(JSON.parse(plain));
    return parsed.success ? (parsed.data as OAuthCredentials) : null;
  } catch (e) {
    if (e instanceof SecretBoxError || e instanceof SyntaxError) return null;
    throw e;
  }
}

/** What a connector's hooks call the provider with. */
export function oauthContext(c: OAuthConnector): OAuthContext {
  const endpoints = oauthEndpoints(c);
  return {
    http: oauthHttp(c),
    endpoints,
    client: requireClient(c),
    api: (path) =>
      /^https?:\/\//.test(path)
        ? path
        : `${endpoints.api ?? ''}${path.startsWith('/') ? '' : '/'}${path}`,
  };
}

function oauthConnectorOf(row: ConnectionRow): OAuthConnector {
  const c = connectors.get(row.connector);
  if (!isOAuthConnector(c)) throw new Error(`${row.connector} is not a connector that signs in`);
  return c;
}

/**
 * The connection needs signing in again: its status and why, an audit row and the stored event
 * `connection.needs_reauth` (its managers are told), in one transaction. Once: a connection
 * already marked is left as it is. True when this call marked it.
 */
export async function markNeedsReauth(
  db: Database,
  row: Pick<ConnectionRow, 'id' | 'tenantId' | 'connector' | 'label' | 'status'>,
  reason: string,
): Promise<boolean> {
  const job = 'integrations.oauth';
  const why = reason.slice(0, 500);
  return db.transaction(async (tx) => {
    const [marked] = await tx
      .update(integrationConnections)
      .set({ status: 'needs_reauth', lastError: why, updatedAt: new Date() })
      .where(
        and(
          eq(integrationConnections.id, row.id),
          ne(integrationConnections.status, 'needs_reauth'),
        ),
      )
      .returning({ id: integrationConnections.id });
    if (!marked) return false;
    await writeAudit(tx, {
      action: 'integrations.connection.needs_reauth',
      resourceType: 'integration_connection',
      resourceId: row.id,
      actorKind: 'system',
      actorId: job,
      tenantId: row.tenantId,
      channel: 'background',
      before: { status: row.status },
      after: { status: 'needs_reauth', reason: why },
    });
    await recordEvents(tx, {
      principal: systemPrincipal({ tenantId: row.tenantId, job }),
      events: [
        new IntegrationEvent('connection.needs_reauth', {
          id: row.id,
          tenantId: row.tenantId,
          connector: row.connector,
          label: row.label ?? row.connector,
          reason: why,
        }),
      ],
    });
    log.warn(`connection ${row.id} (${row.connector}) needs signing in again: ${why}`);
    return true;
  });
}

/** A refusal that means the grant is gone (not a provider having a bad minute). */
const grantGone = (e: unknown) =>
  isOAuthError(e) &&
  (e.code === 'invalid_grant' ||
    e.code === 'invalid_client' ||
    e.status === 401 ||
    e.status === 400);

/**
 * An access token good for a minute more: the stored one, or a fresh one (sealed again, with the
 * current key). `force`: refresh even if the stored one looks good (the provider just refused
 * it). Throws `ConnectionNeedsReauth` when the grant no longer works (the connection is marked).
 */
export async function accessTokenFor(
  db: Database,
  row: ConnectionRow,
  options: { force?: boolean } = {},
): Promise<string> {
  if (row.status !== 'active') throw new ConnectionNeedsReauth(row.id);
  const c = oauthConnectorOf(row);
  const grant = openGrant(row);
  if (!grant) {
    await markNeedsReauth(db, row, 'The stored grant does not open on this server');
    throw new ConnectionNeedsReauth(row.id);
  }
  const fresh = !grant.expiresAt || grant.expiresAt > Date.now() + REFRESH_MARGIN_MS;
  if (fresh && !options.force) return grant.accessToken;
  if (c.oauth.refresh === false || !grant.refreshToken) {
    // Nothing to refresh with: a token past its time, or one the provider refused, is the end.
    await markNeedsReauth(
      db,
      row,
      options.force ? `${c.name} no longer accepts this connection` : 'The grant expired',
    );
    throw new ConnectionNeedsReauth(row.id);
  }
  const ctx = oauthContext(c);
  let next: OAuthTokens;
  try {
    next = await oauthRefresh(ctx.http, {
      endpoints: ctx.endpoints,
      client: ctx.client,
      refreshToken: grant.refreshToken,
    });
  } catch (e) {
    if (grantGone(e)) {
      await markNeedsReauth(
        db,
        row,
        `${c.name} refused to refresh the grant (${(e as Error).message})`,
      );
      throw new ConnectionNeedsReauth(row.id);
    }
    throw e;
  }
  const kept: OAuthTokens = { ...next, scopes: next.scopes ?? grant.scopes };
  await db
    .update(integrationConnections)
    .set({
      credentialsSealed: sealGrant(row.tenantId, row.id, kept),
      tokenExpiresAt: kept.expiresAt ? new Date(kept.expiresAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, row.id));
  return kept.accessToken;
}

/** An account's own token (a page's), or null when the provider gave it none. */
export async function accountTokenFor(
  db: Database,
  row: ConnectionRow,
  accountId: string,
): Promise<string | null> {
  const [account] = await db
    .select()
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.connectionId, row.id),
        eq(integrationAccounts.accountId, accountId),
      ),
    );
  if (!account) throw new NotFoundException({ error: 'not_found', message: 'No such account' });
  if (!account.tokenSealed) return null;
  try {
    return requireSecretBox().open(
      account.tokenSealed,
      accountAad(row.tenantId, row.id, account.accountId),
    );
  } catch (e) {
    if (e instanceof SecretBoxError) return null;
    throw e;
  }
}

async function loadRow(db: Database, ref: { tenantId: string; connectionId: string }) {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, ref.connectionId),
        eq(integrationConnections.tenantId, ref.tenantId),
      ),
    );
  if (!row) throw new NotFoundException({ error: 'not_found', message: 'No such connection' });
  return row;
}

/**
 * A call to the connection's provider, on its behalf: under the egress guard, to the connector's
 * hosts only, with a fresh access token (or the account's own). A 401, or what the connector
 * counts as one, refreshes and retries once; a second one, or an account token refused, marks
 * the connection `needs_reauth` and throws `ConnectionNeedsReauth`. Another business's
 * connection is a 404.
 */
export async function connectorRequest(
  db: Database,
  ref: { tenantId: string; connectionId: string },
  init: ConnectorRequestInit,
): Promise<OAuthResponse> {
  let row = await loadRow(db, ref);
  const c = oauthConnectorOf(row);
  const ctx = oauthContext(c);
  const url = ctx.api(init.url);
  const refused = (res: OAuthResponse) => res.status === 401 || !!c.oauth.isAuthError?.(res);
  const send = (token: string) =>
    ctx.http({
      method: init.method ?? 'GET',
      url,
      headers: {
        accept: 'application/json',
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  if (row.status !== 'active') throw new ConnectionNeedsReauth(row.id);
  if (init.account) {
    const token = (await accountTokenFor(db, row, init.account)) ?? (await accessTokenFor(db, row));
    const res = await send(token);
    if (!refused(res)) return res;
    // An account's token is not refreshed: the grant it came from has to be signed in again.
    await markNeedsReauth(
      db,
      row,
      `${c.name} no longer accepts the token of account ${init.account}`,
    );
    throw new ConnectionNeedsReauth(row.id);
  }
  const first = await send(await accessTokenFor(db, row));
  if (!refused(first)) return first;
  row = await loadRow(db, ref);
  const again = await send(await accessTokenFor(db, row, { force: true }));
  if (!refused(again)) return again;
  await markNeedsReauth(db, row, `${c.name} refused the connection's token twice`);
  throw new ConnectionNeedsReauth(row.id);
}

/**
 * Withdraw a removed connection's grant at the provider: the connector's own `revoke`, or RFC
 * 7009 on its revoke URL. Best effort: a failure is logged; the connection is gone either way.
 */
export async function revokeGrant(c: OAuthConnector, grant: OAuthCredentials): Promise<void> {
  try {
    const ctx = oauthContext(c);
    if (c.oauth.revoke) await c.oauth.revoke(grant, ctx);
    else if (ctx.endpoints.revoke)
      await oauthRevoke(ctx.http, {
        endpoints: ctx.endpoints,
        client: ctx.client,
        token: grant.refreshToken ?? grant.accessToken,
      });
  } catch (e) {
    log.warn(`Revoking a ${c.name} grant failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
