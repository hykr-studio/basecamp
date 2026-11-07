// The person's own requests about their personal data in the app (B18): the "Your data" screen,
// its destination, and the hooks under it.
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { PrivacyScreen } from './PrivacyScreen';

export { useFilePrivacyRequest, useMyPrivacyRequests } from './hooks';
export { PrivacyScreen } from './PrivacyScreen';

const destination: NavItem = {
  href: '/privacy',
  label: 'Your data',
  icon: 'shield',
  match: (path) => path === '/privacy',
};

/**
 * The "Your data" screen (`/privacy`) and its destination, for everyone signed in: a copy of
 * their data, erasure, and their requests. List it in `<AppShell plugins>`.
 */
export const privacyPlugin: AppPlugin = {
  name: 'privacy',
  routes: [{ path: '/privacy', screen: PrivacyScreen }],
  nav: [destination],
};
