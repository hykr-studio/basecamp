import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { PostgresStoreVNext } from '@mastra/pg';
import { createAssistant } from '../assistant.js';
import { expectedOutcome, listBeforeWrite, noRetryAfterRefusal } from '../scorers.js';

/**
 * The one Mastra instance. Studio talks to it through scripts/studio-server.ts, and the
 * API's chat endpoint uses the same agent, so chats from the app are traced and scored too.
 *
 * Mastra keeps its tables in the `mastra` schema; Drizzle's schemaFilter leaves it alone.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';

export const mastra = new Mastra({
  // One assistant, one tool set per surface profile (see agents.ts).
  agents: {
    assistant: createAssistant('app'),
    assistantInline: createAssistant('inline'),
    assistantText: createAssistant('text'),
  },
  // Registered so their results are saved and shown in Studio.
  scorers: { listBeforeWrite, noRetryAfterRefusal, expectedOutcome },
  // Agent state in `mastra`; traces, logs, metrics and scores in `mastra_obs`, on their
  // own connection pool. Drizzle's schemaFilter leaves both schemas to Mastra.
  storage: new PostgresStoreVNext({
    id: 'mastra',
    connectionString: databaseUrl,
    schemaName: 'mastra',
    observability: {
      connectionString: `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}application_name=mastra_obs`,
      schemaName: 'mastra_obs',
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'assistant',
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
        // Who the agent acted for, and the run, become searchable trace metadata.
        requestContextKeys: ['userId', 'runId'],
        // Store info and above (the default is warn), so tool calls show in Studio → Logs.
        logging: { level: 'info' },
      },
    },
  }),
  logger: new PinoLogger({ name: 'assistant', level: 'info' }),
});
