import { ApiError } from '@app/api-client';
import { CreateTodoInput } from '@app/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { apiFor } from '../context.js';

type Logger = { info(m: string, d?: object): void; warn(m: string, d?: object): void };

/**
 * Refusals become data the model can explain, not exceptions that end the run. Each
 * outcome is logged through the tool's trace-correlated logger (Studio → Logs).
 */
async function safely<T>(
  tool: string,
  ctx: { loggerVNext?: Logger } | undefined,
  fn: () => Promise<T>,
) {
  try {
    const result = await fn();
    ctx?.loggerVNext?.info(`${tool} ok`, { tool });
    return { ok: true as const, result };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { reason?: string; message?: unknown } | null;
      ctx?.loggerVNext?.warn(`${tool} refused by the API (${e.status})`, {
        tool,
        status: e.status,
        reason: body?.reason ?? body?.message,
      });
      return { ok: false as const, status: e.status, error: e.body };
    }
    throw e;
  }
}

export const listTodos = createTool({
  id: 'list-todos',
  description: "List the user's to-dos with their ids. Call this before changing anything.",
  inputSchema: z.object({}),
  execute: async (_input, ctx) => safely('list-todos', ctx, () => apiFor(ctx).listTodos()),
});

export const addTodo = createTool({
  id: 'add-todo',
  description: 'Add a to-do for the user. dueOn is optional, format YYYY-MM-DD.',
  inputSchema: CreateTodoInput,
  execute: async (input, ctx) => safely('add-todo', ctx, () => apiFor(ctx).createTodo(input)),
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
    safely('update-todo', ctx, () => apiFor(ctx).updateTodo(id, changes)),
});

export const deleteTodo = createTool({
  id: 'delete-todo',
  description:
    'Ask to delete a to-do. The user must approve it before it is removed: tell them it is waiting for their approval. Use an id from list-todos.',
  inputSchema: z.object({ id: z.string().describe('The to-do id from list-todos') }),
  execute: async ({ id }, ctx) => safely('delete-todo', ctx, () => apiFor(ctx).deleteTodo(id)),
});
