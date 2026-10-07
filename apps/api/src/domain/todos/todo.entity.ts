import { TodoSpec } from '@app/contracts';
import { defineEntity } from '@app/core';
import { todos } from '@app/db';

/** To-dos: plain CRUD. The spec says an agent's delete waits for the owner. */
export const Todo = defineEntity(TodoSpec, { table: todos, owner: (t) => t.ownerId });
