#!/usr/bin/env node
// The basecamp command. The CLI itself is compiled (dist/); in a checkout of the Basecamp
// repository it exists only after a build, so say that instead of a stack trace.
const cli = new URL('../dist/cli.js', import.meta.url);
try {
  await import(cli.href);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(cli.pathname)) {
    console.error('basecamp is not built yet: run "pnpm build" at the repository root first.');
    process.exit(1);
  }
  throw error;
}
