import { z } from 'zod';
import { defineScreen } from '../define-view.js';

const id = z.object({ id: z.uuid() });

export const MeetingDetailScreen = defineScreen({
  name: 'meeting.detail',
  title: 'meeting',
  description: 'One meeting in full: notes, to-dos, closing and rescheduling, and its history.',
  params: id,
});

export const NoteDetailScreen = defineScreen({
  name: 'note.detail',
  title: 'note',
  description: 'One note, to read or edit.',
  params: id,
});
