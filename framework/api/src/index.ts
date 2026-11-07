// The Basecamp server, as a library: an application defines itself once (defineServer) and
// starts the API, the queue worker or the templates CLI with it. Nothing exported here reads the
// environment when it loads.

export { defineSubscriber, EVENTS_QUEUE, matchesEvent } from './features/events/subscriber.js';
export { defineFeature, type FeatureDef } from './features/feature.js';
export {
  dispositionOf,
  type FileRow,
  type FilesConfig,
  FilesService,
  fileLine,
  filesConfig,
  STORAGE,
  type StorageDriver,
  StorageUnavailable,
  type Uploader,
} from './features/files/public.js';
export { IntegrationsCapability } from './features/integrations/capability.js';
export { openConnection } from './features/integrations/credentials.js';
export {
  type ConnectorHandler,
  type ConnectorHandlerContext,
  connectorHandlers,
  connectors,
  defineConnectorHandler,
  type InboundEventRecord,
} from './features/integrations/registry.js';
export { outboundPolicy } from './features/integrations/settings.js';
export { type LiveResource, liveResources } from './features/live/resources.js';
export {
  anyRole,
  backfillAll,
  MemoryIndexer,
  RecallService,
} from './features/memory/index.js';
export {
  ModelPolicyChanged,
  ModelPolicyService,
  ModelRefused,
  SET_MODEL_POLICY,
} from './features/models/index.js';
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
  type LevelRule,
  levelRules,
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
export { defineModule, type ModuleDef } from './module.js';
export { type ModelGate, TurnRefused } from './modules/chat/turn-hooks.js';
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
