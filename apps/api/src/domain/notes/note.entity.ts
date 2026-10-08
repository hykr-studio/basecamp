import { NoteSpec } from '@app/contracts';
import { defineEntity } from '@app/core';
import { notes } from '@app/db';
import { BUSINESS_ACCESS } from '../access.js';

export const Note = defineEntity(NoteSpec, {
  table: notes,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
});
