import { schema } from '@app/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { config } from '../config.js';
import { sharedDb } from './db.js';

export const auth = betterAuth({
  secret: config.authSecret,
  baseURL: config.authUrl,
  basePath: '/api/auth',
  trustedOrigins: config.webOrigins, // the Expo web origin, for cookies + CORS
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
});
