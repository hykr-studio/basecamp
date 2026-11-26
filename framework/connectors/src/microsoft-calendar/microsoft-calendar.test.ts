import { describe, expect, it } from 'vitest';
import {
  accountOfIdToken,
  BASECAMP_KEY_PROPERTY,
  createFakeMicrosoft,
  guardedTransport,
  instantOf,
  isAdminConsentError,
  isMicrosoftRevoked,
  MicrosoftApiError,
  microsoftAuthorizationUrl,
  microsoftCalendarClient,
  microsoftCalendarConnector,
  microsoftError,
  microsoftExchangeCode,
  microsoftRefreshToken,
  validationTokenOf,
  wallTimeIn,
} from './index.js';

const pkce = { verifier: 'v'.repeat(64) };
const challenge = async () =>
  (await import('../google-calendar/oauth.js')).pkceChallenge(pkce.verifier);

async function signedIn(fake = createFakeMicrosoft(), email = 'ana@contoso.example') {
  const url = microsoftAuthorizationUrl({
    clientId: 'c',
    tenant: 'common',
    redirectUri: 'https://app.example/cb',
    state: 'st',
    codeChallenge: await challenge(),
    endpoints: fake.endpoints,
  });
  const back = new URL(fake.consent(url, email));
  const tokens = await microsoftExchangeCode(fake.transport, {
    clientId: 'c',
    clientSecret: 's',
    tenant: 'common',
    endpoints: fake.endpoints,
    redirectUri: 'https://app.example/cb',
    code: back.searchParams.get('code') ?? '',
    codeVerifier: pkce.verifier,
  });
  const client = microsoftCalendarClient(fake.transport, {
    accessToken: tokens.accessToken,
    endpoints: fake.endpoints,
  });
  return { fake, tokens, client, email };
}

