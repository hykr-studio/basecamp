/**
 * THE TO-DOS MODULE, app side: its destination, what to ask about to-dos, its view components,
 * and where a to-do opens. Other code imports this file only, never a file under it.
 */
import { TodoItemView, TodoListView } from '@application/domain/views';
import { defineAppModule } from '@hykr/app';
import { bindView } from '@hykr/ui-registry/react';
import { TodoItemComponent, TodoListComponent } from './views';

export { TodoRow } from './components/TodoRow';

export const todos = defineAppModule({
  name: 'todos',
  nav: [
    { href: '/todos', label: 'To-dos', icon: 'check-square', match: (p) => p.startsWith('/todos') },
  ],
  suggestions: [
    { text: 'add Book the site visit', what: 'adds a to-do' },
    { text: 'done Book the site visit', what: 'ticks it off' },
    { text: 'delete Book the site visit', what: 'asks you to approve the delete' },
  ],
  bind: () => {
    bindView(TodoListView, TodoListComponent);
    bindView(TodoItemView, TodoItemComponent);
  },
  hrefFor: { todo: () => '/todos' },
  // While the to-dos screen is open, a browser agent may list and get to-dos (WebMCP, read-only,
  // with the person's own access): the tools list-todos and get-todo.
  webmcp: { todos: { reads: ['todos'] } },
});
