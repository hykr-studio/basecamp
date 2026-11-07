// basecamp: run an application on the Basecamp framework (see HELP). The bin is bin/basecamp.js.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dropBranchMigrations } from './db-rebase.js';
import { IMPORT_OPTIONS, IMPORT_USAGE, type ImportFlags, importArgs } from './import-args.js';
import { moduleAdd } from './module-add.js';

/** The "basecamp" block of the application's package.json. */
type Config = {
  /** The module that exports `server` (defineServer(...)), compiled. */
  server: string;
  /** Packages whose `dev` script compiles them in watch mode. */
  watch?: string[];
  /** Expo apps, started with their `dev` script. */
  apps?: string[];
  /**
   * The package with drizzle.config.ts and the application's migrations: the domain, whose
   * src/modules/<name>/ folders are the application's modules.
   */
  db?: string;
  /** The Docker Compose project for `basecamp infra` (default: basecamp). */
  project?: string;
};

const HELP = `basecamp: run an application on the Basecamp framework

  basecamp dev                       compile in watch mode; run the API, worker, voice worker, apps, Studio
  basecamp start api|worker|voice    run one process (production)
  basecamp infra up|down             the local services (Postgres, Redis, WhatsApp emulator, LiveKit…)
  basecamp db migrate                the framework's migrations, then the application's
  basecamp db generate [--name n]    a migration for the modules' tables (one journal)
  basecamp db rebase [--base b] [--name n]
                                     drop this branch's migrations (not on b, default main) and
                                     generate them again on top of b's
  basecamp module add <name> [--entity e]
                                     a new module: both halves and the lines that register it
  basecamp import <entity> <file> --as <email> [--dry-run] [options]
                                     import a CSV, JSON or NDJSON file of records through the
                                     write path, as that member (the worker runs it); rows
                                     imported before (same key, --source) are updated, not
                                     made again; rows not written go to an error report
                                     (--tenant, --key, --format, --existing update|skip,
                                     --empty omit|null, --map col=field, --ref field=entity,
                                     --report path)
  basecamp templates sync|check      WhatsApp templates at the provider
  basecamp operator add <email> [--capabilities a,b]
                                     make an account a platform operator (every operator
                                     capability by default); operator remove <email> disables
                                     one; operator list
  basecamp eval [assistant|voice|whatsapp] [--module m] [--live [--model <provider>/<model>]]
                                     score the assistant (scripted model, or the deployment's
                                     default model, or one model of MODEL_PROVIDERS), every
                                     module's evals or one module's
  basecamp studio                    Mastra Studio for the assistant

Run it anywhere inside an application: the nearest package.json with a "basecamp" block is the
application's root, and the nearest .env at or above it is loaded.`;

const here = dirname(fileURLToPath(import.meta.url));
const ownRequire = createRequire(import.meta.url);

function findRoot(from: string): { root: string; config: Config } {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.basecamp) return { root: dir, config: pkg.basecamp };
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

/**
 * Format what `module add` wrote with the project's Biome, if it has one (the Basecamp repository
 * does; a new application may not), so the new files and lines match its style.
 */
