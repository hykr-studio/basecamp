/**
 * The orders module, app side: its destination and its views' components. Other code
 * imports this file only, never a file under it.
 */

import { OrderListView } from '@application/domain/modules/orders/views';
import { defineAppModule } from '@hykr/app';
import { bindView } from '@hykr/ui-registry/react';
import { OrderListComponent } from './views';

export const orders = defineAppModule({
  name: 'orders',
  nav: [
    {
      href: '/orders',
      label: 'Orders',
      icon: 'list',
      match: (path: string) => path.startsWith('/orders'),
    },
  ],
  suggestions: [],
  bind: () => {
    bindView(OrderListView, OrderListComponent);
  },
});
