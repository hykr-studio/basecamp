/**
 * The meetings module, server side: meetings with a time and attendees, closed into a summary
 * note and to-dos, or moved with their open to-dos. Builds on the to-dos and notes modules.
 */
import { defineModule } from '@hykr/api';
import { meetingsAgent } from './agent/index.js';
import { HouseholdRole, meetingsSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { meetingsNotifications } from './notifications/index.js';
import { MeetingsModule } from './server/meetings.module.js';
import { meetingsViews } from './views/index.js';

export const meetings = defineModule({
  ...meetingsSpec,
  server: MeetingsModule,
  views: meetingsViews.views,
  screens: meetingsViews.screens,
  templates: meetingsNotifications.templates,
  notifications: meetingsNotifications.notifications,
  agent: meetingsAgent,
  tables,
  // People of a customer's household the business puts on a meeting: they read it.
  contributes: { participantRoles: [HouseholdRole] },
});
