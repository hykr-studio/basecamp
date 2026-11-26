import { statesPlugin } from '@hykr/core';
import { defineFeature } from '../feature.js';
import { StatesStart } from './start.js';
import { transitionTools } from './tools.js';
import { TransitionsController } from './transitions.controller.js';

/**
 * State machines (docs/decisions/B6B4.md): the `states` entity plugin (a record starts in its
 * initial state; only transitions move it), `<entity>.transition` behind
 * POST /api/transitions/:plural/:id/:transition, and the assistant's `transition-<plural>` tools.
 */
export const statesFeature = defineFeature({
  name: 'states',
  controllers: [TransitionsController],
  providers: [StatesStart],
  contributes: { entityPlugins: [statesPlugin], toolContributions: [transitionTools] },
});
