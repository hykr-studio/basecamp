import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defineConnector, type InboundRequest } from './connector.js';
import { LEAD_EVENT, LEADGEN_EVENT, metaLeads, noticesOf } from './meta-leads/index.js';
import {
  type ConnectorOAuth,
  type OAuthHttp,
  type OAuthRequest,
  oauthAuthorizationUrl,
  oauthCredentials,
  oauthExchangeCode,
  oauthRefresh,
  oauthUrlProblem,
  pkceChallenge,
  tokensOf,
} from './oauth.js';

const label = { en: 'Test', hi: 'परीक्षण', te: 'పరీక్ష' };

const oauth: ConnectorOAuth = {
  authorizeUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  hosts: ['auth.example.com'],
  scopes: ['read', 'write'],
  clientFrom: 'EXAMPLE_APP',
};

describe('an OAuth connector', () => {
  const base = { label, credentials: oauthCredentials };

  it('is defined with https URLs on its hosts', () => {
    expect(defineConnector({ ...base, name: 'signs-in', oauth }).oauth?.scopes).toEqual([
      'read',
      'write',
    ]);
  });

  it('refuses a URL that is not https, or not on a listed host', () => {
    expect(() =>
      defineConnector({
        ...base,
        name: 'plain',
        oauth: { ...oauth, tokenUrl: 'http://auth.example.com/token' },
      }),
    ).toThrow('tokenUrl: http://auth.example.com/token is not https');
    expect(() =>
      defineConnector({
        ...base,
        name: 'elsewhere',
        oauth: { ...oauth, revokeUrl: 'https://other.example.net/revoke' },
      }),
    ).toThrow('not on a listed host');
    expect(() =>
      defineConnector({ ...base, name: 'bad-prefix', oauth: { ...oauth, clientFrom: 'lower' } }),
    ).toThrow('environment prefix');
  });

  it('refuses a shared URL without a sign-in, and inbound with nothing to verify', () => {
    const shared = { verify: () => true, parse: () => [], accountOf: () => 'x' };
    expect(() => defineConnector({ ...base, name: 'shared', inbound: { shared } })).toThrow(
      'declare oauth',
    );
    expect(() => defineConnector({ ...base, name: 'empty', oauth, inbound: {} })).toThrow(
      'verify and parse, or shared',
    );
  });

  it('lets a deployment through on an allowed host, over http too', () => {
    expect(
      oauthUrlProblem('http://127.0.0.1:4000/token', ['auth.example.com'], ['127.0.0.1']),
    ).toBe(null);
    expect(oauthUrlProblem('http://127.0.0.1:4000/token', ['auth.example.com'])).toContain(
      'not https',
    );
  });
});