describe('sign-in', () => {
  it('asks for offline access to the calendar with PKCE, on the tenant given', () => {
    const url = new URL(
      microsoftAuthorizationUrl({
        clientId: 'client',
        tenant: 'common',
        redirectUri: 'https://api.example/api/calendar/microsoft/callback',
        state: 'cs123',
        codeChallenge: 'chal',
        loginHint: 'ana@contoso.example',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')).toBe(
      'openid email profile offline_access Calendars.ReadWrite',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('login_hint')).toBe('ana@contoso.example');
  });

  it('exchanges the code, names the account, and keeps the rotated refresh token', async () => {
    const { fake, tokens } = await signedIn();
    expect(tokens.email).toBe('ana@contoso.example');
    expect(tokens.refreshToken).toBeTruthy();
    const fresh = await microsoftRefreshToken(fake.transport, {
      clientId: 'c',
      clientSecret: 's',
      tenant: 'common',
      endpoints: fake.endpoints,
      refreshToken: tokens.refreshToken as string,
    });
    expect(fresh.refreshToken).not.toBe(tokens.refreshToken);
    fake.refuseRefresh('ana@contoso.example');
    const refused = await microsoftRefreshToken(fake.transport, {
      clientId: 'c',
      clientSecret: 's',
      tenant: 'common',
      endpoints: fake.endpoints,
      refreshToken: fresh.refreshToken as string,
    }).catch((e) => e);
    expect(isMicrosoftRevoked(refused)).toBe(true);
  });

  it('reads the account from email, else preferred_username', () => {
    const token = (claims: object) =>
      `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    expect(accountOfIdToken(token({ preferred_username: 'bo@x.example', oid: 'o1' }))).toEqual({
      email: 'bo@x.example',
      id: 'o1',
    });
    expect(accountOfIdToken(token({ email: 'a@x.example', preferred_username: 'b' })).email).toBe(
      'a@x.example',
    );
    expect(accountOfIdToken('not a token')).toEqual({});
  });

  it('recognises an organisation that requires an admin to consent', () => {
    expect(
      isAdminConsentError(
        microsoftError(
          400,
          { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator…' },
          'x',
        ),
      ),
    ).toBe(true);
    expect(
      isAdminConsentError({
        error: 'access_denied',
        error_description: 'AADSTS90094: Admin consent',
      }),
    ).toBe(true);
    expect(isAdminConsentError({ error: 'access_denied' })).toBe(false);
    expect(isAdminConsentError(new MicrosoftApiError(400, 'invalid_grant', 'x'))).toBe(false);
  });
});

describe('Graph', () => {
  it('reads busy times only, never a subject', async () => {
    const { fake, client, email } = await signedIn();
    fake.addOwnEvent(email, {
      start: '2030-01-01T10:00:00Z',
      end: '2030-01-01T11:00:00Z',
      subject: 'Private matter',
    });
    fake.addOwnEvent(email, {
      start: '2030-01-01T10:30:00Z',
      end: '2030-01-01T12:00:00Z',
      showAs: 'tentative',
    });
    fake.addOwnEvent(email, {
      start: '2030-01-01T13:00:00Z',
      end: '2030-01-01T14:00:00Z',
      showAs: 'free',
    });
    const busy = await client.getSchedule({
      address: email,
      from: '2030-01-01T00:00:00Z',
      to: '2030-01-02T00:00:00Z',
    });
    expect(busy).toEqual([{ start: '2030-01-01T10:00:00.000Z', end: '2030-01-01T12:00:00.000Z' }]);
    expect(JSON.stringify(busy)).not.toContain('Private');
  });

  it('writes an event once: a retry whose first answer was lost finds it by its key', async () => {
    const { fake, client, email } = await signedIn();
    const event = {
      key: 'bc0123456789abcdef',
      subject: 'Visit',
      startsAt: '2030-02-01T09:00:00.000Z',
      endsAt: '2030-02-01T10:00:00.000Z',
      timeZone: 'Asia/Kolkata',
    };
    fake.loseNextAnswer((r) => r.method === 'POST');
    await expect(client.upsertEvent(event)).rejects.toBeInstanceOf(MicrosoftApiError);
    const { id } = await client.upsertEvent(event);
    const ours = fake.events(email).filter((e) => !e.deleted);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      id,
      key: event.key,
      timeZone: 'Asia/Kolkata',
      start: event.startsAt,
    });
    const sent = JSON.parse(fake.requests.at(-1)?.body ?? '{}');
    expect(sent.start).toEqual({ dateTime: '2030-02-01T14:30:00', timeZone: 'Asia/Kolkata' });
    expect(sent.singleValueExtendedProperties).toEqual([
      { id: BASECAMP_KEY_PROPERTY, value: event.key },
    ]);
    // Known id: updated in place; gone: made again.
    await client.upsertEvent({ ...event, id, subject: 'Visit (moved)' });
    expect(fake.event(email, id)?.subject).toBe('Visit (moved)');
    await client.deleteEvent(id);
    await client.deleteEvent(id);
    const again = await client.upsertEvent({ ...event, id });
    expect(again.id).not.toBe(id);
    await expect(client.upsertEvent({ ...event, key: "x' or 1" })).rejects.toThrow();
  });

  it('lists changes with a delta query: pages, moves, removals and a lost cursor', async () => {
    const { fake, client, email } = await signedIn();
    for (let i = 0; i < 230; i++)
      fake.addOwnEvent(email, {
        start: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(),
        end: new Date(Date.now() + (i + 2) * 3_600_000).toISOString(),
      });
    const first = await client.changes();
    expect(first.items).toHaveLength(230);
    expect(first.reset).toBe(false);
    expect(JSON.stringify(first.items)).not.toContain('subject');
    const [a, b, c] = fake.events(email);
    const day = (n: number) =>
      new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + n * 86_400_000).toISOString();
    fake.edit(email, a.id, { start: day(10), end: day(10.5) });
    fake.remove(email, b.id);
    // Moved out of the delta's window: Graph reports it removed (decisions B22).
    fake.edit(email, c.id, { start: day(400), end: day(400.5) });
    const next = await client.changes(first.cursor);
    expect(next.items).toEqual([
      { id: a.id, removed: false, startsAt: day(10), endsAt: day(10.5) },
      { id: b.id, removed: true },
      { id: c.id, removed: true },
    ]);
    fake.expireDelta(email);
    const lost = await client.changes(next.cursor);
    expect(lost.reset).toBe(true);
    expect(lost.items).toHaveLength(228);
  });

  it('subscribes after Graph checked the address, and deletes the subscription', async () => {
    const { fake, client } = await signedIn();
    // Nothing answers the handshake here: Graph refuses the subscription.
    await expect(
      client.subscribe({ notificationUrl: 'http://127.0.0.1:9/none', clientState: 'c'.repeat(43) }),
    ).rejects.toMatchObject({ code: 'ValidationError' });
    expect(fake.subscriptions()).toEqual([]);
    await client.unsubscribe('missing');
  });
});

describe('times', () => {
  it("reads Graph's UTC wall times and writes wall times in a zone", () => {
    expect(instantOf({ dateTime: '2030-01-01T10:00:00.0000000', timeZone: 'UTC' })).toBe(
      '2030-01-01T10:00:00.000Z',
    );
    expect(instantOf({ dateTime: '2030-01-01T10:00:00', timeZone: 'India Standard Time' })).toBe(
      null,
    );
    expect(wallTimeIn('2030-07-01T12:00:00.000Z', 'America/New_York')).toBe('2030-07-01T08:00:00');
  });
});

describe('the connector', () => {
  const creds = { clientState: 's'.repeat(43) };
  const req = (body: unknown, query: Record<string, unknown> = {}) => ({
    rawBody: Buffer.from(body === undefined ? '' : JSON.stringify(body)),
    headers: {},
    body,
    query,
  });
  const inbound = microsoftCalendarConnector.inbound;
  if (!inbound) throw new Error('no inbound');

  it('echoes the validation token, and only for a request without a body', () => {
    expect(inbound.handshake?.(req(undefined, { validationToken: 'abc def' }), creds)).toBe(
      'abc def',
    );
    expect(inbound.handshake?.(req({ value: [] }, { validationToken: 'abc' }), creds)).toBeNull();
    expect(validationTokenOf({ validationToken: 'a\nb' })).toBeNull();
    expect(validationTokenOf({ validationToken: 'x'.repeat(1025) })).toBeNull();
  });

  it('verifies every notification by its clientState, and reads one event per subscription', () => {
    const n = (clientState: string, subscriptionId = 'sub-1') => ({
      subscriptionId,
      clientState,
      changeType: 'updated',
      resource: 'Users/1/Events/2',
    });
    expect(inbound.verify(req({ value: [n(creds.clientState)] }), creds)).toBe(true);
    expect(inbound.verify(req({ value: [n(creds.clientState), n('wrong')] }), creds)).toBe(false);
    expect(inbound.verify(req({ value: [] }), creds)).toBe(false);
    expect(inbound.verify(req({ nope: 1 }), creds)).toBe(false);
    const events = inbound.parse(
      req({ value: [n(creds.clientState), n(creds.clientState), n(creds.clientState, 'sub-2')] }),
      creds,
    );
    expect(events.map((e) => e.data)).toEqual([
      { subscriptionId: 'sub-1' },
      { subscriptionId: 'sub-2' },
    ]);
    expect(microsoftCalendarConnector.generate?.().clientState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the live transport', () => {
  it('calls only the Microsoft hosts it was given, over https', async () => {
    const t = guardedTransport({ hosts: ['graph.microsoft.com'] });
    await expect(t({ method: 'GET', url: 'https://evil.example/x' })).rejects.toMatchObject({
      code: 'egress_blocked',
    });
    await expect(
      t({ method: 'GET', url: 'http://graph.microsoft.com/v1.0/me' }),
    ).rejects.toMatchObject({
      code: 'egress_blocked',
    });
  });
});
