import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  createFakeGoogle,
  exchangeCode,
  GoogleApiError,
  googleCalendarClient,
  googleCalendarConnector,
  mergeBusy,
  notificationHeaders,
  pkcePair,
  refreshAccessToken,
  revokeToken,
} from './index.js';

const client = { clientId: 'cid', clientSecret: 'secret' };
const redirectUri = 'https://api.example.test/api/calendar/google/callback';

async function connected(email = 'ana@example.test') {
  const google = createFakeGoogle();
  const pkce = pkcePair();
  const url = authorizationUrl({
    ...client,
    redirectUri,
    state: 'sealed-state',
    codeChallenge: pkce.challenge,
  });
  const back = new URL(google.consent(url, email));
  const tokens = await exchangeCode(google.transport, {
    ...client,
    redirectUri,
    code: back.searchParams.get('code') ?? '',
    codeVerifier: pkce.verifier,
  });
  return { google, tokens, api: googleCalendarClient(google.transport, tokens), email };
}

describe('OAuth', () => {
  it('asks for offline access with PKCE S256 and the calendar scopes', () => {
    const url = new URL(
      authorizationUrl({ ...client, redirectUri, state: 's', codeChallenge: 'c' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid',
      redirect_uri: redirectUri,
      response_type: 'code',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(url.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/calendar.events',
    );
  });

  it('exchanges a code for tokens naming the account, and refreshes', async () => {
    const { google, tokens } = await connected();
    expect(tokens.email).toBe('ana@example.test');
    expect(tokens.refreshToken).toMatch(/^fake-rt-/);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const fresh = await refreshAccessToken(google.transport, {
      ...client,
      refreshToken: tokens.refreshToken as string,
    });
    expect(fresh.accessToken).not.toBe(tokens.accessToken);
    expect(fresh.refreshToken).toBe(tokens.refreshToken);
  });

  it('refuses a code with the wrong verifier, and a revoked grant', async () => {
    const google = createFakeGoogle();
    const pkce = pkcePair();
    const url = authorizationUrl({
      ...client,
      redirectUri,
      state: 's',
      codeChallenge: pkce.challenge,
    });
    const code = new URL(google.consent(url, 'b@example.test')).searchParams.get('code') ?? '';
    await expect(
      exchangeCode(google.transport, { ...client, redirectUri, code, codeVerifier: 'other' }),
    ).rejects.toMatchObject({ reason: 'invalid_grant' });

    const { google: g2, tokens } = await connected();
    await revokeToken(g2.transport, { token: tokens.refreshToken as string });
    expect(g2.revoked()).toContain(tokens.refreshToken);
    await expect(
      refreshAccessToken(g2.transport, { ...client, refreshToken: tokens.refreshToken as string }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe('the Calendar API', () => {
  const event = {
    id: 'bc0123456789abcdef',
    summary: 'Plan',
    start: { dateTime: '2026-11-07T09:00:00.000Z' },
    end: { dateTime: '2026-11-07T10:00:00.000Z' },
    extendedProperties: { private: { basecamp: '1' } },
  };

  it('upserts an event: inserted when new, replaced after, brought back after a delete', async () => {
    const { google, api, email } = await connected();
    await api.upsertEvent('primary', event);
    expect(google.event(email, event.id)).toMatchObject({ summary: 'Plan', status: 'confirmed' });
    await api.upsertEvent('primary', { ...event, summary: 'Plan v2' });
    expect(google.event(email, event.id)?.summary).toBe('Plan v2');
    await api.deleteEvent('primary', event.id);
    expect(google.event(email, event.id)?.status).toBe('cancelled');
    await api.deleteEvent('primary', event.id); // already gone: fine
    await api.upsertEvent('primary', event);
    expect(google.event(email, event.id)?.status).toBe('confirmed');
    await expect(api.upsertEvent('primary', { ...event, id: 'Not-Base32' })).rejects.toThrow();
  });

  it('lists changes after a sync token, deleted events included, and starts over after a 410', async () => {
    const { google, api, email } = await connected();
    await api.upsertEvent('primary', event);
    const first = await api.changes('primary');
    expect(first.reset).toBe(false);
    expect(first.items.map((e) => e.id)).toEqual([event.id]);
    google.edit(email, event.id, { start: { dateTime: '2026-11-08T09:00:00.000Z' } });
    const moved = await api.changes('primary', first.nextSyncToken);
    expect(moved.items).toHaveLength(1);
    expect(moved.items[0].start?.dateTime).toBe('2026-11-08T09:00:00.000Z');
    google.remove(email, event.id);
    const removed = await api.changes('primary', moved.nextSyncToken);
    expect(removed.items[0].status).toBe('cancelled');
    expect((await api.changes('primary', removed.nextSyncToken)).items).toEqual([]);
    google.expireSyncTokens(email);
    const again = await api.changes('primary', removed.nextSyncToken);
    expect(again.reset).toBe(true);
  });

  it('reads busy times, merged', async () => {
    const { google, api, email } = await connected();
    google.addOwnEvent(email, { start: '2026-11-07T09:00:00Z', end: '2026-11-07T10:00:00Z' });
    google.addOwnEvent(email, { start: '2026-11-07T09:30:00Z', end: '2026-11-07T11:00:00Z' });
    google.addOwnEvent(email, { start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' });
    expect(
      await api.freeBusy({ from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' }),
    ).toEqual([{ start: '2026-11-07T09:00:00.000Z', end: '2026-11-07T11:00:00.000Z' }]);
    expect(mergeBusy([])).toEqual([]);
  });

  it('opens and stops a channel; a call without a valid token is refused', async () => {
    const { google, api, email } = await connected();
    const ch = await api.watch('primary', {
      id: 'ch-1',
      token: 't'.repeat(40),
      address: 'https://api.example.test/webhooks/google-calendar/x',
      ttlSeconds: 3600,
    });
    expect(ch.expiration).toBeGreaterThan(Date.now());
    expect(google.channels(email)).toHaveLength(1);
    await api.stopChannel({ id: ch.id, resourceId: ch.resourceId });
    expect(google.channels(email)).toHaveLength(0);
    google.expireAccessTokens();
    await expect(api.changes('primary')).rejects.toMatchObject({ status: 401 });
  });
});

describe('the push connector', () => {
  const token = 'k'.repeat(43);
  const req = (headers: Record<string, string>) => ({
    rawBody: Buffer.alloc(0),
    headers,
    body: undefined,
    query: {},
  });
  const headers = notificationHeaders({
    channelId: 'ch-1',
    token,
    resourceId: 'res-1',
    state: 'exists',
    messageNumber: 7,
  });

  it('verifies the channel token and reads the notification', () => {
    const inbound = googleCalendarConnector.inbound;
    expect(inbound?.bodyless).toBe(true);
    expect(inbound?.verify(req(headers), { channelToken: token })).toBe(true);
    expect(inbound?.verify(req(headers), { channelToken: 'x'.repeat(43) })).toBe(false);
    const { 'x-goog-channel-token': _t, ...withoutToken } = headers;
    expect(inbound?.verify(req(withoutToken), { channelToken: token })).toBe(false);
    expect(inbound?.parse(req(headers), { channelToken: token })).toEqual([
      {
        id: 'ch-1:7',
        type: 'calendar.changed',
        data: {
          channelId: 'ch-1',
          resourceId: 'res-1',
          resourceState: 'exists',
          messageNumber: '7',
        },
      },
    ]);
    const sync = notificationHeaders({
      ...{ channelId: 'ch-1', token, resourceId: 'r' },
      state: 'sync',
      messageNumber: 1,
    });
    expect(inbound?.parse(req(sync), { channelToken: token })[0].type).toBe('calendar.sync');
    expect(googleCalendarConnector.generate?.().channelToken.length).toBeGreaterThanOrEqual(32);
  });
});
