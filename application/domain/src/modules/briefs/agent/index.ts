/**
 * What the briefs module teaches the assistant: its rules, the scripted model's scripts
 * (MODEL_MODE=fake) and its evals (`basecamp eval --module briefs`). A script's verbs must not
 * take another module's eval turns: defineServer checks it at boot.
 */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases, voiceEvalCases } from './evals.js';
import { briefsScripts } from './scripts.js';

export const briefsAgent: AgentModule = {
  rules: [
    'A brief is what a customer needs, in their words: take it down as they said it (their name, the need, a budget or a date only when they give one). Mark it reviewed once someone on the team has read it; never change what the customer asked for.',
  ],
  scripts: briefsScripts,
  evalCases,
  voiceEvalCases,
};
