import { ApiError } from '@app/api-client';
import { CreateTodoInput } from '@app/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { apiFor } from '../context.js';

/** Refusals become data the model can explain, not exceptions that end the run. */
async function safely<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, result: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false as const, status: e.status, error: e.body };
    throw e;
  }
}

export const listTodos = createTool({
  id: 'list-todos',
  description: "List the user's to-dos with their ids. Call this before changing anything.",
  inputSchema: z.object({}),
  execute: async (_input, ctx) => safely(() => apiFor(ctx?.requestContext).listTodos()),
});

export const addTodo = createTool({
  id: 'add-todo',
  description: 'Add a to-do for the user. dueOn is optional, format YYYY-MM-DD.',
  inputSchema: CreateTodoInput,
  execute: async (input, ctx) => safely(() => apiFor(ctx?.requestContext).createTodo(input)),
});

export const updateTodo = createTool({
  id: 'update-todo',
  description: 'Change a to-do: its title, done, or dueOn (YYYY-MM-DD). Use an id from list-todos.',
  inputSchema: z.object({
    id: z.string().describe('The to-do id from list-todos'),
    title: CreateTodoInput.shape.title.optional(),
    done: z.boolean().optional(),
    dueOn: CreateTodoInput.shape.dueOn,
  }),
  execute: async ({ id, ...changes }, ctx) =>
    safely(() => apiFor(ctx?.requestContext).updateTodo(id, changes)),
});

export const deleteTodo = createTool({
  id: 'delete-todo',
  description:
    'Ask to delete a to-do. The user must approve it before it is removed: tell them it is waiting for their approval. Use an id from list-todos.',
  inputSchema: z.object({ id: z.string().describe('The to-do id from list-todos') }),
  execute: async ({ id }, ctx) => safely(() => apiFor(ctx?.requestContext).deleteTodo(id)),
});
