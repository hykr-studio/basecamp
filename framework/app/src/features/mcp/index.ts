import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { ConnectionsScreen } from './ConnectionsScreen';

export { ConnectionsScreen } from './ConnectionsScreen';
export { scopeWords } from './scopes';

const destination: NavItem = {
  href: '/connections',
  label: 'Connected apps',
  icon: 'link',
  match: (path) => path === '/connections',
};

/**
 * The outside AI clients (Claude, ChatGPT, an IDE) the person connected over MCP, and
 * disconnecting them (`/connections`). Every signed-in person has their own. List it in
 * `<AppShell plugins>`.
 */
export const connectionsPlugin: AppPlugin = {
  name: 'connections',
  routes: [{ path: '/connections', screen: ConnectionsScreen }],
  nav: [destination],
};
