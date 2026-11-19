import type { AppPlugin } from '../../framework/app-domain';
import { SHARE_ROUTE } from './client';
import { ShareScreen } from './ShareScreen';

/**
 * Share links in the app (decisions B9): `/share/:token` opens what a link shows, for anyone
 * holding it, signed in or not, on its own (the shell's public route gate): no navigation, no
 * thread, no session asked for. List it in `<AppShell plugins>`; the application's `+not-found`
 * route serves its path, like every plugin route.
 */
export function sharePlugin(): AppPlugin {
  return {
    name: 'share',
    routes: [{ path: SHARE_ROUTE, screen: ShareScreen, public: true, standalone: true }],
  };
}
