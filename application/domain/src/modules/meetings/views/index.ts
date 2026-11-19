/** The meetings module's views and screen: meetings, a day and a week of them. Isomorphic. */
import type { ScreenDef, UiPart, ViewDef } from '@hykr/ui-registry';
import { CalendarDayView, CalendarWeekView, MeetingCardView, MeetingListView } from './meeting.js';
import { MeetingDetailScreen } from './screens.js';

export * from './meeting.js';
export * from './screens.js';

export const meetingsViews: UiPart = {
  name: 'meetings',
  views: [
    MeetingListView,
    MeetingCardView,
    CalendarDayView,
    CalendarWeekView,
  ] as unknown as readonly ViewDef[],
  screens: [MeetingDetailScreen] as unknown as readonly ScreenDef[],
};
