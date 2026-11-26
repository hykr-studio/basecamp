// `agent.run`: run an agent now (the editor's Run now, the assistant's `run-agent`), through the
// write path. The queued run and `agent.run.requested` are written in its transaction; the
// `agents.requested` subscriber queues it. A manager may run anyone's agent, but only its owner
// may give the run a note: the run acts with the owner's rights, so another person's words never
// steer it.
import { RunAgentSpec } from '@hykr/contracts';
import { allow, defineCommand, deny } from '@hykr/core';
import { Agent, userOf } from './agent.entity.js';
import { type AgentRow, AgentRunRequested, agentsService } from './agents.service.js';
import { isAgentRun } from './scope.js';

export const RunAgent = defineCommand(RunAgentSpec, {
  resource: { type: 'agent', id: (input) => input.agentId },
  // Scoped: the owner's own agents, every agent with agents.manage; anyone else's is a 404.
  load: (tx, p, input) => Agent.repo.get(tx, p, input.agentId) as Promise<AgentRow>,
  authorize: (p, agent, input) => {
    if (isAgentRun(p)) return deny('agent_scope', 'An agent run cannot start agents');
    if (agent.status !== 'active') return deny('agent_paused', 'This agent is paused');
    // A note steers the run, which acts with the owner's rights: only the owner's words may.
    if (input.note && userOf(p) !== agent.ownerId)
      return deny('agent_note_owner_only', "Only this agent's owner can give its run a note");
    return allow('agent_run');
  },
  summarize: (_input, agent) => `Run the agent "${agent.name}"`,
  run: async ({ tx, input, loaded: agent }) => {
    const svc = agentsService();
    if (!svc) throw new Error('The agents feature is not running');
    const row = await svc.requestIn(tx, agent, input.note);
    return {
      value: { id: row.id, agentId: agent.id, status: 'queued' as const },
      touched: [],
      events: [
        new AgentRunRequested({
          id: row.id,
          agentId: agent.id,
          runId: row.runId,
          ownerId: agent.ownerId,
        }),
      ],
    };
  },
});
