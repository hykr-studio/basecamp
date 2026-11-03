import type { CommandSpec } from '@hykr/contracts';
import type { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { PostgresStoreVNext } from '@mastra/pg';
import {
  briefForVoice,
  expectedOutcome,
  listBeforeWrite,
  noRetryAfterRefusal,
  repliesInLanguage,
} from '../scorers.js';

/**
 * The application's Mastra instance. Studio talks to it (`basecamp studio`), and the API's
 * chat endpoint uses the same agent, so chats from the app are traced and scored too.
 *
 * Mastra keeps its tables in the `mastra` schema; Drizzle's schemaFilter leaves it alone.
 */
export function createMastra(input: {
  agents: { assistant: Agent; assistantInline: Agent; assistantText: Agent };
  commands: readonly CommandSpec[];
}) {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app';
  return new Mastra({
    // One assistant, one tool set per surface profile.
    agents: input.agents,
    // Registered so their results are saved and shown in Studio.
    scorers: {
      listBeforeWrite: listBeforeWrite(input.commands),
      noRetryAfterRefusal,
      expectedOutcome,
      repliesInLanguage,
      briefForVoice,
    },
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
}
