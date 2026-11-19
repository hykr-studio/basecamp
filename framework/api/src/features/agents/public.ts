// What an application uses of the agents feature: templates, the webhook handler for its own
// connectors, the run token, and what a trigger means. Loading it opens nothing and reads no
// configuration (the services are in @hykr/api/testing/internals for tests).
export { agentRunToken } from '@hykr/agents';
export { Agent } from './agent.entity.js';
export { isAgentRun, RUN_SCOPE, scopesFor, toolsOutside } from './scope.js';
export {
  type AgentWebhookSink,
  agentTemplates,
  agentWebhookHandler,
  agentWebhooks,
  defineAgentTemplate,
} from './templates.js';
export {
  canonicalJson,
  cronProblem,
  eventMatches,
  keptTriggers,
  messageMatches,
  movingValue,
  nextRun,
  resolveWhere,
  sameTrigger,
  triggerLabel,
  webhookMatches,
} from './triggers.js';
