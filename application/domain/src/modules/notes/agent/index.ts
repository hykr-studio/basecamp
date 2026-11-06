/** The notes module, as the assistant knows it: the scripted model's verbs. */
import type { AgentModule } from '@hykr/agents/script';
import { notesScripts } from './scripts.js';

export const notesAgent: AgentModule = {
  scripts: notesScripts,
  rules: [
    "A photo someone sends on WhatsApp is named in their message with its file id. When they ask to keep it on a note, put that id in the note's photos: create-note, or update-note with the whole list.",
  ],
};
