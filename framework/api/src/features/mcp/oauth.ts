// The OAuth 2.1 authorization server MCP clients sign in with: Better Auth's oauth-provider plugin,
// contributed as an auth plugin. Clients register themselves (RFC 7591), a person signs in and
// consents on the API's own pages, and the client gets an opaque token for the MCP endpoint
// (MCP_URL), limited to the modules the person allowed, in the business they consented in.
import { oauthProvider } from '@better-auth/oauth-provider';
import { moduleScopes } from '@hykr/contracts';
import { ensureDefaultTenant, membershipOf, oauthTables } from '@hykr/db';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { AuthPlugin } from '../../hooks.js';
import { sharedDb } from '../../infra/db.js';
import { runtime } from '../../runtime.js';
import { ACCESS_PREFIX, mcpConfig, REFRESH_PREFIX } from './config.js';

/** Refresh tokens, for a client that stays connected. */
export const OFFLINE_SCOPE = 'offline_access';

/** Every scope a client may ask for: read and write per application module, and refresh. */
export function mcpScopes(): string[] {
  return [OFFLINE_SCOPE, ...moduleScopes(runtime().catalog.modules)];
}

/** The pages the API serves for the flow. */
export const SIGN_IN_PATH = '/oauth/sign-in';
export const CONSENT_PATH = '/oauth/consent';

/**
 * The business a person's token acts in: their default business when they consent. A person
 * without one yet gets one, as the resolver gives them.
 */
async function businessOf(user: { id: string; name?: string | null } | undefined) {
  if (!user?.id) throw new Error('No person to consent');
  const membership =
    (await membershipOf(sharedDb.db, user.id)) ??
    (await ensureDefaultTenant(sharedDb.db, user.id, user.name ?? ''));
  return membership.tenantId;
}

function build(): BetterAuthPlugin {
  const c = mcpConfig();
  return oauthProvider({
    loginPage: `${c.base}${SIGN_IN_PATH}`,
    consentPage: `${c.base}${CONSENT_PATH}`,
    scopes: mcpScopes(),
    // Every token acts for a person: no machine-to-machine grant.
    grantTypes: ['authorization_code', 'refresh_token'],
    // MCP clients register themselves, without an account of their own.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Opaque tokens, stored hashed: revoking one takes effect at the next call.
    disableJwtPlugin: true,
    resources: [{ identifier: c.resource, name: runtime().definition.name }],
    clientRegistrationDefaultResources: [c.resource],
    prefix: { opaqueAccessToken: ACCESS_PREFIX, refreshToken: REFRESH_PREFIX },
    // The business is the server's fact: the person's default one, named on the consent screen.
    postLogin: {
      page: `${c.base}${CONSENT_PATH}`,
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) => businessOf(user),
    },
  }) as unknown as BetterAuthPlugin;
}

let plugin: BetterAuthPlugin | undefined;

/**
 * The contribution. The plugin is built when Better Auth is (after the application is
 * registered), since its scopes are the application's modules.
 */
export const mcpAuthPlugin: AuthPlugin = {
  name: 'mcp.oauth-provider',
  get plugin() {
    plugin ??= build();
    return plugin;
  },
  schema: oauthTables,
};

/** A redirect a native app (RFC 8252) uses: http on a loopback host, or its own scheme. */
function nativeRedirect(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol !== 'https:' && /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(url.protocol);
  } catch {
    return false;
  }
}

/**
 * MCP clients on a person's computer (an IDE, a desktop app) register loopback redirects without
 * saying they are native apps, and the provider then takes them for web clients and refuses the
 * redirect. A registration whose every redirect is a native app's, and which names no
 * application type, is registered as `native` (RFC 8252); anything else is checked as sent.
 */
export const mcpNativeClients: AuthPlugin = {
  name: 'mcp.native-clients',
  plugin: {
    id: 'mcp-native-clients',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/oauth2/register',
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Record<string, unknown> | undefined;
            const uris = body?.redirect_uris;
            if (!body || body.application_type !== undefined || !Array.isArray(uris)) return;
            if (!uris.length || !uris.every(nativeRedirect)) return;
            return { context: { body: { ...body, application_type: 'native' } } };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin,
};
