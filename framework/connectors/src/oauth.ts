// OAuth 2.0 for a connector (decisions B21): what a connector declares to be connected by signing
// in, and the provider calls the server makes for it (the consent screen's URL, the code exchange,
// a refresh, a revoke). Every call goes through an `OAuthHttp` the server hands in, built on the
// egress guard: nothing here reaches the network on its own, reads the environment or stores.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/** One request to the provider. */
export interface OAuthRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The provider's answer: the status and the body, parsed when it is JSON. */
export interface OAuthResponse {
  status: number;
  body: unknown;
}

/** How the server calls the provider: under the egress guard, to the connector's hosts only. */
export type OAuthHttp = (req: OAuthRequest) => Promise<OAuthResponse>;

/** A grant's tokens. `expiresAt` is epoch milliseconds; absent when the token does not expire. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** What the provider says it granted, when it says. */
  scopes?: string[];
}

/** What a connection stores, sealed: the grant's tokens. Never shown, logged or exported. */
export const oauthCredentials = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
});
export type OAuthCredentials = z.infer<typeof oauthCredentials>;

/** The deployment's OAuth client for a connector, from its environment (`<clientFrom>_ID`, `_SECRET`). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Where the provider is, as this deployment reaches it (the declared URLs, or its overrides). */
export interface OAuthEndpoints {
  authorize: string;
  token: string;
  revoke?: string;
  /** The base of the connector's own calls, without a trailing slash. */
  api?: string;
}

/** An account a grant reaches (a page, a shop): its id routes a shared webhook URL to it. */
export interface OAuthAccount {
  /** The provider's id for it. At most 200 characters. */
  id: string;
  name: string;
  /** The account's own token, when the provider gives one (a page token). Sealed, never shown. */
  token?: string;
}

/** What a sign-in leaves behind besides its tokens: public fields and the accounts it reaches. */
export interface OAuthDescription {
  /** Shown back and audited: names, not secrets. */
  public?: Record<string, string>;
  accounts?: OAuthAccount[];
}

/** What a connector's OAuth hooks call the provider with. */
export interface OAuthContext {
  http: OAuthHttp;
  endpoints: OAuthEndpoints;
  client: OAuthClient;
  /** `endpoints.api` + path (a full URL is returned as it is). */
  api(path: string): string;
}

/**
 * A call to the provider on a connection's behalf, made by the server: the URL (or a path under
 * the API base) and, by default, the connection's fresh access token as a bearer token, or the
 * account's token when `account` is given. The server refreshes, retries once and marks the
 * connection when the provider stops accepting it.
 */
export interface ConnectorRequestInit {
  method?: OAuthRequest['method'];
  /** A path under the API base (`/me/accounts`) or a full URL on one of the connector's hosts. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Use this account's token instead of the connection's. */
  account?: string;
}

export type ConnectorCall = (init: ConnectorRequestInit) => Promise<OAuthResponse>;

/**
 * A connector that is connected by signing in (OAuth 2.0 authorization code, PKCE by default).
 * The URLs are fixed (https, on `hosts`), checked when the connector is defined; a deployment may
 * point them elsewhere (`<clientFrom>_AUTHORIZE_URL`, `_TOKEN_URL`, `_REVOKE_URL`, `_API_URL`),
 * checked when the server starts. The client is the deployment's, never a business's.
 */
