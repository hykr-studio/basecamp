// Starts Mastra Studio for the to-do agent: http://localhost:4000
//
// The agent's tools call the real API as a real person, so Studio needs a user to act
// for. This signs in (or creates) a demo user through the API and writes that user as a
// request-context preset. Then it starts the Mastra server (scripts/studio-server.ts, on
// 4111) and the Studio UI that talks to it. Start the API first.
//
// `pnpm dev` runs it with --dev: it waits for the API, restarts the Mastra server when the
// agent's code changes, and always exits 0, because under turbo one failed task stops every
// other dev task. If Studio already runs elsewhere (its ports are taken), it steps aside.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';
const demo = { name: 'Studio demo', email: 'studio@example.com', password: 'studio-password' };
const dev = process.argv.includes('--dev');
const exit = (code) => process.exit(dev ? 0 : code);

async function post(path, body) {
  const res = await fetch(`${api}/api/auth${path}`, {
    method: 'POST',
    // Better Auth rejects browser-like requests (Node's fetch) without a trusted Origin.
    headers: { 'content-type': 'application/json', origin: api },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, json: await res.json().catch(() => null) };
}

const taken = (port) =>
  new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

for (const port of [4000, 4111]) {
  if (await taken(port)) {
    console.error(
      `Port ${port} is in use (is Studio already running?), so Studio was not started.`,
    );
    exit(1);
  }
}

const apiUp = () =>
  fetch(`${api}/health`).then(
    (res) => res.ok,
    () => false,
  );

if (!(await apiUp())) {
  if (!dev) {
    console.error(`The API is not running at ${api}. Start it first (see apps/api).`);
    process.exit(1);
  }
  console.log(`Studio is waiting for the API at ${api}.`);
  while (!(await apiUp())) await sleep(1000);
}

await post('/sign-up/email', demo); // fails harmlessly once the user exists
const signIn = await post('/sign-in/email', { email: demo.email, password: demo.password });
if (!signIn.ok) {
  console.error('Could not sign in the Studio demo user:', signIn.json);
  exit(1);
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
    exit(code ?? 0);
  });
const bin = (name) => join(here, '..', 'node_modules', '.bin', name);
const server = ['--env-file=../../.env', 'scripts/studio-server.ts'];
const children = [
  dev
    ? run(bin('tsx'), ['watch', '--clear-screen=false', ...server])
    : run(process.execPath, ['--import', 'tsx', ...server]),
  run(bin('mastra'), ['studio', '--port', '4000', '--request-context-presets', presetsFile]),
];
process.on('SIGINT', () => {
  for (const child of children) child.kill();
});
