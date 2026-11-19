// Connectors that sign in (B21) as an application uses them: a standard OAuth 2.0 connector (the
// fake provider's account is the one account it reaches, held at once) and Meta's lead ads (pages
// picked after signing in, one shared webhook URL), with a handler that records each lead it
// takes. Both point at the test's fake provider through the deployment's environment
// (`<P>_*_URL`), as a real deployment could point them at a proxy.
// Only the OAuth e2e test boots `oauthApp`.
import { type ConnectorHandler, defineConnectorHandler, defineServer } from '@hykr/api';
import { defineConnector, oauthCredentials } from '@hykr/connectors';
import { LEAD_EVENT, type MetaLead, metaLeads } from '@hykr/connectors/meta-leads';
import type { Contributions } from '@hykr/contracts';
import { z } from 'zod';
import { fixture } from '../../index.js';

const Me = z.object({ id: z.string(), name: z.string() });

/** A standard provider: PKCE, refresh, RFC 7009 revoke, its API's /me naming the account. */
export const fixtureOAuth = defineConnector({
  name: 'fixture-oauth',
  label: { en: 'Fixture sign-in', hi: 'फ़िक्स्चर साइन-इन', te: 'ఫిక్స్చర్ సైన్-ఇన్' },
  credentials: oauthCredentials,
  oauth: {
    authorizeUrl: 'https://oauth.fixture.example/authorize',
    tokenUrl: 'https://oauth.fixture.example/token',
    revokeUrl: 'https://oauth.fixture.example/revoke',
    apiUrl: 'https://oauth.fixture.example/api',
    hosts: ['oauth.fixture.example'],
    scopes: ['read', 'write'],
    clientFrom: 'FIXTURE_OAUTH',
    describe: async (tokens, ctx) => {
      const res = await ctx.http({
        method: 'GET',
        url: ctx.api('/me'),
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      const me = Me.parse(res.body);
      return { public: { account: me.name }, accounts: [{ id: me.id, name: me.name }] };
    },
  },
});

/** What the lead handler took, for the test to read. */
export const leads: { connectionId: string; tenantId: string; lead: MetaLead }[] = [];

export const oauthHandlers: ConnectorHandler[] = [
  defineConnectorHandler({
    name: 'fixture.lead',
    connector: 'meta-leads',
    on: [LEAD_EVENT],
    handle: async (event) => {
      leads.push({
        connectionId: event.connectionId,
        tenantId: event.tenantId,
        lead: event.data as MetaLead,
      });
    },
  }),
];

export const oauthContributions: Partial<Contributions> = {
  connectors: [fixtureOAuth, metaLeads()],
  connectorHandlers: oauthHandlers,
};

/** The fixture, with both connectors. */
export const oauthApp = defineServer({ ...fixture.definition, contributes: oauthContributions });
