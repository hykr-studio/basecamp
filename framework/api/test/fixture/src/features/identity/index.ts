// Identity as an application extends it (F4): its own role and capability, an agent identity
// provider (a bearer token, as an MCP server would use), and an auth plugin with its origins.
// Only the identity e2e test boots `identity`.
import { type AgentIdentityProvider, defineServer } from '@hykr/api';
import { type Contributions, defineCapability, defineRole } from '@hykr/contracts';
import { UnauthorizedException } from '@nestjs/common';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { fixture } from '../../index.js';

const label = (en: string) => ({ en, hi: en, te: en });

/** An auditor reads the whole business's history and nothing else. */
export const Auditor = defineRole({
  name: 'fixture_auditor',
  label: label('Auditor'),
  capabilities: ['history.all'],
});

/** A capability the fixture owns, given to owners. */
export const Reports = defineCapability({
  name: 'fixture.reports',
  label: label('Read reports'),
  roles: ['owner'],
});

/** The tokens a test hands out: whom each one acts for, and in which business. */
export const fixtureTokens = new Map<
  string,
  { userId: string; tenantId?: string; agentId?: string; runId?: string }
>();

/**
 * `Authorization: Bearer <token>`: an agent acting for the token's person. Not this provider's
 * credential (no bearer header): null. A bearer token it does not know: 401, never a fallback.
 */
export const fixtureBearer: AgentIdentityProvider = {
  name: 'fixture.bearer',
  async identify(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const grant = fixtureTokens.get(header.slice('Bearer '.length));
    if (!grant) throw new UnauthorizedException('fixture.bearer: unknown token');
    return {
      agentId: grant.agentId ?? 'fixture-mcp',
      actingFor: { userId: grant.userId },
      tenantId: grant.tenantId,
      channel: 'mcp',
      runId: grant.runId,
      scopes: ['tasks:read'],
    };
  },
};

/** A Better Auth plugin with one route: GET /api/auth/fixture/ping. */
export const pingPlugin = {
  id: 'fixture-ping',
  endpoints: {
    fixturePing: createAuthEndpoint('/fixture/ping', { method: 'GET' }, async (ctx) =>
      ctx.json({ ok: true }),
    ),
  },
} satisfies BetterAuthPlugin;

export const identityContributions: Partial<Contributions> = {
  roles: [Auditor],
  capabilities: [Reports],
  identityProviders: [fixtureBearer],
  authPlugins: [
    {
      name: 'fixture.partner',
      plugin: pingPlugin,
      trustedOrigins: ['https://partner.example', 'fixturepartner://'],
    },
  ],
};

/** The fixture, plus these. */
export const identity = defineServer({ ...fixture.definition, contributes: identityContributions });
