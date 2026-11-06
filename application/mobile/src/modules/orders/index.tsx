/**
 * The orders module, app side: its destination, what to ask about orders, its view and screen
 * components, and where an order opens. Other code imports this file only, never a file under
 * it.
 */

import {
  OrderCardView,
  OrderDetailScreen,
  OrderListView,
} from '@application/domain/modules/orders/views';
import { defineAppModule } from '@hykr/app';
import { bindScreen, bindView } from '@hykr/ui-registry/react';
import { OrderDetail } from './screens/OrderDetail';
import { OrderCardComponent, OrderListComponent } from './views';

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
  suggestions: [
    {
      text: 'order <title>: 2 <item> at 1500, 1 <item> at 800 +18%',
      what: 'saves a whole order; waits for your approval',
    },
    { text: 'list orders', what: 'your orders, with their totals' },
  ],
  bind: () => {
    bindView(OrderListView, OrderListComponent);
    bindView(OrderCardView, OrderCardComponent);
    // The canvas shows the same screen as the route.
    bindScreen(OrderDetailScreen, ({ id }) => <OrderDetail id={id} embedded />);
  },
  hrefFor: { order: (id) => `/orders/${id}` },
  webmcp: {
    orders: { reads: ['orders'] },
    order: { reads: ['orders', 'orderItems'] },
  },
});
