// What an application writes for its assistant: the AgentDomain (persona, rules, eval cases)
// and scripts for the scripted model (MODEL_MODE=fake), built with these helpers.
export type { AgentDomain, EvalCase, VoiceEvalCase } from './agent-domain.js';
export {
  type CanvasPage,
  call,
  dayWords,
  defineScript,
  items,
  type Outcome,
  plural,
  type Row,
  type Script,
  type Step,
  sameTitle,
  say,
  sayIn,
  startOfDay,
  type Turn,
  verbs,
  written,
} from './fake/engine.js';
export type { Expected } from './scorers.js';
