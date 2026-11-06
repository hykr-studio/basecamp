/**
 * The orders module, server side: orders with a tree of groups and priced lines, money in
 * minor units, the module's own number series, tax function, approval limits and cost
 * capability.
 */
import { defineModule } from '@hykr/api';
import { ordersAgent } from './agent/index.js';
import { ordersSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { ordersNotifications } from './notifications/index.js';
import { costHidden, OrdersCostRead } from './server/cost.js';
import { OrdersModule } from './server/orders.module.js';
import { OrdersApprove } from './server/policy.js';
import { OrderSeries } from './server/series.js';
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
  contributes: {
    numberSeries: [OrderSeries],
    capabilities: [OrdersApprove, OrdersCostRead],
    readProjectors: [costHidden],
  },
});
