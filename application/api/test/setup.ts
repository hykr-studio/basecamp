// Before any file boots the app: the framework's and the application's migrations, in every
// worker's database (the tests' own when there is one worker). vitest.config.ts loads the .env
// into this process.
import { migrate } from '@hykr/api';
import { workerDatabases } from '@hykr/api/testing/workers';

export default async function setup() {
  const { server } = await import('../dist/server.js');
  await workerDatabases(async (url) => {
    process.env.MIGRATE_DATABASE_URL = url; // what migrate() reads
    await migrate(server);
  });
}
