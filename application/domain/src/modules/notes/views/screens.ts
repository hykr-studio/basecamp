import { defineScreen } from '@hykr/ui-registry';
import { z } from 'zod';

const id = z.object({ id: z.uuid() });

export const NoteDetailScreen = defineScreen({
  name: 'note.detail',
  title: 'note',
  description: 'One note, to read or edit.',
  params: id,
});
