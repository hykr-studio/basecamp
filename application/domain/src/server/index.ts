/**
 * What the whole application contributes to the server, beside its modules: its approval levels
 * and the level rules that are not one module's (a module brings its own in `contributes`).
 * application/api/src/server.ts passes it to defineServer.
 */
import type { Contributions } from '@hykr/contracts';
import { Levels, SendsGoOutside } from './approval-levels.js';

export { Levels } from './approval-levels.js';

export const contributions: Partial<Contributions> = {
  approvalLevels: Object.values(Levels),
  levelRules: [SendsGoOutside],
};
