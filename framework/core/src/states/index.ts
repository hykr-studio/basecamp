// State machines and SLAs (B6), from @hykr/core's index. docs/decisions/B6B4.md.
export {
  dueAt,
  SlaBreached,
  type SlaConfig,
  type SweepResult,
  slaConfig,
  slaHook,
  sweepSla,
  timerOut,
} from './sla.js';
export {
  clocksServed,
  decodeSlaCursor,
  encodeSlaCursor,
  listSlaTimers,
  recordSlaTimers,
  type SlaCursor,
  stateFieldHidden,
} from './sla-read.js';
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
