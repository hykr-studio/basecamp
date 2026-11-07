// Google's OAuth 2.0 for a person's calendar: the consent URL (PKCE S256, offline access so a
// refresh token comes back), the code exchange, refreshing an access token and revoking a grant.
import { createHash, randomBytes } from 'node:crypto';
import {
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type GoogleTransport,
  googleError,
} from './transport.js';

/**
 * What a connection asks for: its own events (write ours, read changes to them), busy times, and
 * the account's email to name it. Nothing reads the details of other events.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;

/** A PKCE verifier (kept on the server) and its S256 challenge (sent to the consent screen). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  /** Opaque to Google, returned as is: the server's sealed state. */
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  /** The account to suggest. */
  loginHint?: string;
  endpoints?: GoogleEndpoints;
}

/** The consent screen's URL. */
export function authorizationUrl(r: AuthorizationRequest): string {
  const url = new URL((r.endpoints ?? GOOGLE_ENDPOINTS).auth);
  const params: Record<string, string> = {
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    response_type: 'code',
    scope: (r.scopes ?? GOOGLE_CALENDAR_SCOPES).join(' '),
    state: r.state,
    code_challenge: r.codeChallenge,
    code_challenge_method: 'S256',
    // A refresh token, every time: the person may have connected before.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    ...(r.loginHint ? { login_hint: r.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** A grant's tokens. `expiresAt` is epoch milliseconds. */
export interface GoogleTokens {
  accessToken: string;
  /** Only on the first exchange (and not always on a refresh). */
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  /** The account, from the ID token Google returned with the grant. */
  email?: string;
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

/**
 * The email in an ID token's payload. The token came straight from Google's token endpoint over
 * TLS, so its signature need not be checked (OpenID Connect Core 3.1.3.7).
 */
export function emailOfIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

function tokensOf(body: unknown, now: number): GoogleTokens {
  const b = body as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!b?.access_token) throw new Error('Google returned no access token');
  return {
    accessToken: b.access_token,
    ...(b.refresh_token ? { refreshToken: b.refresh_token } : {}),
    expiresAt: now + Math.max(60, Number(b.expires_in ?? 3600)) * 1000,
    ...(b.scope ? { scope: b.scope } : {}),
    ...(emailOfIdToken(b.id_token) ? { email: emailOfIdToken(b.id_token) } : {}),
  };
}

interface Client {
  clientId: string;
  clientSecret: string;
  endpoints?: GoogleEndpoints;
}

async function tokenRequest(
  transport: GoogleTransport,
  c: Client,
  values: Record<string, string>,
  what: string,
): Promise<GoogleTokens> {
  const now = Date.now();
  const res = await transport({
    method: 'POST',
    url: (c.endpoints ?? GOOGLE_ENDPOINTS).token,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form({ client_id: c.clientId, client_secret: c.clientSecret, ...values }),
  });
  if (res.status !== 200) throw googleError(res.status, res.body, what);
  return tokensOf(res.body, now);
}

/** The code from the consent screen, for tokens. */
export function exchangeCode(
  transport: GoogleTransport,
  c: Client & { code: string; codeVerifier: string; redirectUri: string },
): Promise<GoogleTokens> {
  return tokenRequest(
    transport,
    c,
    {
      grant_type: 'authorization_code',
      code: c.code,
      code_verifier: c.codeVerifier,
      redirect_uri: c.redirectUri,
    },
    'Exchanging the code',
  );
}

/** A fresh access token. Google refuses a revoked or expired grant with `invalid_grant`. */
export async function refreshAccessToken(
  transport: GoogleTransport,
  c: Client & { refreshToken: string },
): Promise<GoogleTokens> {
  const tokens = await tokenRequest(
    transport,
    c,
    { grant_type: 'refresh_token', refresh_token: c.refreshToken },
    'Refreshing the token',
  );
  // Google usually keeps the refresh token: carry it on.
  return { ...tokens, refreshToken: tokens.refreshToken ?? c.refreshToken };
}

/** Withdraw the grant (a refresh or access token). Already gone counts as done. */
export async function revokeToken(
  transport: GoogleTransport,
  a: { token: string; endpoints?: GoogleEndpoints },
): Promise<void> {
  const res = await transport({
    method: 'POST',
    url: (a.endpoints ?? GOOGLE_ENDPOINTS).revoke,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ token: a.token }),
  });
  if (res.status === 200 || res.status === 400) return;
  throw googleError(res.status, res.body, 'Revoking the grant');
}
