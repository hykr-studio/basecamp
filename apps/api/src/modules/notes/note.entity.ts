import { NoteSpec } from '@app/contracts';
import { defineEntity } from '@app/core';
import { notes } from '@app/db';

export const Note = defineEntity(NoteSpec, { table: notes, owner: (t) => t.ownerId });
