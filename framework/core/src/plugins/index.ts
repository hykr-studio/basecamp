// The core's entity plugins, one export per line (a union merge keeps lines added in parallel).
export { moneyPlugin } from './money.js';
export { parentPlugin } from './parent.js';
export { fieldPolicyPlugin, fieldPolicyProblems } from './field-policy.js';
export { grantsCleanup, holdsGrant, recordGrantKind } from './grants.js';
