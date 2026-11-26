/** The notes module's views and screen: what the assistant may show for notes. Isomorphic. */
import type { ScreenDef, UiPart, ViewDef } from '@hykr/ui-registry';
import { NoteCardView, NoteListView } from './note.js';
import { NoteDetailScreen } from './screens.js';

export * from './note.js';
export * from './screens.js';

export const notesViews: UiPart = {
  name: 'notes',
  views: [NoteListView, NoteCardView] as unknown as readonly ViewDef[],
  screens: [NoteDetailScreen] as unknown as readonly ScreenDef[],
};
