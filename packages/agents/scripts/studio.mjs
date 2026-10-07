// Starts Mastra Studio for the to-do agent: http://localhost:4000
//
// The agent's tools call the real API as a real person, so Studio needs a user to act
// for. This signs in (or creates) a demo user through the API and writes that user as a
// request-context preset. Then it starts the Mastra server (scripts/studio-server.ts, on
// 4111) and the Studio UI that talks to it. Start the API first.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';
const demo = { name: 'Studio demo', email: 'studio@example.com', password: 'studio-password' };

async function post(path, body) {
  const res = await fetch(`${api}/api/auth${path}`, {
    method: 'POST',
    // Better Auth rejects browser-like requests (Node's fetch) without a trusted Origin.
    headers: { 'content-type': 'application/json', origin: api },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, json: await res.json().catch(() => null) };
}

try {
  await fetch(`${api}/health`);
} catch {
  console.error(`The API is not running at ${api}. Start it first (see apps/api).`);
  process.exit(1);
}

await post('/sign-up/email', demo); // fails harmlessly once the user exists
const signIn = await post('/sign-in/email', { email: demo.email, password: demo.password });
if (!signIn.ok) {
  console.error('Could not sign in the Studio demo user:', signIn.json);
  process.exit(1);
}

const presetsFile = join(here, '..', '.studio', 'presets.json');
mkdirSync(dirname(presetsFile), { recursive: true });
writeFileSync(
  presetsFile,
  JSON.stringify(
    {
      [`${demo.name} (${demo.email})`]: { userId: signIn.json.user.id },
      'No user (tools should refuse)': {},
    },
    null,
    2,
  ),
);
console.log(`Studio acts for ${demo.email}. Pick that preset under Request Context.`);
console.log(`Sign in to the web app as ${demo.email} / ${demo.password} to see the same list.\n`);

const run = (cmd, args) =>
  spawn(cmd, args, { cwd: join(here, '..'), stdio: 'inherit' }).on('exit', (code) => {
    for (const child of children) child.kill();
    process.exit(code ?? 0);
  });
const bin = (name) => join(here, '..', 'node_modules', '.bin', name);
const children = [
  run(process.execPath, ['--env-file=../../.env', '--import', 'tsx', 'scripts/studio-server.ts']),
  run(bin('mastra'), ['studio', '--port', '4000', '--request-context-presets', presetsFile]),
];
process.on('SIGINT', () => {
  for (const child of children) child.kill();
});
