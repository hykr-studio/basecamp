/**
 * The orders module, server side: orders with a tree of groups and priced lines, money in
 * minor units, the module's own number series, tax function, approval limits, cost capability,
 * its PDF (orders.order), its customer's acceptance of that PDF by a one-time code (which moves
 * the order to `accepted` and places it: `order.placed`), the approval level of a comment a
 * customer will see, its share link (the order shown by link), and its supplier's connector
 * (a supplier's system reports an order fulfilled).
 */
import { defineModule } from '@hykr/api';
import { ordersAgent } from './agent/index.js';
import { ordersSpec, SupplierRole } from './contracts/index.js';
import * as tables from './db/schema.js';
import { ordersNotifications } from './notifications/index.js';
import { OrderAcceptance } from './server/acceptance.js';
import { OrderCommentLevels } from './server/comment-levels.js';
import { SupplierConnector, SupplierFulfilled } from './server/connector.js';
import { costHidden, OrdersCostRead } from './server/cost.js';
import { OrderDocument } from './server/document.js';
import { OrdersModule } from './server/orders.module.js';
import { OrdersApprove } from './server/policy.js';
import { OrderSeries } from './server/series.js';
import { OrderShare } from './server/share.js';
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
    // Also what keeps a line's cost out of order.placed, for a webhook endpoint without it.
    readProjectors: [costHidden],
    documents: [OrderDocument],
    acceptances: [OrderAcceptance],
    levelRules: [OrderCommentLevels],
    // The organisation an order is placed with: it reads the order, not its cost.
    participantRoles: [SupplierRole],
    // Shown by link to its customer: the order, its lines, its PDF and its acceptance.
    shareables: [OrderShare],
    // A supplier's own system, signed: it reports an order it supplies fulfilled.
    connectors: [SupplierConnector],
    connectorHandlers: [SupplierFulfilled],
  },
});
