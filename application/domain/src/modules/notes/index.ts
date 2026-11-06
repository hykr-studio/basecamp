/** The notes module, server side: markdown notes, optionally linked to a meeting. */
import { defineModule } from '@hykr/api';
import { notesAgent } from './agent/index.js';
import { notesSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { NotesModule } from './server/notes.module.js';
import { notesViews } from './views/index.js';

export const notes = defineModule({
  ...notesSpec,
  server: NotesModule,
  views: notesViews.views,
  screens: notesViews.screens,
  agent: notesAgent,
  tables,
});
