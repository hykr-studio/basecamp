/**
 * The notes module, as the assistant knows it: notes are memory of their meeting, recalled by
 * meaning (the framework's recall-memory). The application keeps the persona.
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases } from './evals.js';

export const notesAgent: AgentModule = {
  rules: [
    'Notes are what the team remembers about a meeting. When the user asks what was said, decided or noted about something, use recall-memory; for one meeting, pass about as "meeting:<id>".',
  ],
  evalCases,
  // A note to recall, once the memory index has it (the worker embeds it within a second or two).
  evalSetup: async (api) => {
    await api('POST', '/api/notes', {
      title: 'Kitchen colours',
      body: 'We chose a teal splash-back and oak shelves.',
    });
    for (let i = 0; i < 40; i++) {
      const found = (await api('GET', '/api/memory/recall?q=teal+splash-back')) as {
        items?: unknown[];
      };
      if (found.items?.length) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  },
};
