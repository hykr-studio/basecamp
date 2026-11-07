/**
 * The orders module, server side: orders with a tree of groups and priced lines, money in
 * minor units, the module's own number series, tax function, approval limits, cost capability,
 * its PDF (orders.order), its customer's acceptance of that PDF by a one-time code, and the
 * approval level of a comment a customer will see.
 */
import { defineModule } from '@hykr/api';
import { ordersAgent } from './agent/index.js';
import { ordersSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { ordersNotifications } from './notifications/index.js';
import { OrderAcceptance } from './server/acceptance.js';
import { OrderCommentLevels } from './server/comment-levels.js';
import { costHidden, OrdersCostRead } from './server/cost.js';
import { OrderDocument } from './server/document.js';
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
    documents: [OrderDocument],
    acceptances: [OrderAcceptance],
    levelRules: [OrderCommentLevels],
  },
});
