/**
 * The meetings module's specs: isomorphic, read by the server and the apps. Closing a meeting
 * writes a note and to-dos, so it builds on the notes and to-dos modules.
 */
import { moduleSpec } from '@hykr/contracts';
import { CloseMeetingSpec, RescheduleMeetingSpec } from './commands.js';
import { MeetingSpec } from './meeting.js';

export * from './commands.js';
export * from './meeting.js';

export const meetingsSpec = moduleSpec({
  name: 'meetings',
  dependsOn: ['todos', 'notes'],
  entities: { meetings: MeetingSpec },
  commands: [CloseMeetingSpec, RescheduleMeetingSpec],
});
