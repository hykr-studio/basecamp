/**
 * The meetings module, as the assistant knows it: how to draft a close and what a reschedule
 * moves. The application keeps the persona (application/api/src/server.ts).
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases, voiceEvalCases } from './evals.js';
import { meetingsScripts } from './scripts.js';

export const meetingsAgent: AgentModule = {
  rules: [
    'When the user pastes meeting notes, draft a close-meeting call: a 2–3 sentence summary, the decisions as short bullets, and one action item per concrete task. Only add a due date if the notes state one. Then tell the user to review and approve it.',
    "Rescheduling moves the meeting's open to-dos too; say so before you do it.",
  ],
  scripts: meetingsScripts,
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
