import { Agent } from '@mastra/core/agent';
import { PromptInjectionDetector, UnicodeNormalizer } from '@mastra/core/processors';
import { fakeModel } from './fake-model.js';
import { listBeforeWrite, noRetryAfterRefusal } from './scorers.js';
import { addTodo, deleteTodo, listTodos, updateTodo } from './tools/todo-tools.js';
import { AGENT_ID, INSTRUCTIONS, isFakeModel, modelId } from './version.js';

export function createTodoAgent(): Agent {
  const fake = isFakeModel();
  return new Agent({
    id: AGENT_ID,
    name: 'To-do assistant',
    instructions: INSTRUCTIONS,
    // An openrouter/<provider>/<model> string is all Mastra needs; it reads OPENROUTER_API_KEY.
    model: fake ? fakeModel() : modelId(),
    // Keyed by tool id, so the model and the audit trail see the same names.
    tools: {
      'list-todos': listTodos,
      'add-todo': addTodo,
      'update-todo': updateTodo,
      'delete-todo': deleteTodo,
    },
    // Scored on every turn; results show in Studio when the agent is registered with storage.
    scorers: {
      listBeforeWrite: { scorer: listBeforeWrite, sampling: { type: 'ratio', rate: 1 } },
      noRetryAfterRefusal: { scorer: noRetryAfterRefusal, sampling: { type: 'ratio', rate: 1 } },
    },
    inputProcessors: [
      new UnicodeNormalizer(),
      ...(process.env.GUARDRAILS === 'on' && !fake
        ? [new PromptInjectionDetector({ model: modelId(), strategy: 'block', threshold: 0.8 })]
        : []),
    ],
  });
}
