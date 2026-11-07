import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { CreditsScreen } from './CreditsScreen';

export { CreditsScreen } from './CreditsScreen';
export { formatCredits, toMinor } from './money';

/** The capability that shows the credits screen (`credits.view` on the server). */
const VIEW = 'credits.view';

const destination: NavItem = {
  href: '/credits',
  label: 'Credits',
  icon: 'credit-card',
  match: (path) => path === '/credits' || path.startsWith('/credits/'),
};

/**
 * The credits screen (`/credits`) and its destination, shown to people whose roles hold
 * `credits.view`. List it in `<AppShell plugins>`.
 */
export const creditsPlugin: AppPlugin = {
  name: 'credits',
  routes: [{ path: '/credits', screen: CreditsScreen }],
  nav: [destination],
  useNav: (items) => {
    const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
    const sees = me.data?.capabilities.includes(VIEW) ?? false;
    return sees ? items : items.filter((i) => i.href !== destination.href);
  },
};
