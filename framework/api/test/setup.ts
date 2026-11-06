// Before any file boots the app: the framework's tables, then the fixture application's, then
// each fixture feature's own set (src/features/<f>/migrations). The database is the tests' own:
// vitest.config.ts loads the .env into this process.
export default async function setup() {
  const { migrate } = await import('../dist/index.js');
  const { fixture } = await import('./fixture/dist/index.js');
  const { featureMigrations } = await import('./fixture/dist/migrations.js');
  await migrate(fixture, featureMigrations);
}
