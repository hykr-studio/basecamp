// Google Calendar behind the provider interface: the same calls the feature made before it had
// one (decisions B17), moved here unchanged.
import { randomUUID } from 'node:crypto';
import {
  authorizationUrl,
  exchangeCode,
  fakeGoogle,
  GoogleApiError,
  type GoogleEvent,
  googleCalendarClient,
  refreshAccessToken,
  revokeToken,
} from '@hykr/connectors/google-calendar';
import type { GoogleSettings } from '../settings.js';
import type { CalendarEventInput, CalendarProviderDef, ProviderChange } from './types.js';

/** A Google time as an ISO instant, or null for an all-day date. */
function timeOf(t: GoogleEvent['start']): string | null {
  if (!t?.dateTime) return null;
  const ms = Date.parse(t.dateTime);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The event Google keeps for a record. */
function googleEventOf(e: CalendarEventInput): GoogleEvent {
  return {
    id: e.key,
    status: 'confirmed',
    summary: e.title,
    ...(e.description ? { description: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
    start: { dateTime: e.startsAt },
    end: { dateTime: e.endsAt },
    extendedProperties: {
      private: {
        basecamp: '1',
        tenant: e.mark.tenant,
        entity: e.mark.entity,
        record: e.mark.record,
      },
    },
  };
}

export function googleProvider(google: GoogleSettings): CalendarProviderDef {
  const client = (accessToken: string) =>
    googleCalendarClient(google.transport, { accessToken, endpoints: google.endpoints });
  const oauthClient = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    endpoints: google.endpoints,
  };
  return {
    name: 'google',
    label: 'Google',
    mode: google.mode,
    inboundConnector: 'google-calendar',
    jobName: 'calendar.google',
    watchSecret: (c) => {
      const token = (c as { channelToken?: unknown } | null)?.channelToken;
      return typeof token === 'string' ? token : null;
    },
    oauth: {
      authorizationUrl: (a) =>
        authorizationUrl({
          clientId: google.clientId,
          redirectUri: google.redirectUri,
          state: a.state,
          codeChallenge: a.codeChallenge,
          endpoints: google.endpoints,
          ...(a.loginHint ? { loginHint: a.loginHint } : {}),
        }),
      exchangeCode: (a) =>
        exchangeCode(google.transport, {
          ...oauthClient,
          redirectUri: google.redirectUri,
          code: a.code,
          codeVerifier: a.codeVerifier,
        }),
      refresh: (refreshToken) =>
        refreshAccessToken(google.transport, { ...oauthClient, refreshToken }),
      revoke: (token) => revokeToken(google.transport, { token, endpoints: google.endpoints }),
      ...(google.mode === 'fake'
        ? { fakeConsent: (url: string, email: string) => fakeGoogle().consent(url, email) }
        : {}),
    },
    isRevoked: (e) =>
      e instanceof GoogleApiError && (e.reason === 'invalid_grant' || e.status === 401),
    refusal: () => null,
    account: (t) => ({ email: t.email ?? 'Google account' }),
    freeBusy: (token, a) =>
      client(token).freeBusy({ from: a.from, to: a.to, calendars: [a.calendarId] }),
    async upsertEvent(token, calendarId, event) {
      await client(token).upsertEvent(calendarId, googleEventOf(event));
      return { providerId: event.key };
    },
    deleteEvent: (token, calendarId, providerId) =>
      client(token).deleteEvent(calendarId, providerId),
    async changes(token, a) {
      const changes = await client(token).changes(a.calendarId, a.cursor);
      const items: ProviderChange[] = [];
      for (const item of changes.items) {
        // Only our events, of this business.
        const mark = item.extendedProperties?.private;
        if (mark?.basecamp !== '1' || mark.tenant !== a.tenantId) continue;
        if (item.status === 'cancelled') {
          items.push({ providerId: item.id, removed: true });
          continue;
        }
        const startsAt = timeOf(item.start);
        const endsAt = timeOf(item.end);
        if (startsAt && endsAt)
          items.push({ providerId: item.id, removed: false, startsAt, endsAt });
      }
      return { items, cursor: changes.nextSyncToken, reset: changes.reset };
    },
    async watch(token, a) {
      const channel = await client(token).watch(a.calendarId, {
        id: randomUUID(),
        token: a.secret,
        address: a.address,
        ttlSeconds: a.ttlSeconds,
      });
      return {
        channelId: channel.id,
        resourceId: channel.resourceId,
        expiresAt: new Date(channel.expiration),
      };
    },
    async stopWatch(token, a) {
      if (!a.resourceId) return;
      await client(token).stopChannel({ id: a.channelId, resourceId: a.resourceId });
    },
  };
}
