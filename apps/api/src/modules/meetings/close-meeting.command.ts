import { CloseMeetingSpec } from '@app/contracts';
import { allow, defineCommand, deny, needsApproval } from '@app/core';
import { Note } from '../notes/note.entity.js';
import { Todo } from '../todos/todo.entity.js';
import { Meeting } from './meeting.entity.js';

export class MeetingClosed {
  constructor(
    readonly meeting: unknown,
    readonly note: unknown,
    readonly todos: unknown[],
  ) {}
}

const todosLabel = (n: number) => `${n} to-do${n === 1 ? '' : 's'}`;

/** One transaction: a summary note, a to-do per action item, the meeting closed. All or none. */
export const CloseMeeting = defineCommand(CloseMeetingSpec, {
  resource: { type: 'meeting', id: (input) => input.meetingId },
  load: (tx, p, input) => Meeting.repo.get(tx, p, input.meetingId), // scoped: 404 if not theirs
  authorize: (p, meeting) => {
    if (meeting.status === 'closed')
      return deny('already_closed', 'This meeting is already closed');
    if (p.actor.kind === 'agent')
      return needsApproval('agent_close', 'Closing a meeting needs your approval');
    return allow('owner_closes');
  },
  summarize: (input, meeting) =>
    `Close ${meeting.title} with 1 note and ${todosLabel(input.actionItems.length)}`,
  run: async ({ tx, principal, input, loaded: meeting, via }) => {
    const note = await Note.repo.insert(
      tx,
      principal,
      {
        title: `Summary: ${meeting.title}`,
        body: [input.summary, '', '## Decisions', ...input.decisions.map((d) => `- ${d}`)].join(
          '\n',
        ),
        meetingId: meeting.id,
      },
      via,
    );
    const todos = [];
    for (const item of input.actionItems) {
      todos.push(await Todo.repo.insert(tx, principal, { ...item, meetingId: meeting.id }, via));
    }
    const closed = await Meeting.repo.update(tx, principal, meeting, { status: 'closed' }, via);
    return {
      value: { meeting: closed, note, todos },
      touched: [
        { type: 'meeting', id: closed.id, change: 'updated', before: meeting, after: closed },
        { type: 'note', id: note.id, change: 'created', after: note },
        ...todos.map((t) => ({ type: 'todo', id: t.id, change: 'created' as const, after: t })),
      ],
      events: [new MeetingClosed(closed, note, todos)],
    };
  },
});
