import { ensureDefaultTenant, schema } from '@hykr/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config } from '../config.js';
import { authPlugins } from '../hooks.js';
import { createsBusinessOnSignUp, runtime } from '../runtime.js';
import { sharedDb } from './db.js';
import { nativeAppOrigin } from './native-origin.js';

/** The native app's scheme (and the Expo dev client's, outside production). */
const appSchemes = () => [
  'agenticstack://',
  ...(process.env.NODE_ENV === 'production' ? [] : ['exp://']),
];

/**
 * One trusted origin, exactly: `https://host[:port]` (a browser's origin) or `myapp://` (a
 * native app's scheme). No wildcards, paths or `*`: a loose origin would let another site call
 * the API with someone's cookies.
 */
export function checkOrigin(origin: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/$/.test(origin) && !/^https?:/.test(origin)) return origin;
  let url: URL | undefined;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== origin || origin.includes('*'))
    throw new Error(`"${origin}" is not an exact origin (https://host[:port] or app://)`);
  return origin;
}

/** The origins auth plugins add, checked. */
const pluginOrigins = () =>
  authPlugins.all().flatMap((p) => (p.trustedOrigins ?? []).map(checkOrigin));

/** Browser origins that may call the API with cookies (CORS): WEB_ORIGINS and the plugins' web ones. */
export function corsOrigins(): string[] {
  const web = pluginOrigins().filter((o) => /^https?:\/\//.test(o));
  return [...new Set([...config.webOrigins, ...web])];
}

/** Every origin Better Auth trusts: the web origins, the app schemes and the plugins' schemes. */
export function trustedOrigins(): string[] {
  return [...new Set([...corsOrigins(), ...appSchemes(), ...pluginOrigins()])];
}

function createAuth() {
  return betterAuth({
    secret: config.authSecret,
    baseURL: config.authUrl,
    basePath: '/api/auth',
    // The Expo web origin (cookies + CORS), the native app's scheme (Expo dev client too), and
    // whatever the application's auth plugins add.
    trustedOrigins: trustedOrigins(),
    // Native apps keep the session in SecureStore and send it as a header (session.native.ts).
    // Then each contributed plugin (an OAuth provider for MCP, a phone sign-in), in order.
    plugins: [nativeAppOrigin(), ...authPlugins.all().flatMap((p) => (p.plugin ? [p.plugin] : []))],
    database: drizzleAdapter(sharedDb.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    // A new person gets their own business, as its creator: the template works for one person
    // as before, and their records are theirs alone. (The guard does the same if this ever
    // fails.) Unless the application gives none on sign-up (`signUp.createBusiness: false`): then
    // they are in no business until they are invited, or made a participant somewhere.
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (createsBusinessOnSignUp())
              await ensureDefaultTenant(sharedDb.db, user.id, user.name);
          },
        },
      },
    },
  });
}

let built: ReturnType<typeof createAuth> | undefined;

/**
 * Better Auth for this process, built on first use: after the application is registered, so
 * its auth plugins and origins (`authPlugins`) are in. Building it earlier is a mistake and
 * throws, instead of quietly leaving the plugins out.
 */
export function getAuth() {
  runtime();
  built ??= createAuth();
  return built;
}
