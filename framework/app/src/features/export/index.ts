// Exporting a business's data in the app (A11X): the export screen, its destination for the
// people who may export, and the hooks under it.
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { ExportScreen } from './ExportScreen';
import { useCanExport } from './hooks';

export { ExportScreen } from './ExportScreen';
export { useCanExport, useExports, useStartExport } from './hooks';

const destination: NavItem = {
  href: '/export',
  label: 'Export data',
  icon: 'download',
  match: (path) => path === '/export',
};

/**
 * The export screen (`/export`) and its destination, shown to people whose roles hold
 * `data.export`. List it in `<AppShell plugins>`.
 */
export const exportPlugin: AppPlugin = {
  name: 'export',
  routes: [{ path: '/export', screen: ExportScreen }],
  nav: [destination],
  useNav: (items) => {
    const may = useCanExport();
    return may ? items : items.filter((i) => i.href !== destination.href);
  },
};
