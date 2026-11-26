// Before any file boots the app: the framework's tables, then the fixture application's, then
// each fixture feature's own set (src/features/<f>/migrations), in every worker's database (the
// tests' own when there is one worker). vitest.config.ts loads the .env into this process.
export default async function setup() {
  const { migrate } = await import('../dist/index.js');
  const { workerDatabases } = await import('../dist/testing-workers.js');
  const { fixture } = await import('./fixture/dist/index.js');
  const { featureMigrations } = await import('./fixture/dist/migrations.js');
  await workerDatabases(async (url) => {
    process.env.MIGRATE_DATABASE_URL = url; // what migrate() reads
    await migrate(fixture, featureMigrations);
  });
}
