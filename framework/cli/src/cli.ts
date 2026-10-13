#!/usr/bin/env node
// basecamp: run an application on the Basecamp framework (see HELP).
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The "basecamp" block of the application's package.json. */
type Config = {
  /** The module that exports `server` (defineServer(...)), compiled. */
  server: string;
  /** Packages whose `dev` script compiles them in watch mode. */
  watch?: string[];
  /** Expo apps, started with their `dev` script. */
  apps?: string[];
  /** The package with drizzle.config.ts and the application's migrations. */
  db?: string;
};

const HELP = `basecamp: run an application on the Basecamp framework

  basecamp dev                       compile in watch mode; run the API, worker, voice worker and apps
  basecamp start api|worker|voice    run one process (production)
  basecamp infra up|down             the local services (Postgres, Redis, WhatsApp emulator, LiveKit…)
  basecamp db migrate                the framework's migrations, then the application's
  basecamp db generate [--name n]    a migration for the application's own tables
  basecamp templates sync|check      WhatsApp templates at the provider
  basecamp eval [assistant|voice|whatsapp] [--live]
                                     score the assistant (scripted model, or your AGENT_MODEL)
  basecamp studio                    Mastra Studio for the assistant

Run it anywhere inside an application: the nearest package.json with a "basecamp" block is the
application's root, and the nearest .env at or above it is loaded.`;

const here = dirname(fileURLToPath(import.meta.url));
const ownRequire = createRequire(import.meta.url);

function findRoot(from: string): { root: string; config: Config; name: string } {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.basecamp) return { root: dir, config: pkg.basecamp, name: pkg.name ?? 'basecamp' };
    }
    if (dirname(dir) === dir)
      fail(
        'No Basecamp application here: no package.json with a "basecamp" block above this folder.',
      );
  }
}

function loadEnv(root: string) {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      // Values already set (CI, the shell) win, as with node --env-file.
      process.loadEnvFile(file);
      return;
    }
    if (dirname(dir) === dir) return;
  }
}

function fail(message: string): never {
  console.error(`basecamp: ${message}`);
  process.exit(1);
}

/** The application's server definition, with the @hykr/api it was built against. */
async function loadServer(root: string, config: Config) {
  const file = resolve(root, config.server);
  if (!existsSync(file)) fail(`${config.server} is missing: build the application first.`);
  // The application's own copy of @hykr/api: the one its server definition registers with.
  const api = await import(pathToFileURL(createRequire(file).resolve('@hykr/api')).href);
  const { server } = await import(pathToFileURL(file).href);
  if (!server) fail(`${config.server} does not export \`server\` (defineServer(...)).`);
  return { api, server };
}

/** The package manager the application uses, from its lockfile. */
function packageManager(root: string): string {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(dir, 'bun.lock'))) return 'bun';
    if (existsSync(join(dir, 'package-lock.json')) || dirname(dir) === dir) return 'npm';
  }
}

const COLORS = [36, 35, 33, 32, 34, 31, 96, 95];
const children: ChildProcess[] = [];
let running = 0;

/**
 * Run a process with its output prefixed by name. One that stops is reported and the others
 * keep going (a voice worker without LiveKit keys shouldn't stop the API); when the last one
 * stops, so does basecamp.
 */
function run(name: string, command: string, args: string[], cwd: string) {
  const color = COLORS[children.length % COLORS.length];
  const tag = `\x1b[${color}m${name.padEnd(12)}\x1b[0m│ `;
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk: Buffer, out: NodeJS.WriteStream) => {
    for (const line of chunk.toString().split('\n')) if (line) out.write(`${tag}${line}\n`);
  };
  child.stdout?.on('data', (c) => prefix(c, process.stdout));
  child.stderr?.on('data', (c) => prefix(c, process.stderr));
  child.on('exit', (code) => {
    console.log(`${tag}exited (${code ?? 'signal'})`);
    running--;
    if (running === 0) stopAll(code ?? 1);
  });
  running++;
  children.push(child);
}

let stopping = false;
function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

const voiceWorker = () =>
  join(dirname(ownRequire.resolve('@hykr/voice-worker/package.json')), 'dist', 'main.js');

/** Runs the API or the worker for the application (a child of `basecamp dev` / `start`). */
const runner = join(here, 'run.js');

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      live: { type: 'boolean', default: false },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, sub] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const { root, config, name } = findRoot(process.cwd());
  loadEnv(root);
  const pm = packageManager(root);
  const server = resolve(root, config.server);

  switch (command) {
    case 'dev': {
      for (const pkg of config.watch ?? []) run(pkg, pm, ['run', 'dev'], resolve(root, pkg));
      // node --watch restarts when any module the process loaded changes (the compiled server,
      // the domain, the framework).
      run('api', process.execPath, ['--watch', runner, 'api', server], root);
      run('worker', process.execPath, ['--watch', runner, 'worker', server], root);
      run('voice', process.execPath, [voiceWorker(), 'dev'], root);
      for (const app of config.apps ?? []) run(app, pm, ['run', 'dev'], resolve(root, app));
      return;
    }
    case 'start': {
      if (sub === 'api' || sub === 'worker') {
        const { api, server: app } = await loadServer(root, config);
        await (sub === 'api' ? api.startApi(app) : api.startWorker(app));
        return;
      }
      if (sub === 'voice') {
        run('voice', process.execPath, [voiceWorker(), 'start'], root);
        return;
      }
      fail('start what? api, worker or voice');
      break;
    }
    case 'infra': {
      if (sub !== 'up' && sub !== 'down') fail('infra up or infra down');
      const compose = join(here, '..', 'compose.yaml');
      const project = name
        .replace(/^@/, '')
        .replace(/[^a-z0-9_-]/gi, '-')
        .toLowerCase();
      const args = [
        'compose',
        '-f',
        compose,
        '-p',
        project,
        ...(sub === 'up' ? ['up', '-d'] : ['down']),
      ];
      run('infra', 'docker', args, root);
      return;
    }
    case 'db': {
      if (sub === 'migrate') {
        const { api, server: app } = await loadServer(root, config);
        await api.migrate(app);
        console.log('migrations applied');
        process.exit(0);
      }
      if (sub === 'generate') {
        if (!config.db) fail('set "db" in the basecamp block: the package with drizzle.config.ts');
        const dir = resolve(root, config.db);
        // drizzle-kit's bin sits next to its entry point (its exports hide the file itself).
        const kit = join(
          dirname(createRequire(join(dir, 'package.json')).resolve('drizzle-kit')),
          'bin.cjs',
        );
        run(
          'db',
          process.execPath,
          [kit, 'generate', ...(values.name ? ['--name', values.name] : [])],
          dir,
        );
        return;
      }
      fail('db migrate or db generate');
      break;
    }
    case 'templates': {
      if (sub !== 'sync' && sub !== 'check') fail('templates sync or templates check');
      const { api, server: app } = await loadServer(root, config);
      process.exit((await api.runTemplates(app, sub)) ? 0 : 1);
      break;
    }
    case 'eval': {
      const suite = sub ?? 'assistant';
      if (!['assistant', 'voice', 'whatsapp'].includes(suite))
        fail('eval assistant, eval voice or eval whatsapp');
      process.env.MODEL_MODE = values.live ? 'live' : 'fake';
      const { api, server: app } = await loadServer(root, config);
      process.exit((await api.runEval(app, suite)) ? 0 : 1);
      break;
    }
    case 'studio': {
      const { api, server: app } = await loadServer(root, config);
      await api.startStudio(app, root);
      return;
    }
    default:
      fail(`unknown command ${command} (basecamp --help)`);
  }
}

await main();
