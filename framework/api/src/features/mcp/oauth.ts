// The OAuth 2.1 authorization server MCP clients sign in with: Better Auth's oauth-provider plugin,
// contributed as an auth plugin. Clients register themselves (RFC 7591), a person signs in and
// consents on the API's own pages, and the client gets an opaque token for the MCP endpoint
// (MCP_URL), limited to the modules the person allowed, in the business they consented in.
import { oauthProvider } from '@better-auth/oauth-provider';
import { moduleScopes, parseScope, scopeOf } from '@hykr/contracts';
import {
  ensureDefaultTenant,
  latestParticipation,
  membershipOf,
  oauthClient,
  oauthTables,
} from '@hykr/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { AuthPlugin } from '../../hooks.js';
import { sharedDb } from '../../infra/db.js';
import { createsBusinessOnSignUp, runtime } from '../../runtime.js';
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
 * The business a person's token acts in, as the API's resolver picks one for them when none is
 * named: their default business, else the one they most recently became a participant in. A
 * person in none gets their own, as on sign-up, unless the application gives none
 * (`signUp.createBusiness: false`): then none, and they cannot connect a client. `create: false`
 * only looks (the consent screen naming it).
 */
export async function businessOf(
  userId: string,
  opts: { name?: string; create: boolean },
): Promise<string | undefined> {
  const membership = await membershipOf(sharedDb.db, userId);
  if (membership) return membership.tenantId;
  const participating = await latestParticipation(sharedDb.db, userId);
  if (participating) return participating;
  if (!opts.create || !createsBusinessOnSignUp()) return undefined;
  return (await ensureDefaultTenant(sharedDb.db, userId, opts.name ?? '')).tenantId;
}

/** The business a consent is given in (Better Auth's referenceId): never none. */
async function consentBusiness(user: { id: string; name?: string | null } | undefined) {
  if (!user?.id) throw new APIError('UNAUTHORIZED', { message: 'No person to consent' });
  const tenantId = await businessOf(user.id, { name: user.name ?? '', create: true });
  if (!tenantId)
    throw new APIError('FORBIDDEN', { message: 'You are in no business to connect a client in' });
  return tenantId;
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
    // The business is the server's fact (`businessOf`), named on the consent screen.
    postLogin: {
      page: `${c.base}${CONSENT_PATH}`,
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) => consentBusiness(user),
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
            // Only what changes: another plugin's hook may change the body too.
            return { context: { body: { application_type: 'native' } } };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin,
};

/**
 * A scope list with each module's read next to its write (`tasks:write` → `tasks:read
 * tasks:write`). Write covers read, so this asks for nothing more; it lets the person allow only
 * reading, since the provider accepts a consent only to scopes literally asked for. `allowed`
 * keeps a read out (a client registered without it).
 */
export function withReads(scope: string, allowed: (s: string) => boolean = () => true): string {
  const asked = scope.split(' ').filter(Boolean);
  const out: string[] = [];
  for (const s of asked) {
    const parsed = parseScope(s);
    const read = parsed?.access === 'write' ? scopeOf(parsed.module, 'read') : undefined;
    if (read && !out.includes(read) && (asked.includes(read) || allowed(read))) out.push(read);
    if (!out.includes(s)) out.push(s);
  }
  return out.join(' ');
}

/** The scopes a client registered (null: every scope the server has). */
async function registeredScopes(clientId: unknown): Promise<string[] | null> {
  if (typeof clientId !== 'string' || !clientId) return null;
  const [row] = await sharedDb.db
    .select({ scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row?.scopes?.length ? row.scopes : null;
}

/**
 * A client that asks a person to let it change a module asks to read it too, so the consent
 * screen can offer reading alone (A1 decision 15). A read is added only where the client's
 * registration allows it, or the provider would refuse the whole request: a dynamic registration
 * holds every scope (the provider stores them all, whatever the client asked), but a client the
 * server registered itself may hold fewer.
 */
export const mcpScopeReads: AuthPlugin = {
  name: 'mcp.scope-reads',
  plugin: {
    id: 'mcp-scope-reads',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            // A browser's GET carries the request in the query; a POST to authorize, in the body.
            const post = ctx.method === 'POST';
            const source = (post ? ctx.body : ctx.query) as Record<string, unknown> | undefined;
            const scope = source?.scope;
            if (typeof scope !== 'string') return;
            const registered = await registeredScopes(source?.client_id);
            const expanded = withReads(scope, (s) => !registered || registered.includes(s));
            if (expanded === scope) return;
            return {
              context: post ? { body: { scope: expanded } } : { query: { scope: expanded } },
            };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin,
};
