import { capabilities, checkStates, statesOf } from '@hykr/contracts';
import { serveTransitions } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';

/**
 * At start: every served entity's state machine is checked (a typo stops the start, not a
 * write), each capability a transition names is registered, SLA names are unique across the
 * application (a business's settings override them by name), and `<entity>.transition` becomes
 * replayable by approvals.
 */
@Injectable()
export class StatesStart implements OnModuleInit {
  onModuleInit() {
    const slas = new Map<string, string>();
    for (const def of serveTransitions()) {
      checkStates(def.spec);
      const trait = statesOf(def.spec);
      for (const t of trait?.transitions ?? [])
        if (t.can && !capabilities.has(t.can))
          throw new Error(
            `${def.name}'s transition "${t.name}" needs "${t.can}", which is not a registered capability`,
          );
      for (const s of trait?.slas ?? []) {
        const other = slas.get(s.name);
        if (other && other !== def.name)
          throw new Error(`The SLA "${s.name}" is declared by both ${other} and ${def.name}`);
        slas.set(s.name, def.name);
      }
    }
  }
}
