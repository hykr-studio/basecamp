// State machines and SLAs (B6), from @hykr/core's index. docs/decisions/B6B4.md.
export {
  type SlaConfig,
  SlaBreached,
  type SweepResult,
  dueAt,
  slaConfig,
  slaHook,
  sweepSla,
  timerOut,
} from './sla.js';
export {
  assertWritable,
  checkTransition,
  machineOf,
  serveTransitions,
  statesEntity,
  TransitionEvent,
  transition,
  transitionInput,
  transitionOp,
  transitionVia,
} from './transition.js';
