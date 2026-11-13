/**
 * The notes module, as the assistant knows it: the scripted model's verbs, and notes as memory
 * of their meeting, recalled by meaning (the framework's recall-memory). The application keeps
 * the persona.
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases, voiceEvalCases } from './evals.js';
import { notesScripts } from './scripts.js';

export const notesAgent: AgentModule = {
  scripts: notesScripts,
  rules: [
    "A photo someone sends on WhatsApp is named in their message with its file id. When they ask to keep it on a note, put that id in the note's photos: create-note, or update-note with the whole list.",
    'Notes are what the team remembers about a meeting. When the user asks what was said, decided or noted about something, use recall-memory; for one meeting, pass about as "meeting:<id>".',
  ],
  evalCases,
  voiceEvalCases,
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