function formatIfBiome(root: string, files: string[]) {
  for (let dir = root; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', 'biome');
    if (existsSync(join(dir, 'biome.json')) && existsSync(bin)) {
      spawnSync(bin, ['check', '--write', ...files.map((f) => resolve(root, f))], {
        cwd: dir,
        stdio: 'ignore',
      });
      return;
    }
    if (dirname(dir) === dir) return;
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
      model: { type: 'string' },
      name: { type: 'string' },
      module: { type: 'string' },
      entity: { type: 'string' },
      capabilities: { type: 'string' },
      base: { type: 'string', default: 'main' },
      help: { type: 'boolean', short: 'h', default: false },
      ...IMPORT_OPTIONS,
    },
  });
  const [command, sub] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const { root, config } = findRoot(process.cwd());
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
      // Mastra Studio (4000), once the API is up; skipped if Studio already runs elsewhere.
      run('studio', process.execPath, ['--watch', runner, 'studio', server], root);
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
      const project = config.project ?? 'basecamp';
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
      if (sub === 'generate' || sub === 'rebase') {
        if (!config.db) fail('set "db" in the basecamp block: the package with drizzle.config.ts');
        const dir = resolve(root, config.db);
        // drizzle-kit's bin sits next to its entry point (its exports hide the file itself).
        const kit = join(
          dirname(createRequire(join(dir, 'package.json')).resolve('drizzle-kit')),
          'bin.cjs',
        );
        let name = values.name;
        if (sub === 'rebase') {
          const { dropped, name: again } = dropBranchMigrations(dir, values.base, values.name);
          if (!dropped.length) {
            console.log(`basecamp: no migrations beyond ${values.base}; nothing to rebase`);
            return;
          }
          console.log(`dropped ${dropped.join(', ')}; generating ${again} on ${values.base}`);
          console.log(
            'A database that applied the dropped migrations must be recreated before db migrate.',
          );
          name = again;
        }
        run('db', process.execPath, [kit, 'generate', ...(name ? ['--name', name] : [])], dir);
        return;
      }
      fail('db migrate, db generate or db rebase');
      break;
    }
    case 'module': {
      const name = positionals[2];
      if (sub !== 'add' || !name) fail('module add <name> [--entity <singular>]');
      if (!config.db) fail('set "db" in the basecamp block: the package the modules live in');
      const app = (config.apps ?? []).find((a) => existsSync(resolve(root, a, 'src', 'app')));
      try {
        const result = moduleAdd({ root, db: config.db, app, name, entity: values.entity });
        for (const file of result.created) console.log(`created     ${file}`);
        for (const file of result.registered) console.log(`registered  ${file}`);
        formatIfBiome(root, [...result.created, ...result.registered]);
        console.log('\nNext:');
        for (const step of result.todo) console.log(`- ${step}`);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    case 'import': {
      let options: ReturnType<typeof importArgs>;
      try {
        options = importArgs(positionals.slice(1), values as ImportFlags);
      } catch (error) {
        fail(error instanceof Error ? error.message : `usage: basecamp ${IMPORT_USAGE}`);
      }
      const { api, server: app } = await loadServer(root, config);
      process.exit(await api.runImport(app, options));
      break;
    }
    case 'templates': {
      if (sub !== 'sync' && sub !== 'check') fail('templates sync or templates check');
      const { api, server: app } = await loadServer(root, config);
      process.exit((await api.runTemplates(app, sub)) ? 0 : 1);
      break;
    }
    case 'operator': {
      if (sub !== 'add' && sub !== 'remove' && sub !== 'list')
        fail('operator add <email> [--capabilities a,b], operator remove <email> or operator list');
      const email = positionals[2];
      if (sub !== 'list' && !email) fail(`operator ${sub} <email>`);
      const { api, server: app } = await loadServer(root, config);
      const capabilities = values.capabilities
        ?.split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      process.exit(
        (await api.operators(app, sub, { email, ...(capabilities ? { capabilities } : {}) }))
          ? 0
          : 1,
      );
      break;
    }
    case 'eval': {
      const suite = sub ?? 'assistant';
      if (!['assistant', 'voice', 'whatsapp'].includes(suite))
        fail('eval assistant, eval voice or eval whatsapp');
      process.env.MODEL_MODE = values.live ? 'live' : 'fake';
      // One registered model for this run: check a model before a business allows it.
      if (values.model) {
        if (!values.live) fail('--model needs --live: the scripted model answers otherwise');
        process.env.AGENT_MODEL = values.model;
      }
      const { api, server: app } = await loadServer(root, config);
      process.exit((await api.runEval(app, suite, { module: values.module })) ? 0 : 1);
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
