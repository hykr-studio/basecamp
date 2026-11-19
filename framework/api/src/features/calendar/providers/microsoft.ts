// Microsoft 365 / Outlook.com behind the provider interface (decisions B21): the identity
// platform's sign-in with PKCE, Graph's getSchedule for busy times, events keyed by an extended
// property, a calendarView delta query for changes, and change subscriptions.
import {
  fakeMicrosoft,
  isAdminConsentError,
  isMicrosoftRevoked,
  microsoftAuthorizationUrl,
  microsoftCalendarClient,
  microsoftExchangeCode,
  microsoftRefreshToken,
} from '@hykr/connectors/microsoft-calendar';
import type { MicrosoftSettings } from '../settings.js';
import type { CalendarProviderDef, ProviderChange } from './types.js';

export const ADMIN_CONSENT_REFUSAL = {
  rule: 'admin_consent_required',
  message:
    'Your organisation must approve this app before its calendars can connect: ask your Microsoft 365 administrator to grant consent, then connect again',
};

export function microsoftProvider(ms: MicrosoftSettings): CalendarProviderDef {
  const client = (accessToken: string) =>
    microsoftCalendarClient(ms.transport, { accessToken, endpoints: ms.endpoints });
  const oauthClient = {
    clientId: ms.clientId,
    clientSecret: ms.clientSecret,
    tenant: ms.tenant,
    endpoints: ms.endpoints,
  };
  return {
    name: 'microsoft',
    label: 'Microsoft',
    mode: ms.mode,
    inboundConnector: 'microsoft-calendar',
    jobName: 'calendar.microsoft',
    watchSecret: (c) => {
      const state = (c as { clientState?: unknown } | null)?.clientState;
      return typeof state === 'string' ? state : null;
    },
    oauth: {
      authorizationUrl: (a) =>
        microsoftAuthorizationUrl({
          clientId: ms.clientId,
          tenant: ms.tenant,
          redirectUri: ms.redirectUri,
          state: a.state,
          codeChallenge: a.codeChallenge,
          endpoints: ms.endpoints,
          ...(a.loginHint ? { loginHint: a.loginHint } : {}),
        }),
      exchangeCode: (a) =>
        microsoftExchangeCode(ms.transport, {
          ...oauthClient,
          redirectUri: ms.redirectUri,
          code: a.code,
          codeVerifier: a.codeVerifier,
        }),
      refresh: (refreshToken) =>
        microsoftRefreshToken(ms.transport, { ...oauthClient, refreshToken }),
      // No revoke endpoint for this flow: the tokens are deleted, and the person can remove the
      // app in their account (decisions B21).
      ...(ms.mode === 'fake'
        ? { fakeConsent: (url: string, email: string) => fakeMicrosoft().consent(url, email) }
        : {}),
    },
    isRevoked: isMicrosoftRevoked,
    refusal: (e) => (isAdminConsentError(e) ? ADMIN_CONSENT_REFUSAL : null),
    account: (t) => ({
      email: t.email ?? 'Microsoft account',
      ...(t.accountId ? { id: t.accountId } : {}),
    }),
    freeBusy: (token, a) =>
      client(token).getSchedule({ address: a.account, from: a.from, to: a.to }),
    async upsertEvent(token, _calendarId, e) {
      const { id } = await client(token).upsertEvent({
        key: e.key,
        ...(e.providerId ? { id: e.providerId } : {}),
        subject: e.title,
        ...(e.description ? { body: e.description } : {}),
        ...(e.location ? { location: e.location } : {}),
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        timeZone: e.timeZone,
      });
      return { providerId: id };
    },
    deleteEvent: (token, _calendarId, providerId) => client(token).deleteEvent(providerId),
    async changes(token, a) {
      const changes = await client(token).changes(a.cursor);
      const items: ProviderChange[] = [];
      for (const c of changes.items) {
        if (c.removed) items.push({ providerId: c.id, removed: true });
        else if (c.startsAt && c.endsAt)
          items.push({ providerId: c.id, removed: false, startsAt: c.startsAt, endsAt: c.endsAt });
      }
      return { items, cursor: changes.cursor, reset: changes.reset };
    },
    async watch(token, a) {
      const sub = await client(token).subscribe({
        notificationUrl: a.address,
        clientState: a.secret,
      });
      return { channelId: sub.id, resourceId: null, expiresAt: new Date(sub.expiresAt) };
    },
    stopWatch: (token, a) => client(token).unsubscribe(a.channelId),
  };
}
