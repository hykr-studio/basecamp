/**
 * What other modules may use of the notes module on the server. The Note entity's scoped repo
 * runs the framework's checks inside the caller's transaction (close-meeting writes its summary
 * note in its own). Everything else in server/ is the module's own.
 */
export { Note } from './note.entity.js';
