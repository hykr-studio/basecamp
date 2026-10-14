import { AGENT_ID } from '@hykr/agents';
import { VOICE_AGENT_ID } from '@hykr/contracts';
import { CoreModule } from '@hykr/core';
import { CqrsModule } from '@nestjs/cqrs';
import { config } from '../config.js';
import { PagesModule } from '../modules/pages/pages.module.js';
import { runtime } from '../runtime.js';
import { sharedDb } from './db.js';
import { DbModule } from './db.module.js';

/**
 * What both processes stand on, the API and the queue worker: the database, the framework
 * (CQRS buses, principals, approvals) and the business's entities and commands.
 */
export const coreImports = () => [
  DbModule,
  CqrsModule.forRoot(),
  CoreModule.forRoot({
    db: sharedDb.db,
    agents: [
      // The assistant: acts through tools; forwards the turn's channel.
      { id: AGENT_ID, key: config.agentApiKey },
      // The voice worker: a relay that starts turns for the person it acts for.
      { id: VOICE_AGENT_ID, key: config.voiceAgentKey, relay: true, channel: 'voice' },
    ],
  }),
  // The application's entities and commands.
  runtime().definition.module,
  // The framework's own entities: saved canvas pages.
  PagesModule,
];
