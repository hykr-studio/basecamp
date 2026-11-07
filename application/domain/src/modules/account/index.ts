/**
 * The account module, server side: the business's account with the platform. Its credits are
 * the framework's (metered, capped, the wallet); this module words their alerts.
 */
import { defineModule } from '@hykr/api';
import { accountSpec } from './contracts/index.js';
import { accountNotifications } from './notifications/index.js';

export const account = defineModule({
  ...accountSpec,
  templates: accountNotifications.templates,
  notifications: accountNotifications.notifications,
});