describe('the OAuth calls', () => {
  const endpoints = { authorize: oauth.authorizeUrl, token: oauth.tokenUrl };
  const client = { clientId: 'client', clientSecret: 'secret' };

  it('builds the consent URL with PKCE', () => {
    const url = new URL(
      oauthAuthorizationUrl({
        oauth: { ...oauth, extraParams: { prompt: 'consent' } },
        endpoints,
        clientId: 'client',
        redirectUri: 'https://api.example.com/cb',
        state: 'st',
        codeChallenge: pkceChallenge('verifier'),
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client',
      response_type: 'code',
      scope: 'read write',
      state: 'st',
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
  });

  it('reads tokens, their expiry and scopes (space or comma separated)', () => {
    const t = tokensOf({ access_token: 'a', expires_in: 3600, scope: 'read,write' }, 1000);
    expect(t).toEqual({ accessToken: 'a', expiresAt: 1000 + 3_600_000, scopes: ['read', 'write'] });
    expect(() => tokensOf({})).toThrow('no access token');
  });

  it('exchanges a code and refreshes, carrying the refresh token on', async () => {
    const sent: OAuthRequest[] = [];
    const http: OAuthHttp = async (req) => {
      sent.push(req);
      const grant = new URLSearchParams(req.body).get('grant_type');
      return grant === 'authorization_code'
        ? { status: 200, body: { access_token: 'a1', refresh_token: 'r1', expires_in: 60 } }
        : { status: 200, body: { access_token: 'a2', expires_in: 60 } };
    };
    const first = await oauthExchangeCode(http, {
      endpoints,
      client,
      code: 'c',
      redirectUri: 'https://api.example.com/cb',
      codeVerifier: 'v',
    });
    expect(first.refreshToken).toBe('r1');
    expect(new URLSearchParams(sent[0].body).get('code_verifier')).toBe('v');
    const next = await oauthRefresh(http, { endpoints, client, refreshToken: 'r1' });
    expect(next).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
  });

  it('says invalid_grant as the provider does', async () => {
    const http: OAuthHttp = async () => ({ status: 400, body: { error: 'invalid_grant' } });
    await expect(
      oauthRefresh(http, { endpoints, client, refreshToken: 'r' }),
    ).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_grant', status: 400 });
  });
});

describe('meta-leads', () => {
  const connector = metaLeads();
  const shared = connector.inbound?.shared;
  const app = {
    clientId: 'id',
    clientSecret: 'app-secret',
    setting: (n: string) => (n === 'VERIFY_TOKEN' ? 'verify-me' : undefined),
  };
  const body = {
    object: 'page',
    entry: [
      {
        id: '111',
        time: 1,
        changes: [
          {
            field: 'leadgen',
            value: { leadgen_id: '999', page_id: '111', form_id: '5', created_time: 1700000000 },
          },
          { field: 'feed', value: {} },
        ],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const req = (signature?: string): InboundRequest => ({
    rawBody: raw,
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body,
    query: {},
  });
  const sign = (secret: string) =>
    `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('is a valid OAuth connector on Meta hosts with a shared URL', () => {
    expect(connector.name).toBe('meta-leads');
    expect(connector.oauth?.refresh).toBe(false);
    expect(shared).toBeDefined();
  });

  it('verifies the app-secret signature, once', () => {
    expect(shared?.verify(req(sign('app-secret')), app)).toBe(true);
    expect(shared?.verify(req(sign('another')), app)).toBe(false);
    expect(shared?.verify(req(), app)).toBe(false);
  });

  it('reads the leadgen notices and the page each is for', () => {
    const events = shared?.parse(req(), app) ?? [];
    expect(events).toEqual([
      {
        id: '999',
        type: LEADGEN_EVENT,
        data: { leadId: '999', pageId: '111', form: '5', ad: null, createdTime: 1700000000 },
      },
    ]);
    expect(shared?.accountOf(events[0])).toBe('111');
    expect(() => noticesOf({ entry: [{ changes: [{ field: 'leadgen', value: {} }] }] })).toThrow(
      'names no lead',
    );
  });

  it('answers the subscription check only with the verify token', () => {
    const q = (query: Record<string, string>): InboundRequest => ({ ...req(), query });
    const ok = { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' };
    expect(shared?.challenge?.(q(ok), app)).toBe('42');
    expect(shared?.challenge?.(q({ ...ok, 'hub.verify_token': 'no' }), app)).toBe(null);
  });

  it('expands a notice into the lead, with the page token', async () => {
    const calls: unknown[] = [];
    const expanded = await connector.inbound?.expand?.(
      { id: '999', type: LEADGEN_EVENT, data: noticesOf(body)[0] },
      {
        account: '111',
        call: async (init) => {
          calls.push(init);
          return {
            status: 200,
            body: {
              id: '999',
              created_time: '2026-11-18T10:00:00+0000',
              form_id: '5',
              ad_id: '7',
              field_data: [{ name: 'full_name', values: ['Asha Rao'] }],
            },
          };
        },
      },
    );
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        account: '111',
        url: expect.stringContaining('/999?'),
      }),
    ]);
    expect(expanded).toEqual({
      id: '999',
      type: LEAD_EVENT,
      data: {
        leadId: '999',
        pageId: '111',
        form: '5',
        ad: '7',
        fields: [{ name: 'full_name', values: ['Asha Rao'] }],
        createdAt: '2026-11-18T10:00:00.000Z',
      },
    });
  });

  it('counts Meta error 190 as a token Meta no longer takes', () => {
    expect(connector.oauth?.isAuthError?.({ status: 400, body: { error: { code: 190 } } })).toBe(
      true,
    );
    expect(connector.oauth?.isAuthError?.({ status: 400, body: { error: { code: 100 } } })).toBe(
      false,
    );
  });
});
