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
import { JoinScreen } from './JoinForm';
import { JOIN_PATH, showsBusinesses } from './join';

export { BusinessesScreen } from './BusinessesScreen';
export { JoinForm, JoinScreen } from './JoinForm';
export { JOIN_PATH } from './join';

const destination: NavItem = {
  href: '/businesses',
  label: 'Businesses',
  icon: 'briefcase',
  match: (path) => path === '/businesses' || path === JOIN_PATH,
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
 * in, as a member or a participant, with a way to join another by invitation, shown in the
 * navigation when there are several or none. An invitation link opens `/businesses/join?token=…`
 * (a party's or the team's). The choice is kept per person on the device and sent as
 * `x-tenant-id` on every API and chat call; a choice the server no longer accepts (they left
 * that business) falls back to their default. List it in `<AppShell plugins>`.
 */
export const businessesPlugin: AppPlugin = {
  name: 'businesses',
  Provider: BusinessScope,
  routes: [
    { path: '/businesses', screen: BusinessesScreen },
    { path: JOIN_PATH, screen: JoinScreen },
  ],
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
    return showsBusinesses(me.data?.businesses.length)
      ? items
      : items.filter((i) => i.href !== destination.href);
  },
};
