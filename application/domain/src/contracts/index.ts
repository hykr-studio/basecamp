/**
 * Every module's specs, for the apps and anything else that needs them all
 * (`@application/domain/contracts`): isomorphic, like the module folders it gathers. The server
 * takes the modules themselves (../modules). One line per module, in module order.
 */
import { accountSpec } from '../modules/account/contracts/index.js';
import { meetingsSpec } from '../modules/meetings/contracts/index.js';
import { notesSpec } from '../modules/notes/contracts/index.js';
import { ordersSpec } from '../modules/orders/contracts/index.js';
import { todosSpec } from '../modules/todos/contracts/index.js';

export * from '../modules/account/contracts/index.js';
export * from '../modules/meetings/contracts/index.js';
export * from '../modules/notes/contracts/index.js';
export * from '../modules/orders/contracts/index.js';
export * from '../modules/todos/contracts/index.js';

/** Every module's specs, in module order: `createCatalog(...moduleSpecs)`. */
export const moduleSpecs = [
  todosSpec,
  notesSpec,
  meetingsSpec,
  ordersSpec,
  accountSpec,
  // basecamp module add: one line per module, above this one.
] as const;
