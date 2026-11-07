/**
 * THE APPLICATION's modules, in dependency order (a module after the ones it depends on): what
 * application/api/src/server.ts gives defineServer. Server only: the apps read the isomorphic
 * aggregates (../contracts, ../views). Replace these to bring another domain; see DOMAIN.md.
 * One line per module: `basecamp module add <name>` adds its own.
 */
import { account } from './account/index.js';
import { meetings } from './meetings/index.js';
import { notes } from './notes/index.js';
import { orders } from './orders/index.js';
import { todos } from './todos/index.js';

export const modules = [
  todos,
  notes,
  meetings,
  orders,
  account,
  // basecamp module add: one line per module, above this one.
];
