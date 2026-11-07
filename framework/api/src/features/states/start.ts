import { capabilities, checkStates, levelOf, statesOf } from '@hykr/contracts';
import { serveTransitions } from '@hykr/core';
import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';

/**
 * At start: every served entity's state machine is checked (a typo stops the start, not a
 * write), each capability a transition or an SLA's escalation names is registered, SLA names are unique across the
 * application (a business's settings override them by name), and `<entity>.transition` becomes
 * replayable by approvals. Once everything has registered, each level a transition names is one
 * the application declares.
 */
@Injectable()
export class StatesStart implements OnModuleInit, OnApplicationBootstrap {
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
        for (const c of s.escalate?.notify ?? [])
          if (!capabilities.has(c))
            throw new Error(
              `The SLA "${s.name}" notifies "${c}", which is not a registered capability`,
            );
      }
    }
  }

  onApplicationBootstrap() {
    for (const def of serveTransitions())
      for (const t of statesOf(def.spec)?.transitions ?? [])
        if (t.level !== undefined && !levelOf(t.level))
          throw new Error(
            `${def.name}'s transition "${t.name}" is at the level "${t.level}", which the application does not declare`,
          );
  }
}
