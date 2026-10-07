/**
 * THE DOMAIN: the sample business this template ships with (meetings, notes, to-dos).
 * Replace this folder to bring another domain; the framework reads only `domain` below.
 * See DOMAIN.md at the repository root for every folder a domain owns.
 */
import { defineDomain } from '../framework/domain.js';
import { CloseMeetingSpec, RescheduleMeetingSpec } from './commands.js';
import { MeetingSpec } from './meeting.js';
import { NoteSpec } from './note.js';
import { TodoSpec } from './todo.js';

export * from './commands.js';
export * from './meeting.js';
export * from './note.js';
export * from './todo.js';

export const domain = defineDomain({
  name: 'Meetings',
  entities: { todos: TodoSpec, notes: NoteSpec, meetings: MeetingSpec },
  commands: [CloseMeetingSpec, RescheduleMeetingSpec],
});
