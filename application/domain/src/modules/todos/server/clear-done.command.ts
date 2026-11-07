import { allow, defineCommand, needsApproval } from '@hykr/core';
import { ClearDoneTodosSpec } from '../contracts/index.js';
import { Todo } from './todo.entity.js';

/**
 * todo.clearDone: delete every done to-do the person reaches, in one write. The business switches
 * it on (`todos.clear-done`); the assistant's call waits for the person.
 */
export const ClearDoneTodos = defineCommand(ClearDoneTodosSpec, {
  resource: { type: 'todo', id: () => null },
  load: async (tx, p) => (await Todo.repo.list(tx, p, { done: true, limit: 1000 })).items,
  authorize: (p) =>
    p.actor.kind === 'agent'
      ? needsApproval('agent_clear_done', 'Clearing done to-dos needs your approval')
      : allow('owner_clears'),
  summarize: (_input, done) => `Clear ${done.length} done to-do${done.length === 1 ? '' : 's'}`,
  run: async ({ tx, principal, loaded: done, via }) => {
    for (const todo of done) await Todo.repo.delete(tx, principal, todo, via);
    return {
      value: { cleared: done.length },
      touched: done.map((todo) => ({
        type: 'todo',
        id: todo.id,
        change: 'deleted' as const,
        before: todo,
      })),
    };
  },
});
