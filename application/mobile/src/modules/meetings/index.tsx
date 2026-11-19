/**
 * THE MEETINGS MODULE, app side: its destination, what to ask about meetings, its view and
 * screen components, and where a meeting opens. Other code imports this file only, never a
 * file under it. It uses the notes and to-dos modules' rows (meetings → notes, todos).
 */
import {
  CalendarDayView,
  CalendarWeekView,
  MeetingCardView,
  MeetingDetailScreen,
  MeetingListView,
} from '@application/domain/views';
import { defineAppModule } from '@hykr/app';
import { bindScreen, bindView } from '@hykr/ui-registry/react';
import { MeetingDetail } from './screens/MeetingDetail';
import {
  CalendarDayComponent,
  CalendarWeekComponent,
  MeetingCardComponent,
  MeetingListComponent,
} from './views';

export { MeetingRow } from './components/MeetingRow';
export { MeetingStatus, needsClosing, StatusBadge } from './status';

export const meetings = defineAppModule({
  name: 'meetings',
  nav: [
    {
      href: '/meetings',
      label: 'Meetings',
      icon: 'calendar',
      match: (p) => p.startsWith('/meetings'),
    },
  ],
  suggestions: [
    {
      text: 'close <meeting>',
      // The message box keeps line breaks (Shift+Enter on the web), and a meeting's own
      // screen is the chat's context, so "close this one" names it.
      what: 'paste the notes on the lines below, or on a meeting say "close this one"; waits for approval',
    },
    { text: 'move <meeting> to 2026-10-31', what: 'moves it and its to-dos' },
  ],
  // bindView checks each component's props against the view's schema at compile time.
  bind: () => {
    bindView(MeetingListView, MeetingListComponent);
    bindView(MeetingCardView, MeetingCardComponent);
    bindView(CalendarDayView, CalendarDayComponent);
    bindView(CalendarWeekView, CalendarWeekComponent);
    // The canvas shows the same screen as the route.
    bindScreen(MeetingDetailScreen, ({ id }) => <MeetingDetail id={id} embedded />);
  },
  hrefFor: { meeting: (id) => `/meetings/${id}` },
  webmcp: {
    meetings: { reads: ['meetings'] },
    meeting: { reads: ['meetings', 'notes', 'todos'] },
  },
});
