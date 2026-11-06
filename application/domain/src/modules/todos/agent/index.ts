/** The to-dos module, as the assistant knows it: the scripted model's verbs and its evals. */
import type { AgentModule } from '@hykr/agents/script';
import { evalCases, voiceEvalCases } from './evals.js';
import { todosScripts } from './scripts.js';

export const todosAgent: AgentModule = {
  scripts: todosScripts,
  evalCases,
  voiceEvalCases,
};
