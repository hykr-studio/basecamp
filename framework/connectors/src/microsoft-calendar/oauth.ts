// The Microsoft identity platform (v2.0) for a person's calendar: the consent URL (authorization
// code with PKCE S256), the code exchange, refreshing an access token. Works for work accounts
// (Entra ID) and personal Outlook.com accounts with the `common` tenant. There is no revoke
// endpoint for this flow: a disconnect deletes the tokens, and the person removes the app in
// their account.
import {
  aadstsOf,
  MICROSOFT_ENDPOINTS,
  MicrosoftApiError,
  type MicrosoftEndpoints,
  type MicrosoftTransport,
  microsoftError,
} from './transport.js';

/**
 * What a connection asks for: a refresh token (offline_access), the account to name it (openid,
 * email, profile: work accounts often carry no `email` claim, only `preferred_username`), and
 * the calendar (write our events, read busy times and changes to ours).
 */
export const MICROSOFT_CALENDAR_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Calendars.ReadWrite',
] as const;

export interface MicrosoftAuthorizationRequest {
  clientId: string;
  /** The directory: 'common' (work and personal), 'organizations', 'consumers' or an id. */
  tenant: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  loginHint?: string;
  endpoints?: MicrosoftEndpoints;
}

const loginUrl = (e: MicrosoftEndpoints | undefined, tenant: string, path: string) =>
  `${(e ?? MICROSOFT_ENDPOINTS).login}/${encodeURIComponent(tenant)}/oauth2/v2.0/${path}`;

/** The consent screen's URL. */
export function microsoftAuthorizationUrl(r: MicrosoftAuthorizationRequest): string {
  const url = new URL(loginUrl(r.endpoints, r.tenant, 'authorize'));
  const params: Record<string, string> = {
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: (r.scopes ?? MICROSOFT_CALENDAR_SCOPES).join(' '),
    state: r.state,
    code_challenge: r.codeChallenge,
    code_challenge_method: 'S256',
    // The person may have several accounts signed in: let them pick the calendar's.
    prompt: 'select_account',
    ...(r.loginHint ? { login_hint: r.loginHint } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** A grant's tokens. `expiresAt` is epoch milliseconds. */
export interface MicrosoftTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  /** The account, from the ID token: its address and its object id. */
  email?: string;
  accountId?: string;
}

/**
 * The account in an ID token's payload: `email`, else `preferred_username` (an address for
 * personal accounts and almost every work account), and `oid`. The token came straight from the
 * token endpoint over TLS, so its signature need not be checked (OpenID Connect Core 3.1.3.7).
 */
export function accountOfIdToken(idToken: string | undefined): { email?: string; id?: string } {
  const payload = idToken?.split('.')[1];
  if (!payload) return {};
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const email = str(c.email) ?? str(c.preferred_username);
    const id = str(c.oid) ?? str(c.sub);
    return { ...(email ? { email } : {}), ...(id ? { id } : {}) };
  } catch {
    return {};
  }
}

function tokensOf(body: unknown, now: number): MicrosoftTokens {
  const b = body as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
    id_token?: string;
  };
  if (!b?.access_token) throw new Error('Microsoft returned no access token');
  const account = accountOfIdToken(b.id_token);
  return {
    accessToken: b.access_token,
    ...(b.refresh_token ? { refreshToken: b.refresh_token } : {}),
    expiresAt: now + Math.max(60, Number(b.expires_in ?? 3600)) * 1000,
    ...(b.scope ? { scope: b.scope } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.id ? { accountId: account.id } : {}),
  };
}

interface Client {
  clientId: string;
  clientSecret: string;
  tenant: string;
  endpoints?: MicrosoftEndpoints;
}

async function tokenRequest(
  transport: MicrosoftTransport,
  c: Client,
  values: Record<string, string>,
  what: string,
): Promise<MicrosoftTokens> {
  const now = Date.now();
  const res = await transport({
    method: 'POST',
    url: loginUrl(c.endpoints, c.tenant, 'token'),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
      ...values,
    }).toString(),
  });
  if (res.status !== 200) throw microsoftError(res.status, res.body, what);
  return tokensOf(res.body, now);
}

/** The code from the consent screen, for tokens. */
export function microsoftExchangeCode(
  transport: MicrosoftTransport,
  c: Client & { code: string; codeVerifier: string; redirectUri: string },
): Promise<MicrosoftTokens> {
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

/**
 * A fresh access token. Microsoft usually sends a new refresh token too (keep it); a revoked or
 * expired grant is refused with `invalid_grant`.
 */
export async function microsoftRefreshToken(
  transport: MicrosoftTransport,
  c: Client & { refreshToken: string },
): Promise<MicrosoftTokens> {
  const tokens = await tokenRequest(
    transport,
    c,
    { grant_type: 'refresh_token', refresh_token: c.refreshToken },
    'Refreshing the token',
  );
  return { ...tokens, refreshToken: tokens.refreshToken ?? c.refreshToken };
}

/** AADSTS codes that mean an administrator of the organisation must approve the app first. */
export const ADMIN_CONSENT_CODES = ['AADSTS65001', 'AADSTS90094', 'AADSTS90008', 'AADSTS900941'];

/**
 * The organisation requires an admin's consent: from a token error, or from the query the
 * consent screen sent the browser back with (`error`, `error_description`).
 */
export function isAdminConsentError(e: unknown): boolean {
  if (e instanceof MicrosoftApiError)
    return (
      e.aadsts.some((c) => ADMIN_CONSENT_CODES.includes(c)) ||
      e.code === 'consent_required' ||
      e.code === 'admin_consent_required'
    );
  const q = (e ?? {}) as { error?: unknown; error_description?: unknown };
  if (typeof q.error !== 'string') return false;
  if (q.error === 'consent_required' || q.error === 'admin_consent_required') return true;
  return aadstsOf(q.error_description).some((c) => ADMIN_CONSENT_CODES.includes(c));
}

/** The grant no longer works: the person must connect again. */
export const isMicrosoftRevoked = (e: unknown) =>
  e instanceof MicrosoftApiError &&
  (e.code === 'invalid_grant' || e.code === 'interaction_required' || e.status === 401);
