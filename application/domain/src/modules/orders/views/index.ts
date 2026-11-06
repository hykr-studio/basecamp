/** The orders module's views and screens. Isomorphic. */
import type { UiPart, ViewDef } from '@hykr/ui-registry';
import { OrderListView } from './order.js';

export * from './order.js';

export const ordersViews: UiPart = {
  name: 'orders',
  views: [OrderListView] as unknown as readonly ViewDef[],
  screens: [],
};
