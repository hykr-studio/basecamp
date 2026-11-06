/** The orders module's views and screens. Isomorphic. */
import type { ScreenDef, UiPart, ViewDef } from '@hykr/ui-registry';
import { OrderCardView, OrderListView } from './order.js';
import { OrderDetailScreen } from './screens.js';

export * from './order.js';
export * from './screens.js';

export const ordersViews: UiPart = {
  name: 'orders',
  views: [OrderListView, OrderCardView] as unknown as readonly ViewDef[],
  screens: [OrderDetailScreen] as unknown as readonly ScreenDef[],
};