export interface ConnectorOAuth {
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation, called when a connection is removed. */
  revokeUrl?: string;
  /** The base of the connector's own calls (an API), without a trailing slash. */
  apiUrl?: string;
  /** Every host the flow and the connector's calls may reach. Each URL above must be on one. */
  hosts: readonly string[];
  /** What the connector needs. Fewer granted is refused (`oauth_scopes_missing`). */
  scopes: readonly string[];
  /** How the scopes are joined in the consent URL. Default ' '. */
  scopeSeparator?: string;
  /** PKCE S256. Default true. */
  pkce?: boolean;
  /**
   * The grant's access token is refreshed with its refresh token. Default true. False: at expiry
   * the connection needs signing in again, and its managers hear of it a week before.
   */
  refresh?: boolean;
  /** The environment prefix of the deployment's client: `META_APP` → META_APP_ID, META_APP_SECRET. */
  clientFrom: string;
  /** More parameters for the consent URL. */
  extraParams?: Readonly<Record<string, string>>;
  /** Swap the tokens the code gave for lasting ones (a provider's long-lived exchange). */
  exchange?(tokens: OAuthTokens, ctx: OAuthContext): Promise<OAuthTokens>;
  /** The scopes granted, for a provider whose token answer does not say. */
  grantedScopes?(tokens: OAuthTokens, ctx: OAuthContext): Promise<string[]>;
  /** The public fields and accounts this grant reaches, read from the provider's own answer. */
  describe?(tokens: OAuthTokens, ctx: OAuthContext): Promise<OAuthDescription>;
  /**
   * The person picks which of the accounts the connection holds (a second step); each one picked
   * is subscribed. Without it, every account `describe` gives is held at once.
   */
  pick?: { subscribe(account: OAuthAccount, call: ConnectorCall): Promise<void> };
  /** Withdraw the grant, for a provider with no RFC 7009 endpoint. */
  revoke?(tokens: OAuthTokens, ctx: OAuthContext): Promise<void>;
  /** The provider's way of saying a token is no longer good, besides a 401. */
  isAuthError?(res: OAuthResponse): boolean;
}

