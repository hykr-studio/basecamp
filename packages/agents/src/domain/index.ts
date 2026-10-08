/**
 * THE DOMAIN, as the assistant knows it: meetings, notes and to-dos. Replace this folder to
 * bring another domain; the framework reads only `agentDomain`. Its entities and commands
 * (and so its tools) come from @app/contracts.
 */
import type { AgentDomain } from '../agent-domain.js';
import { evalCases, voiceEvalCases } from './evals.js';
import { domainScripts } from './scripts.js';

export const agentDomain: AgentDomain = {
  persona:
    'You are a meetings assistant. You help the user plan meetings, keep notes, and track action items.',
  rules: [
    'When the user pastes meeting notes, draft a close-meeting call: a 2–3 sentence summary, the decisions as short bullets, and one action item per concrete task. Only add a due date if the notes state one. Then tell the user to review and approve it.',
    "Rescheduling moves the meeting's open to-dos too; say so before you do it.",
  ],
  help: 'I can add, list, complete or delete to-dos, show today, and close or move meetings.',
  scripts: domainScripts,
  evalCases,
  voiceEvalCases,
  // The close and open cases need a meeting to find.
  evalSetup: async (api) => {
    await api('POST', '/api/meetings', {
      title: 'Eval sync',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  },
};
