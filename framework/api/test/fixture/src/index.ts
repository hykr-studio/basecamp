// The fixture application the framework's e2e tests boot: what any application gives the
// server, at its smallest.

import { fileURLToPath } from 'node:url';
import { defineServer } from '@hykr/api';
import { fixtureAgent } from './agent.js';
import { fixtureDomain } from './contracts.js';
import { fixtureNotifications } from './notifications.js';
import { FixtureModule } from './server.js';
import { fixtureViews } from './views.js';

export const fixture = defineServer({
  domain: fixtureDomain,
  module: FixtureModule,
  views: fixtureViews,
  notifications: fixtureNotifications,
  agent: fixtureAgent,
  migrations: [
    {
      folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
      table: '__fixture_migrations',
    },
  ],
});
