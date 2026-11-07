import type { AppPlugin } from '../../framework/app-domain';
import { InboxScreen } from './InboxScreen';

/**
 * The in-app inbox: the `/inbox` screen and its destination. What notifications leave for the
 * person with the `inapp` channel (mentions in comments, and any an application adds) is
 * listed there; live updates refresh it.
 */
export function inboxPlugin(): AppPlugin {
  return {
    name: 'inbox',
    routes: [{ path: '/inbox', screen: InboxScreen }],
    nav: [{ href: '/inbox', label: 'Inbox', icon: 'bell', match: (p) => p.startsWith('/inbox') }],
  };
}
