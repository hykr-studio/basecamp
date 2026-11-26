// The calendar feature's deployment settings, read from the environment when used (a test sets
// them before it boots the app):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the OAuth client; unset: Google is not offered
//   GOOGLE_CALENDAR_REDIRECT_URL             default <BETTER_AUTH_URL>/api/calendar/google/callback
//   GOOGLE_CALENDAR_TRANSPORT                live (default) or fake (the in-memory Google)
//   GOOGLE_OAUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_CALENDAR_API_URL   overrides
//   CALENDAR_PROVIDERS                       the providers turned on: google (default), microsoft
//   MICROSOFT_CALENDAR_CLIENT_ID, MICROSOFT_CALENDAR_CLIENT_SECRET   unset: Microsoft is not offered
//   MICROSOFT_CALENDAR_TENANT                common (default: work and personal accounts), or an id
//   MICROSOFT_CALENDAR_REDIRECT_URL          default <BETTER_AUTH_URL>/api/calendar/microsoft/callback
//   MICROSOFT_CALENDAR_TRANSPORT             live (default) or fake (the in-memory Microsoft)
//   MICROSOFT_LOGIN_URL, MICROSOFT_GRAPH_URL overrides (the only hosts the live transport calls)
//   CALENDAR_PUBLIC_URL                      where Google posts and feeds are read (default BETTER_AUTH_URL)
//   CALENDAR_RETURN_URL                      where the browser goes after connecting (default <APP_URL>/calendar)
//   CALENDAR_APP_RETURN_URL                  the same for a native app (its deep link); unset: the web's
//   CALENDAR_SYNC_DAYS                       how far ahead a new connection is filled (default 90)
import {
  fakeGoogle,
  fetchTransport,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type GoogleTransport,
} from '@hykr/connectors/google-calendar';
import {
  fakeMicrosoft,
  guardedTransport,
  hostsOf,
  MICROSOFT_ENDPOINTS,
  type MicrosoftEndpoints,
  type MicrosoftTransport,
} from '@hykr/connectors/microsoft-calendar';

export type GoogleMode = 'live' | 'fake';

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  mode: GoogleMode;
  endpoints: GoogleEndpoints;
  transport: GoogleTransport;
}

const trimmed = (v: string | undefined) => (v ?? '').trim();
const noSlash = (v: string) => v.replace(/\/+$/, '');

// Read from the environment, not `config`: the server's public entry imports this file, and
// `config` is fixed when first imported (a test sets the environment before it boots the app).
const authUrl = (env: NodeJS.ProcessEnv) =>
  noSlash(trimmed(env.BETTER_AUTH_URL) || 'http://localhost:3000');
const appUrl = (env: NodeJS.ProcessEnv) => noSlash(trimmed(env.APP_URL) || 'http://localhost:8081');

/** Google's transport mode, checked: production never runs on the fake. */
export function googleMode(env: NodeJS.ProcessEnv = process.env): GoogleMode {
  const raw = trimmed(env.GOOGLE_CALENDAR_TRANSPORT).toLowerCase();
  if (raw && raw !== 'live' && raw !== 'fake')
    throw new Error(`GOOGLE_CALENDAR_TRANSPORT must be live or fake (got "${raw}")`);
  if (raw === 'fake' && env.NODE_ENV === 'production')
    throw new Error('GOOGLE_CALENDAR_TRANSPORT=fake is for tests: production talks to Google');
  return (raw || 'live') as GoogleMode;
}

/** Google, as this deployment reaches it; null when it has no OAuth client (not offered). */
export function googleSettings(env: NodeJS.ProcessEnv = process.env): GoogleSettings | null {
  const mode = googleMode(env);
  const clientId = trimmed(env.GOOGLE_CLIENT_ID) || (mode === 'fake' ? 'fake-client' : '');
  const clientSecret = trimmed(env.GOOGLE_CLIENT_SECRET) || (mode === 'fake' ? 'fake-secret' : '');
  if (!clientId || !clientSecret) return null;
  const endpoints: GoogleEndpoints =
    mode === 'fake'
      ? fakeGoogle().endpoints
      : {
          auth: trimmed(env.GOOGLE_OAUTH_URL) || GOOGLE_ENDPOINTS.auth,
          token: trimmed(env.GOOGLE_TOKEN_URL) || GOOGLE_ENDPOINTS.token,
          revoke: trimmed(env.GOOGLE_REVOKE_URL) || GOOGLE_ENDPOINTS.revoke,
          api: noSlash(trimmed(env.GOOGLE_CALENDAR_API_URL) || GOOGLE_ENDPOINTS.api),
        };
  return {
    clientId,
    clientSecret,
    redirectUri:
      trimmed(env.GOOGLE_CALENDAR_REDIRECT_URL) || `${authUrl(env)}/api/calendar/google/callback`,
    mode,
    endpoints,
    transport: mode === 'fake' ? fakeGoogle().transport : fetchTransport(),
  };
}

export type MicrosoftMode = 'live' | 'fake';

