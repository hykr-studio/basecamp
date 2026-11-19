// The fixture application the framework's e2e tests boot: what any application gives the
// server, at its smallest, as two modules.

import { fileURLToPath } from 'node:url';
import { defineServer } from '@hykr/api';
import { fixtureLanguages } from './languages.js';
import { tasks, visits } from './modules.js';

export const fixture = defineServer({
  name: 'Fixture',
  persona: 'You are a test assistant. You help the user keep tasks and visits.',
  help: 'I can add or delete tasks.',
  languages: fixtureLanguages,
  modules: [tasks, visits],
  // Its tables are fixture_tasks and fixture_visits, beside the sample application's.
  tablePrefix: 'fixture_',
  migrations: [
    {
      folder: fileURLToPath(new URL('../drizzle', import.meta.url)),
      table: '__fixture_migrations',
    },
  ],
});
