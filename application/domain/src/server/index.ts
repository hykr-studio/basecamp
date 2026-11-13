/**
 * What the whole application contributes to the server, beside its modules: its approval levels
 * and the level rules that are not one module's (a module brings its own in `contributes`), and
 * what it says about personal data (its processors, its policy and its retention periods).
 * application/api/src/server.ts passes it to defineServer.
 */
import type { Contributions } from '@hykr/contracts';
import { Levels, SendsGoOutside } from './approval-levels.js';
import { ErasureIsIrreversible, PrivacyPolicy, Processors, RetentionPeriods } from './privacy.js';

export { Levels } from './approval-levels.js';

export const contributions: Partial<Contributions> = {
  approvalLevels: Object.values(Levels),
  levelRules: [SendsGoOutside, ErasureIsIrreversible],
  processors: Processors,
  privacyPolicies: [PrivacyPolicy],
  retentionPeriods: RetentionPeriods,
};
