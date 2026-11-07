// What an application (and the tests) use of the agents feature: templates, the webhook handler
// for its own connectors, the run token, and the services. Loading it opens nothing.
export { agentRunToken } from '@hykr/agents';
export { Agent } from './agent.entity.js';
export { AgentsService, agentsService, MAX_DEPTH, MAX_OPEN } from './agents.service.js';
export { AgentRunner, agentVersionOf } from './runner.js';
export { isAgentRun, RUN_SCOPE, scopesFor, toolsOutside } from './scope.js';
export {
  type AgentWebhookSink,
  agentTemplates,
  agentWebhookHandler,
  agentWebhooks,
  defineAgentTemplate,
} from './templates.js';
export {
  cronProblem,
  eventMatches,
  messageMatches,
  movingValue,
  nextRun,
  resolveWhere,
  triggerLabel,
  webhookMatches,
} from './triggers.js';
