import { commandSpec } from '../framework/spec.js';
import {
  CloseMeetingInput,
  CloseMeetingResult,
  RescheduleMeetingInput,
  RescheduleMeetingResult,
} from './meeting.js';

export const CloseMeetingSpec = commandSpec({
  name: 'meeting.close',
  description:
    'Close a meeting in one step: writes a summary note (summary plus decisions), creates one to-do per action item linked to the meeting, and marks the meeting closed. A good action item is one task that starts with a verb, with the owner in brackets if known: "Send tile quotes to Ravi [Asha]". Give a due date only if the notes state one.',
  input: CloseMeetingInput,
  output: CloseMeetingResult,
  http: { method: 'POST', path: '/api/meetings/:meetingId/close' },
  tool: 'close-meeting',
  expose: 'all',
  approvalNote: 'When you call it, the whole close waits for the user to approve it.',
  view: { name: 'meeting.card', id: (input) => input.meetingId },
  verb: { do: 'close', did: 'closed' },
  touches: ['meeting', 'note', 'todo'],
});

export const RescheduleMeetingSpec = commandSpec({
  name: 'meeting.reschedule',
  description:
    "Move a meeting to a new start and end. Its open to-dos' due dates shift by the same number of days.",
  input: RescheduleMeetingInput,
  output: RescheduleMeetingResult,
  http: { method: 'POST', path: '/api/meetings/:meetingId/reschedule' },
  tool: 'reschedule-meeting',
  expose: 'all',
  approvalNote: 'If open to-dos would move, the user must approve it first.',
  view: { name: 'meeting.card', id: (input) => input.meetingId },
  verb: { do: 'move', did: 'moved' },
  touches: ['meeting', 'todo'],
});
