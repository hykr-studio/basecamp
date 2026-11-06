import { defineEntity } from '@hykr/core';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { NoteSpec } from '../contracts/index.js';
import { notes } from '../db/schema.js';

export const Note = defineEntity(NoteSpec, {
  table: notes,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
});
