import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  entityController,
  entityHandlers,
  type NamedEvent,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { RescheduleVisitSpec, TaskSpec, VisitSpec } from './contracts.js';
import { tasks, visits } from './schema.js';

/** Owners and staff their own rows, admins and ops the business, a customer theirs. */
const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const Task = defineEntity(TaskSpec, {
  table: tasks,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

export const Visit = defineEntity(VisitSpec, {
  table: visits,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/** visit.rescheduled: a NamedEvent, so a notification can follow it. */
export class VisitRescheduled implements NamedEvent {
  readonly eventName = 'visit.rescheduled';
  constructor(readonly row: unknown) {}
}

export const RescheduleVisit = defineCommand(RescheduleVisitSpec, {
  resource: { type: 'visit', id: (input) => input.visitId },
  load: async (tx, p, input) => ({ visit: await Visit.repo.get(tx, p, input.visitId) }),
  authorize: () => allow('owner_moves'),
  summarize: (input, { visit }) => `Move ${visit.title} to ${input.startsAt.slice(0, 10)}`,
  run: async ({ tx, principal, input, loaded: { visit }, via }) => {
    const moved = await Visit.repo.update(
      tx,
      principal,
      visit,
      { startsAt: input.startsAt, endsAt: input.endsAt },
      via,
    );
    return {
      value: moved,
      touched: [{ type: 'visit', id: moved.id, change: 'updated', before: visit, after: moved }],
      events: [new VisitRescheduled(moved)],
    };
  },
});

@Module({
  controllers: [
    entityController(Task),
    entityController(Visit),
    commandController(RescheduleVisit),
  ],
  providers: [...entityHandlers(Task), ...entityHandlers(Visit), commandHandler(RescheduleVisit)],
})
export class FixtureModule {}
