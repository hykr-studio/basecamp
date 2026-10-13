import 'reflect-metadata';
import { type Basecamp, setRuntime } from './runtime.js';

// The server's configuration is read from the environment when a function here runs, not
// when this module loads: tests and the CLI set the environment first.
const loadConfig = () => import('./config.js');

/** The HTTP API: REST, chat, voice sessions, the WhatsApp webhook and the back office API. */
export async function startApi(app: Basecamp) {
  const { assertConfig, config } = await loadConfig();
  // Check secrets before anything else loads: auth.ts builds Better Auth on import.
  assertConfig();
  setRuntime(app);
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  // Better Auth reads the raw body; the auth module adds parsing back for other routes.
  const nest = await NestFactory.create(AppModule, { bodyParser: false });
  nest.enableCors({ origin: config.webOrigins, credentials: true });
  const { mountBullBoard } = await import('./channels/admin/bull-board.js');
  mountBullBoard(nest);
  nest.enableShutdownHooks();
  await nest.listen(config.port);
  return nest;
}

/** The queue worker: runs the channel's jobs. Same checks as the API. */
export async function startWorker(app: Basecamp) {
  const { assertConfig } = await loadConfig();
  assertConfig();
  setRuntime(app);
  const { NestFactory } = await import('@nestjs/core');
  const { WorkerModule } = await import('./worker.module.js');
  const worker = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  worker.enableShutdownHooks();
  console.log('worker: processing the channel queues');
  return worker;
}

/**
 * `sync`: create missing templates at the provider and record their status.
 * `check`: fail unless every template a notification uses is approved.
 * The provider is whatever WA_GRAPH_URL points at: whaloc locally and in CI, Meta in deploys.
 * Returns whether it succeeded.
 */
export async function runTemplates(app: Basecamp, command: 'sync' | 'check'): Promise<boolean> {
  setRuntime(app);
  const { config } = await loadConfig();
  const { createWhatsAppAdapter } = await import('@hykr/channels');
  const { sharedDb } = await import('./infra/db.js');
  const { TemplateSync } = await import('./channels/templates/template-sync.js');
  const sync = new TemplateSync(
    sharedDb.db,
    createWhatsAppAdapter({
      graphUrl: config.whatsapp.graphUrl,
      apiVersion: config.whatsapp.apiVersion,
      accessToken: config.whatsapp.accessToken,
      appSecret: config.whatsapp.appSecret,
      wabaId: config.whatsapp.wabaId,
    }),
    config.appUrl,
  );
  let failed = false;
  try {
    if (command === 'sync') {
      const report = await sync.run({ create: true });
      for (const t of report.created) console.log(`created   ${t} (pending review)`);
      for (const s of report.statuses)
        console.log(
          `${s.status.toLowerCase().padEnd(9)} ${s.template}${s.reason ? `: ${s.reason}` : ''}`,
        );
      for (const e of report.errors) console.error(`error     ${e}`);
      failed = report.errors.length > 0;
    } else {
      await sync.run({ create: false });
      const problems = await sync.check();
      for (const p of problems) console.error(`not ready ${p}`);
      if (!problems.length) console.log('every template a notification uses is approved');
      failed = problems.length > 0;
    }
  } finally {
    await sharedDb.pool.end();
  }
  return !failed;
}

/**
 * Apply the framework's migrations, then the application's (MIGRATE_DATABASE_URL, falling back
 * to DATABASE_URL): `basecamp db migrate`.
 */
export async function migrate(app: Basecamp) {
  const { config } = await loadConfig();
  const { runMigrations } = await import('@hykr/db');
  await runMigrations(
    process.env.MIGRATE_DATABASE_URL ?? config.databaseUrl,
    app.definition.migrations ?? [],
  );
}

/** The assistant's eval suites, against the running API (`basecamp eval`). */
export async function runEval(
  app: Basecamp,
  suite: 'assistant' | 'voice' | 'whatsapp',
): Promise<boolean> {
  setRuntime(app);
  const evals = await import('@hykr/agents/evals');
  const run = {
    assistant: evals.evalAssistant,
    voice: evals.evalVoice,
    whatsapp: evals.evalWhatsapp,
  };
  return run[suite](app.agents);
}

/**
 * Mastra Studio for the application's assistant (`basecamp studio`); `dir` keeps its presets.
 * With `dev`, it waits for the API and steps aside if Studio already runs (`basecamp dev`).
 */
export async function startStudio(app: Basecamp, dir: string, options: { dev?: boolean } = {}) {
  setRuntime(app);
  const { startStudio } = await import('@hykr/agents/studio');
  return startStudio(app.agents, { dir, dev: options.dev });
}
