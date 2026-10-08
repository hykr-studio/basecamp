import { RescheduleMeetingSpec } from '@app/contracts';
import { allow, defineCommand, deny, type NamedEvent, needsApproval } from '@app/core';
import { Todo } from '../todos/todo.entity.js';
import { Meeting } from './meeting.entity.js';

/** meeting.rescheduled: what happened, to which meeting (a NamedEvent: notifications schedule on it). */
export class MeetingRescheduled implements NamedEvent {
  readonly eventName = 'meeting.rescheduled';
  get row() {
    return this.meeting;
  }
  constructor(
    readonly meeting: unknown,
    readonly shiftDays: number,
  ) {}
}

const DAY = 86_400_000;
const dayOf = (d: Date | string) =>
  Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth(), new Date(d).getUTCDate());
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** A rule that needs two entities: moving the meeting moves its open to-dos with it. */
export const RescheduleMeeting = defineCommand(RescheduleMeetingSpec, {
  resource: { type: 'meeting', id: (input) => input.meetingId },
  load: async (tx, p, input) => {
    const meeting = await Meeting.repo.get(tx, p, input.meetingId);
    const open = await Todo.repo.list(tx, p, {
      meetingId: input.meetingId,
      done: false,
      limit: 100,
    });
    return { meeting, moving: open.items.filter((t) => t.dueOn) };
  },
  authorize: (p, { meeting, moving }) => {
    if (meeting.status === 'closed') return deny('closed_is_final', 'Closed meetings cannot move');
    if (p.actor.kind === 'agent' && moving.length > 0) {
      return needsApproval(
        'agent_moves_todos',
        `Moving this meeting moves ${moving.length} open to-do date(s)`,
      );
    }
    return allow('owner_moves');
  },
  summarize: (input, { meeting, moving }) =>
    `Move ${meeting.title} to ${input.startsAt.slice(0, 10)} and shift ${moving.length} to-do date(s)`,
  run: async ({ tx, principal, input, loaded: { meeting, moving }, via }) => {
    const shiftDays = Math.round((dayOf(input.startsAt) - dayOf(meeting.startsAt)) / DAY);
    const moved = await Meeting.repo.update(
      tx,
      principal,
      meeting,
      { startsAt: input.startsAt, endsAt: input.endsAt },
      via,
    );
    const shifted = [];
    for (const t of moving) {
      shifted.push(
        await Todo.repo.update(
          tx,
          principal,
          t,
          { dueOn: addDays(t.dueOn as string, shiftDays) },
          via,
        ),
      );
    }
    return {
      value: { meeting: moved, shifted },
      touched: [
        { type: 'meeting', id: moved.id, change: 'updated', before: meeting, after: moved },
        ...shifted.map((t, i) => ({
          type: 'todo',
          id: t.id,
          change: 'updated' as const,
          before: moving[i],
          after: t,
        })),
      ],
      events: [new MeetingRescheduled(moved, shiftDays)],
    };
  },
});