export interface MicrosoftSettings {
  clientId: string;
  clientSecret: string;
  /** The directory sign-ins go to: 'common' (work and personal accounts) or a tenant id. */
  tenant: string;
  redirectUri: string;
  mode: MicrosoftMode;
  endpoints: MicrosoftEndpoints;
  transport: MicrosoftTransport;
}

/** Microsoft's transport mode, checked: production never runs on the fake. */
export function microsoftMode(env: NodeJS.ProcessEnv = process.env): MicrosoftMode {
  const raw = trimmed(env.MICROSOFT_CALENDAR_TRANSPORT).toLowerCase();
  if (raw && raw !== 'live' && raw !== 'fake')
    throw new Error(`MICROSOFT_CALENDAR_TRANSPORT must be live or fake (got "${raw}")`);
  if (raw === 'fake' && env.NODE_ENV === 'production')
    throw new Error(
      'MICROSOFT_CALENDAR_TRANSPORT=fake is for tests: production talks to Microsoft',
    );
  return (raw || 'live') as MicrosoftMode;
}

const TENANT = /^[A-Za-z0-9.-]{1,100}$/;

/** Microsoft, as this deployment reaches it; null when it has no OAuth client (not offered). */
export function microsoftSettings(env: NodeJS.ProcessEnv = process.env): MicrosoftSettings | null {
  const mode = microsoftMode(env);
  const clientId =
    trimmed(env.MICROSOFT_CALENDAR_CLIENT_ID) || (mode === 'fake' ? 'fake-ms-client' : '');
  const clientSecret =
    trimmed(env.MICROSOFT_CALENDAR_CLIENT_SECRET) || (mode === 'fake' ? 'fake-ms-secret' : '');
  if (!clientId || !clientSecret) return null;
  const tenant = trimmed(env.MICROSOFT_CALENDAR_TENANT) || 'common';
  if (!TENANT.test(tenant))
    throw new Error(
      `MICROSOFT_CALENDAR_TENANT must be common, organizations, consumers or a tenant id (got "${tenant}")`,
    );
  const endpoints: MicrosoftEndpoints =
    mode === 'fake'
      ? fakeMicrosoft().endpoints
      : {
          login: noSlash(trimmed(env.MICROSOFT_LOGIN_URL) || MICROSOFT_ENDPOINTS.login),
          graph: noSlash(trimmed(env.MICROSOFT_GRAPH_URL) || MICROSOFT_ENDPOINTS.graph),
        };
  return {
    clientId,
    clientSecret,
    tenant,
    redirectUri:
      trimmed(env.MICROSOFT_CALENDAR_REDIRECT_URL) ||
      `${authUrl(env)}/api/calendar/microsoft/callback`,
    mode,
    endpoints,
    transport:
      mode === 'fake' ? fakeMicrosoft().transport : guardedTransport({ hosts: hostsOf(endpoints) }),
  };
}

/** This server's public address: where Google posts and where feeds are read. */
export const publicUrl = (env: NodeJS.ProcessEnv = process.env) =>
  noSlash(trimmed(env.CALENDAR_PUBLIC_URL) || authUrl(env));

/** Where the browser goes after connecting (with ?code=&state= or ?error=): the web app. */
export const returnUrl = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.CALENDAR_RETURN_URL) || `${appUrl(env)}/calendar`;

/** The same for a native app: its deep link (`<scheme>://calendar`), or else the web app's. */
export const appReturnUrl = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.CALENDAR_APP_RETURN_URL) || returnUrl(env);

/** How many days ahead a new connection is filled with the person's records. */
export function syncDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(trimmed(env.CALENDAR_SYNC_DAYS) || 90);
  return Number.isFinite(n) && n >= 1 && n <= 730 ? Math.floor(n) : 90;
}

/** At start: a bad transport mode or return address stops the API and the worker. */
export function checkCalendarSettings() {
  googleMode();
  microsoftMode();
  for (const [name, url] of [
    ['MICROSOFT_LOGIN_URL', trimmed(process.env.MICROSOFT_LOGIN_URL)],
    ['MICROSOFT_GRAPH_URL', trimmed(process.env.MICROSOFT_GRAPH_URL)],
  ]) {
    if (url && !url.startsWith('https://'))
      throw new Error(`${name} must be an https address (got "${url}")`);
  }
  for (const [name, url] of [
    ['CALENDAR_RETURN_URL', returnUrl()],
    ['CALENDAR_APP_RETURN_URL', appReturnUrl()],
  ]) {
    if (!URL.canParse(url)) throw new Error(`${name} is not an address (got "${url}")`);
  }
}

/** The host events' UIDs are named in: '<entity>-<id>@<host>'. */
export function uidHost(): string {
  try {
    return new URL(publicUrl()).hostname || 'basecamp.local';
  } catch {
    return 'basecamp.local';
  }
}

/** Where a person's feed is read (the token is the last segment). */
export const feedUrl = (token: string) => `${publicUrl()}/api/calendar/feed/${token}.ics`;

/** Providers post to a public https address only; elsewhere the poll does the work. */
export function watchAddress(inboundPath: string, mode: GoogleMode | MicrosoftMode): string | null {
  const base = publicUrl();
  if (mode === 'fake' || base.startsWith('https://')) return `${base}${inboundPath}`;
  return null;
}
