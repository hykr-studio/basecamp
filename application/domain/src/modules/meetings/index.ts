/**
 * The meetings module, server side: meetings with a time and attendees, closed into a summary
 * note and to-dos, or moved with their open to-dos. Builds on the to-dos and notes modules, and
 * offers two ready-made agents.
 */
import { defineModule } from '@hykr/api';
import { meetingsAgent } from './agent/index.js';
import { meetingsAgentTemplates } from './agent/templates.js';
import { HouseholdRole, meetingsSpec } from './contracts/index.js';
import * as tables from './db/schema.js';
import { meetingsNotifications } from './notifications/index.js';
import { MeetingMovedInCalendar } from './server/calendar-moved.subscriber.js';
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
  contributes: {
    // Ready-made agents for a business: a Monday summary, a follow-up when a meeting closes (A6).
    agentTemplates: meetingsAgentTemplates,
    // People of a customer's household the business puts on a meeting: they read it.
    participantRoles: [HouseholdRole],
    // A meeting its owner moves in their connected calendar moves here too.
    subscribers: [MeetingMovedInCalendar],
  },
});
