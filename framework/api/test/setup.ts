// Before any file boots the app: the framework's tables, then the fixture application's.
export default async function setup() {
  const { migrate } = await import('../dist/index.js');
  const { fixture } = await import('./fixture/dist/index.js');
  await migrate(fixture);
}
