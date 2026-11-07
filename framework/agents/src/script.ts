// What a module writes for the assistant: its AgentModule (rules, help, eval cases) and scripts
// for the scripted model (MODEL_MODE=fake), built with these helpers.
export type {
  AgentDomain,
  AgentModule,
  EvalCase,
  EvalSetup,
  VoiceEvalCase,
} from './agent-domain.js';
export { runData } from './agent-run.js';
export {
  type CanvasPage,
  call,
  dayWords,
  decided,
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
