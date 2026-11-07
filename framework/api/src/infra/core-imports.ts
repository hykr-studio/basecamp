import { AGENT_ID } from '@hykr/agents';
import { VOICE_AGENT_ID } from '@hykr/contracts';
import { CoreModule } from '@hykr/core';
import { CqrsModule } from '@nestjs/cqrs';
import { config } from '../config.js';
import { PagesModule } from '../modules/pages/pages.module.js';
import { createsBusinessOnSignUp, runtime } from '../runtime.js';
import { sharedDb } from './db.js';
import { DbModule } from './db.module.js';

/**
 * What both processes stand on, the API and the queue worker: the database, the framework
 * (CQRS buses, principals, approvals) and the application modules' entities and commands.
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
    // Stored events carry this process's queue prefix: only its relay passes them on.
    queuePrefix: config.queuePrefix,
    // A business without its own currency counts in the deployment's (DEFAULT_CURRENCY).
    defaultCurrency: config.defaultCurrency,
    // Whether a person without a business gets one of their own (defineServer's signUp).
    createBusinessOnSignUp: createsBusinessOnSignUp(),
  }),
  // Each module's entities and commands, in module order.
  ...runtime().definition.modules.flatMap((m) => (m.server ? [m.server] : [])),
  // The framework's own entities: saved canvas pages.
  PagesModule,
];
