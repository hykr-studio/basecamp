import { ensureDefaultTenant, schema } from '@app/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config } from '../config.js';
import { sharedDb } from './db.js';
import { nativeAppOrigin } from './native-origin.js';

export const auth = betterAuth({
  secret: config.authSecret,
  baseURL: config.authUrl,
  basePath: '/api/auth',
  // The Expo web origin (cookies + CORS), and the native app's scheme (Expo dev client too).
  trustedOrigins: [
    ...config.webOrigins,
    'agenticstack://',
    ...(process.env.NODE_ENV === 'production' ? [] : ['exp://']),
  ],
  // Native apps keep the session in SecureStore and send it as a header (session.native.ts).
  plugins: [nativeAppOrigin()],
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
  // A new person gets their own business, as its owner: the template works for one person as
  // before, and their records are theirs alone. (The guard does the same if this ever fails.)
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureDefaultTenant(sharedDb.db, user.id, user.name);
        },
      },
    },
  },
});
