import { ApiError } from '@hykr/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { api } from '../../api';
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import {
  businessOf,
  chooseBusiness,
  currentBusiness,
  onBusinessChange,
} from '../../framework/business';
import { BusinessesScreen } from './BusinessesScreen';

export { BusinessesScreen } from './BusinessesScreen';

const destination: NavItem = {
  href: '/businesses',
  label: 'Businesses',
  icon: 'briefcase',
  match: (path) => path === '/businesses',
};

/**
 * Everything under it starts again when the person switches business, with nothing read in the
 * other business left in the cache.
 */
function BusinessScope({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  useEffect(() => onBusinessChange(() => client.clear()), [client]);
  const business = useSyncExternalStore(onBusinessChange, currentBusiness, currentBusiness);
  return <Fragment key={business ?? 'default'}>{children}</Fragment>;
}

/**
 * The business switcher: a Businesses screen (`/businesses`) listing every business the person is
 * in, as a member or a participant, shown in the navigation when there is more than one. The
 * choice is kept per person on the device and sent as `x-tenant-id` on every API and chat call;
 * a choice the server no longer accepts (they left that business) falls back to their default.
 * List it in `<AppShell plugins>`.
 */
export const businessesPlugin: AppPlugin = {
  name: 'businesses',
  Provider: BusinessScope,
  routes: [{ path: '/businesses', screen: BusinessesScreen }],
  nav: [destination],
  onSignedIn: async (user) => {
    businessOf(user.id);
    if (!currentBusiness()) return;
    try {
      await api.me();
    } catch (e) {
      // Not in that business any more: back to the server's default.
      if (e instanceof ApiError && e.status === 403) chooseBusiness(null);
      else throw e;
    }
  },
  useNav: (items) => {
    const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), staleTime: 60_000 });
    const several = (me.data?.businesses.length ?? 0) > 1;
    return several ? items : items.filter((i) => i.href !== destination.href);
  },
};
