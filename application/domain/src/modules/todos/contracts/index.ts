/** The to-dos module's specs: isomorphic, read by the server and the apps. */
import { moduleSpec } from '@hykr/contracts';
import { ClearDoneTodosSpec, TodoSpec } from './todo.js';

export * from './todo.js';

export const todosSpec = moduleSpec({
  name: 'todos',
  dependsOn: [],
  entities: { todos: TodoSpec },
  commands: [ClearDoneTodosSpec],
});
