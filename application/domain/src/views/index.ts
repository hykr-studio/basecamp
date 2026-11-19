/**
 * Every module's views and screens, for the apps (`@application/domain/views`): isomorphic, like
 * the module folders it gathers. One line per module, in module order.
 */
import { briefsViews } from '../modules/briefs/views/index.js';
import { meetingsViews } from '../modules/meetings/views/index.js';
import { notesViews } from '../modules/notes/views/index.js';
import { ordersViews } from '../modules/orders/views/index.js';
import { todosViews } from '../modules/todos/views/index.js';

export * from '../modules/briefs/views/index.js';
export * from '../modules/meetings/views/index.js';
export * from '../modules/notes/views/index.js';
export * from '../modules/orders/views/index.js';
export * from '../modules/todos/views/index.js';

/** Every module's views and screens, in module order: `createUiRegistry(...moduleViews)`. */
export const moduleViews = [
  todosViews,
  notesViews,
  meetingsViews,
  ordersViews,
  briefsViews,
  // basecamp module add: one line per module, above this one.
] as const;
