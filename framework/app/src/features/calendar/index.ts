// Calendars in the app (B17): the person's connected calendars and private feeds (`/calendar`),
// and a record's invites, with the hooks under them.
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { CalendarScreen } from './CalendarScreen';

export { CalendarScreen } from './CalendarScreen';
export {
  useCalendarConnections,
  useCalendarFeeds,
  useCalendarProviders,
  useCompleteCalendar,
  useConnectCalendar,
  useCreateFeed,
  useDisconnectCalendar,
  useInvites,
  useRevokeFeed,
  useSendInvite,
} from './hooks';
export { RecordInvites } from './RecordInvites';

const destination: NavItem = {
  href: '/calendar',
  label: 'Calendar',
  icon: 'calendar',
  match: (path) => path === '/calendar' || path.startsWith('/calendar/'),
};

/**
 * The calendar screen (`/calendar`, where Google sends the browser back after connecting) and
 * its destination. List it in `<AppShell plugins>`.
 */
export const calendarPlugin = (): AppPlugin => ({
  name: 'calendar',
  routes: [{ path: '/calendar', screen: CalendarScreen }],
  nav: [destination],
});
