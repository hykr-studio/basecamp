// The Basecamp server, as a library: an application defines itself once (defineServer) and
// starts the API, the queue worker or the templates CLI with it. Nothing exported here reads the
// environment when it loads.

export { envelopeOf } from './features/events/envelope.js';
export { defineSubscriber, EVENTS_QUEUE, matchesEvent } from './features/events/subscriber.js';
export { defineFeature, type FeatureDef } from './features/feature.js';
export {
  type AgentIdentity,
  type AgentIdentityProvider,
  type AuthPlugin,
  authPlugins,
  type DataSubject,
  type DeliveryChannel,
  type DeliveryOutcome,
  type DeliveryRequest,
  deliveryChannels,
  type EntityPlugin,
  type ErasureContributor,
  type EventFeed,
  type ExportContributor,
  entityPlugins,
  erasureContributors,
  eventFeeds,
  exportContributors,
  type InboundDecision,
  type InboundHook,
  type InboundInfo,
  identityProviders,
  inboundHooks,
  type Jobs,
  type NotificationMeta,
  projectRead,
  type QueueDef,
  queues,
  type ReadProjector,
  readProjectors,
  type ScheduleDef,
  type ServerContext,
  type Subscriber,
  schedules,
  subscribers,
  type ToolContribution,
  type TurnGate,
  type TurnHook,
  type TurnInfo,
  type TurnOutcome,
  type TurnRefusal,
  toolContributions,
  turnHooks,
  type WriteHook,
  writeHooks,
} from './hooks.js';
export type { ModuleDef } from './module.js';
export { TurnRefused } from './modules/chat/turn-hooks.js';
export { eraseWithContributors, exportPersonalData } from './privacy/contributors.js';
export { defineQueue, defineSchedule, JOBS, registerQueue } from './queues/define.js';
export {
  type Basecamp,
  defineServer,
  runtime,
  type ServerDefinition,
} from './runtime.js';
export {
  migrate,
  runEval,
  runTemplates,
  startApi,
  startStudio,
  startWorker,
} from './start.js';
