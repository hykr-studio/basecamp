// The calendar feature's deployment settings, read from the environment when used (a test sets
// them before it boots the app):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the OAuth client; unset: Google is not offered
//   GOOGLE_CALENDAR_REDIRECT_URL             default <BETTER_AUTH_URL>/api/calendar/google/callback
//   GOOGLE_CALENDAR_TRANSPORT                live (default) or fake (the in-memory Google)
//   GOOGLE_OAUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_CALENDAR_API_URL   overrides
//   CALENDAR_PUBLIC_URL                      where Google posts and feeds are read (default BETTER_AUTH_URL)
//   CALENDAR_RETURN_URL                      where the browser goes after connecting (default <APP_URL>/calendar)
//   CALENDAR_SYNC_DAYS                       how far ahead a new connection is filled (default 90)
import {
  fakeGoogle,
  fetchTransport,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type GoogleTransport,
} from '@hykr/connectors/google-calendar';
import { ServiceUnavailableException } from '@nestjs/common';

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

/** Google, or 503 `calendar_provider_unavailable`. */
export function requireGoogle(): GoogleSettings {
  const g = googleSettings();
  if (!g)
    throw new ServiceUnavailableException({
      error: 'unavailable',
      rule: 'calendar_provider_unavailable',
      reason: 'This server is not set up to connect Google calendars',
    });
  return g;
}

/** This server's public address: where Google posts and where feeds are read. */
export const publicUrl = (env: NodeJS.ProcessEnv = process.env) =>
  noSlash(trimmed(env.CALENDAR_PUBLIC_URL) || authUrl(env));

/** Where the browser goes after connecting (with ?connected= or ?error=). */
export const returnUrl = (env: NodeJS.ProcessEnv = process.env) =>
  trimmed(env.CALENDAR_RETURN_URL) || `${appUrl(env)}/calendar`;

/** How many days ahead a new connection is filled with the person's records. */
export function syncDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(trimmed(env.CALENDAR_SYNC_DAYS) || 90);
  return Number.isFinite(n) && n >= 1 && n <= 730 ? Math.floor(n) : 90;
}

/** At start: a bad transport mode stops the API and the worker. */
export function checkCalendarSettings() {
  googleMode();
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

/** Google posts to a public https address only; elsewhere the poll does the work. */
export function watchAddress(inboundPath: string, mode: GoogleMode): string | null {
  const base = publicUrl();
  if (mode === 'fake' || base.startsWith('https://')) return `${base}${inboundPath}`;
  return null;
}
