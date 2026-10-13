// Mastra Studio for an application's assistant (`basecamp studio`): http://localhost:4000
//
// The agent's tools call the real API as a real person, so Studio needs a user to act for.
// This signs in (or creates) a demo user through the API and writes that user as a
// request-context preset. Then it serves the Mastra instance over HTTP (on 4111) and starts
// the Studio UI that talks to it. Start the API first.
//
// `basecamp dev` runs it with `dev: true`: it waits for the API, and if Studio already runs
// elsewhere (its ports are taken), it steps aside instead of failing.
//
// `mastra dev` is not used: it bundles the project first, and its bundler resolves scoped
// workspace packages against the wrong package.json. Serving the instance directly with the
// Hono adapter avoids the bundler entirely.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Agents } from './agents.js';

const demo = { name: 'Studio demo', email: 'studio@example.com', password: 'studio-password' };

const taken = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/**
 * Starts Studio for the assistant; resolves false when it stepped aside (dev mode: its ports
 * are taken, or the demo user could not sign in).
 */
export async function startStudio(
  agents: Agents,
  options: { dir: string; dev?: boolean },
): Promise<boolean> {
  const port = Number(process.env.MASTRA_PORT ?? 4111);
  for (const p of [4000, port]) {
    if (await taken(p)) {
      const why = `Port ${p} is in use (is Studio already running?), so Studio was not started.`;
      if (!options.dev) throw new Error(why);
      console.log(why);
      return false;
    }
  }
  const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${api}/api/auth${path}`, {
      method: 'POST',
      // Better Auth rejects browser-like requests (Node's fetch) without a trusted Origin.
      headers: { 'content-type': 'application/json', origin: api },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, json: (await res.json().catch(() => null)) as { user: { id: string } } };
  };

  const apiUp = () =>
    fetch(`${api}/health`).then(
      (res) => res.ok,
      () => false,
    );
  if (!(await apiUp())) {
    if (!options.dev)
      throw new Error(`The API is not running at ${api}. Start it first (basecamp dev).`);
    console.log(`Studio is waiting for the API at ${api}.`);
    while (!(await apiUp())) await sleep(1000);
  }
  await post('/sign-up/email', demo); // fails harmlessly once the user exists
  const signIn = await post('/sign-in/email', { email: demo.email, password: demo.password });
  if (!signIn.ok) {
    const why = `Could not sign in the Studio demo user: ${JSON.stringify(signIn.json)}`;
    if (!options.dev) throw new Error(why);
    console.log(why);
    return false;
  }

  const presetsFile = join(options.dir, '.studio', 'presets.json');
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

  // The Mastra server for Studio, in this process.
  const studioOrigin = process.env.STUDIO_ORIGIN ?? 'http://localhost:4000';
  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
  app.use('*', cors({ origin: studioOrigin, credentials: true }));
  await new MastraServer({ app, mastra: agents.mastra }).init();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Mastra server for Studio on http://localhost:${info.port}`);
  });

  // The Studio UI.
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('mastra/package.json')), 'dist', 'index.js');
  const ui = spawn(
    process.execPath,
    [cli, 'studio', '--port', '4000', '--request-context-presets', presetsFile],
    { cwd: options.dir, stdio: 'inherit' },
  );
  ui.on('exit', (code) => process.exit(options.dev ? 0 : (code ?? 0)));
  // Stopped (Ctrl-C, or node --watch restarting on a change): the UI goes too, freeing its port.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      ui.kill();
      process.exit(0);
    });
  return true;
}