/** The provider refused (a bad code, `invalid_grant`, an expired token). */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  constructor(
    readonly status: number,
    /** The provider's error code (`invalid_grant`), or `http_<status>`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isOAuthError = (e: unknown): e is OAuthError =>
  e instanceof OAuthError || (e instanceof Error && e.name === 'OAuthError');

/** The error a provider's answer carries, without echoing tokens it may contain. */
export function oauthError(status: number, body: unknown, what: string): OAuthError {
  const b = (body ?? {}) as { error?: unknown; error_description?: unknown };
  const err = b.error;
  const code =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'code' in err
        ? `code_${String((err as { code: unknown }).code)}`
        : `http_${status}`;
  const detail =
    typeof b.error_description === 'string'
      ? b.error_description
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : '';
  return new OAuthError(
    status,
    code.slice(0, 100),
    `${what}: ${status} ${code}${detail ? ` (${detail.slice(0, 200)})` : ''}`,
  );
}

/* ── PKCE and the consent URL ──────────────────────────────────────────────── */

/** A PKCE verifier (kept on the server) and its S256 challenge (sent to the consent screen). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/** The consent screen's URL. */
export function oauthAuthorizationUrl(a: {
  oauth: ConnectorOAuth;
  endpoints: OAuthEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}): string {
  const url = new URL(a.endpoints.authorize);
  const params: Record<string, string> = {
    ...(a.oauth.extraParams ?? {}),
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    response_type: 'code',
    scope: a.oauth.scopes.join(a.oauth.scopeSeparator ?? ' '),
    state: a.state,
    ...(a.codeChallenge ? { code_challenge: a.codeChallenge, code_challenge_method: 'S256' } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/* ── Tokens ────────────────────────────────────────────────────────────────── */

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

/** Scopes as a provider writes them: space or comma separated. */
export const splitScopes = (raw: unknown): string[] | undefined =>
  typeof raw === 'string'
    ? raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

/** A token endpoint's answer, as tokens. */
export function tokensOf(body: unknown, now = Date.now()): OAuthTokens {
  const b = (body ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof b.access_token !== 'string' || !b.access_token)
    throw new OAuthError(502, 'no_access_token', 'The provider returned no access token');
  const expiresIn = Number(b.expires_in);
  const scopes = splitScopes(b.scope);
  return {
    accessToken: b.access_token,
    ...(typeof b.refresh_token === 'string' && b.refresh_token
      ? { refreshToken: b.refresh_token }
      : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: now + Math.max(60, expiresIn) * 1000 }
      : {}),
    ...(scopes ? { scopes } : {}),
  };
}

async function tokenRequest(
  http: OAuthHttp,
  a: { endpoints: OAuthEndpoints; client: OAuthClient },
  values: Record<string, string>,
  what: string,
): Promise<OAuthTokens> {
  const now = Date.now();
  const res = await http({
    method: 'POST',
    url: a.endpoints.token,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form({ client_id: a.client.clientId, client_secret: a.client.clientSecret, ...values }),
  });
  if (res.status !== 200) throw oauthError(res.status, res.body, what);
  return tokensOf(res.body, now);
}

/** The code from the consent screen, for tokens. */
export function oauthExchangeCode(
  http: OAuthHttp,
  a: {
    endpoints: OAuthEndpoints;
    client: OAuthClient;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  },
): Promise<OAuthTokens> {
  return tokenRequest(
    http,
    a,
    {
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: a.redirectUri,
      ...(a.codeVerifier ? { code_verifier: a.codeVerifier } : {}),
    },
    'Exchanging the code',
  );
}

/** A fresh access token. A revoked or expired grant is refused (`invalid_grant`). */
export async function oauthRefresh(
  http: OAuthHttp,
  a: { endpoints: OAuthEndpoints; client: OAuthClient; refreshToken: string },
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(
    http,
    a,
    { grant_type: 'refresh_token', refresh_token: a.refreshToken },
    'Refreshing the token',
  );
  // Many providers keep the refresh token: carry it on.
  return { ...tokens, refreshToken: tokens.refreshToken ?? a.refreshToken };
}

/** RFC 7009: withdraw a token. Already gone (400) counts as done. */
export async function oauthRevoke(
  http: OAuthHttp,
  a: { endpoints: OAuthEndpoints; client: OAuthClient; token: string },
): Promise<void> {
  if (!a.endpoints.revoke) return;
  const res = await http({
    method: 'POST',
    url: a.endpoints.revoke,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      token: a.token,
      client_id: a.client.clientId,
      client_secret: a.client.clientSecret,
    }),
  });
  if (res.status === 200 || res.status === 204 || res.status === 400) return;
  throw oauthError(res.status, res.body, 'Revoking the grant');
}

/* ── Checks ────────────────────────────────────────────────────────────────── */

const PREFIX = /^[A-Z][A-Z0-9_]{0,39}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Is this URL https on one of the hosts (or on one the deployment lets through over any scheme,
 * for development)? The reason when it is not.
 */
export function oauthUrlProblem(
  raw: string,
  hosts: readonly string[],
  allowHosts: readonly string[] = [],
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a URL`;
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) return `${raw} carries a user name or password`;
  if (allowHosts.includes(host)) return null;
  if (url.protocol !== 'https:') return `${raw} is not https`;
  if (!hosts.includes(host)) return `${raw} is not on a listed host (${hosts.join(', ')})`;
  return null;
}

/** The problems with a connector's OAuth declaration, as written (its fixed URLs). */
export function oauthProblems(name: string, o: ConnectorOAuth): string[] {
  const problems: string[] = [];
  if (!PREFIX.test(o.clientFrom))
    problems.push(`clientFrom "${o.clientFrom}" must be an environment prefix like META_APP`);
  if (!o.hosts.length) problems.push('list the hosts the connector calls in oauth.hosts');
  for (const h of o.hosts)
    if (!HOST.test(h)) problems.push(`"${h}" in oauth.hosts is not a lower-case host name`);
  if (!o.scopes.length) problems.push('name at least one scope');
  const urls: [string, string | undefined][] = [
    ['authorizeUrl', o.authorizeUrl],
    ['tokenUrl', o.tokenUrl],
    ['revokeUrl', o.revokeUrl],
    ['apiUrl', o.apiUrl],
  ];
  for (const [field, url] of urls) {
    if (url === undefined) continue;
    const problem = oauthUrlProblem(url, o.hosts);
    if (problem) problems.push(`${field}: ${problem}`);
  }
  if (o.pick && !o.describe) problems.push('oauth.pick needs oauth.describe to offer the accounts');
  return problems.map((p) => `Connector ${name}: ${p}`);
}
