import { capabilities, checkStates, statesOf } from '@hykr/contracts';
import { serveTransitions } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * At start: every served entity's state machine is checked (a typo stops the start, not a
 * write), each capability a transition names is registered, and `<entity>.transition` becomes
 * replayable by approvals.
 */
@Injectable()
export class StatesStart implements OnModuleInit {
  onModuleInit() {
    for (const def of serveTransitions()) {
      checkStates(def.spec);
      for (const t of statesOf(def.spec)?.transitions ?? [])
        if (t.can && !capabilities.has(t.can))
          throw new Error(
            `${def.name}'s transition "${t.name}" needs "${t.can}", which is not a registered capability`,
          );
    }
  }
}
