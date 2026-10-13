import { defineEntity } from '@hykr/core';
import { TodoSpec } from '../../contracts/index.js';
import { todos } from '../../db/schema.js';
import { BUSINESS_ACCESS } from '../access.js';

/** To-dos: plain CRUD. The spec says an agent's delete waits for the owner. */
export const Todo = defineEntity(TodoSpec, {
  table: todos,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
});
