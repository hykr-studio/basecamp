// The business's integrations in the app (B21): its connections and connecting one by signing
// in (`/integrations`, where providers send the browser back), with the hooks under it.
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { useCanManageIntegrations } from './hooks';
import { IntegrationsScreen } from './IntegrationsScreen';

export {
  INTEGRATIONS_MANAGE,
  useCanManageIntegrations,
  useCompleteSignIn,
  useConnections,
  useConnectors,
  useDisconnect,
  usePickAccounts,
  useStartSignIn,
} from './hooks';
export { IntegrationsScreen } from './IntegrationsScreen';

const destination: NavItem = {
  href: '/integrations',
  label: 'Integrations',
  icon: 'link',
  match: (path) => path === '/integrations' || path.startsWith('/integrations/'),
};

/**
 * The integrations screen (`/integrations`) and its destination, shown to people whose roles
 * hold `integrations.manage`. List it in `<AppShell plugins>`.
 */
export const integrationsPlugin = (): AppPlugin => ({
  name: 'integrations',
  routes: [{ path: '/integrations', screen: IntegrationsScreen }],
  nav: [destination],
  useNav: (items) => {
    const may = useCanManageIntegrations();
    return may ? items : items.filter((i) => i.href !== destination.href);
  },
});
