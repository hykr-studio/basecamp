/** The orders module, server side. */
import { defineModule } from '@hykr/api';
import { ordersAgent } from './agent/index.js';
import { ordersSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { ordersNotifications } from './notifications/index.js';
import { OrdersModule } from './server/orders.module.js';
import { ordersViews } from './views/index.js';

export const orders = defineModule({
  ...ordersSpec,
  server: OrdersModule,
  views: ordersViews.views,
  screens: ordersViews.screens,
  templates: ordersNotifications.templates,
  notifications: ordersNotifications.notifications,
  agent: ordersAgent,
  tables,
});
