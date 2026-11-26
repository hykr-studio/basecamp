import { defineEntity } from '@hykr/core';
import type { Access } from '@hykr/policy';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { TodoSpec } from '../contracts/index.js';
import { todos } from '../db/schema.js';

/** The business's access, plus the buyer: only the to-dos granted to them (POST /api/grants). */
const TODO_ACCESS: Access = {
  read: { ...BUSINESS_ACCESS.read, buyer: { grant: 'granted' } },
  write: { ...BUSINESS_ACCESS.write, buyer: { grant: 'granted' } },
};

/** To-dos: plain CRUD. The spec says an agent's delete waits for the owner. */
export const Todo = defineEntity(TodoSpec, {
  table: todos,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: TODO_ACCESS,
});
