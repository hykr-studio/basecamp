import { CORE_OPTIONS, type CoreOptions, eventQueues, type SweepResult, sweepSla } from '@hykr/core';
import { Inject, Injectable } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';

/** The SLA sweeper: breaches this process's clocks that ran out, and escalates them. */
@Injectable()
export class SlaService {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** One sweep, as the schedule runs it each minute; `now` lets a test move the clock. */
  sweep(now?: Date): Promise<SweepResult> {
    return sweepSla(this.options.db, {
      prefix: eventQueues(),
      now,
      // After each breach commits: notifications in this process follow it.
      publish: (events) => {
        for (const event of events) this.events.publish(event);
      },
    });
  }
}
