/** The notes module's specs: isomorphic, read by the server and the apps. */
import { moduleSpec } from '@hykr/contracts';
import { NoteSpec } from './note.js';

export * from './note.js';

export const notesSpec = moduleSpec({
  name: 'notes',
  dependsOn: [],
  entities: { notes: NoteSpec },
  commands: [],
});
