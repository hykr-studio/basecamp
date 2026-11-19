/**
 * THE NOTES MODULE, app side: its destination, its view and screen components, and where a
 * note opens. Other code imports this file only, never a file under it.
 */
import { NoteCardView, NoteDetailScreen, NoteListView } from '@application/domain/views';
import { defineAppModule } from '@hykr/app';
import { bindScreen, bindView } from '@hykr/ui-registry/react';
import { NoteDetail } from './screens/NoteDetail';
import { NoteCardComponent, NoteListComponent } from './views';

export { NoteRow } from './components/NoteRow';

export const notes = defineAppModule({
  name: 'notes',
  nav: [
    { href: '/notes', label: 'Notes', icon: 'file-text', match: (p) => p.startsWith('/notes') },
  ],
  bind: () => {
    bindView(NoteListView, NoteListComponent);
    bindView(NoteCardView, NoteCardComponent);
    bindScreen(NoteDetailScreen, ({ id }) => <NoteDetail id={id} />);
  },
  // Notes have no page of their own: a note opens in the list, where it can be edited.
  hrefFor: { note: () => '/notes' },
  webmcp: { notes: { reads: ['notes'] } },
});
