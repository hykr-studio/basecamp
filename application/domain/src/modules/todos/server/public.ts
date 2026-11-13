/**
 * What other modules may use of the to-dos module on the server. The Todo entity's scoped repo
 * runs the framework's checks inside the caller's transaction (close-meeting writes to-dos in
 * its own). Everything else in server/ is the module's own.
 */
export { Todo } from './todo.entity.js';
