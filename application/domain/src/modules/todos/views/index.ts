/** The to-dos module's views: what the assistant may show for to-dos. Isomorphic. */
import type { UiPart, ViewDef } from '@hykr/ui-registry';
import { TodoItemView, TodoListView } from './todo.js';

export * from './todo.js';

export const todosViews: UiPart = {
  name: 'todos',
  views: [TodoListView, TodoItemView] as unknown as readonly ViewDef[],
  screens: [],
};
