// Calendars (decisions B17): schedulable records in people's own Google calendars (per-person
// OAuth, push channels through the integration bus), invites by email with an .ics, private
// feeds, and busy and free time.

import {
  CHANGED_EVENT,
  GOOGLE_CALENDAR_CONNECTOR,
  googleCalendarConnector,
} from '@hykr/connectors/google-calendar';
import { CalendarCapabilities } from '@hykr/contracts';
import { commandController, commandHandler } from '@hykr/core';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { defineConnectorHandler } from '../integrations/registry.js';
import { CalendarController, CalendarPublicController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { INVITES_QUEUE, type InviteJob, InvitesService, SendInvite } from './invites.js';
import { CalendarLocks } from './lock.js';
import './routes.js';
import { schedulable } from './schedulable.js';
import { CalendarSyncService, SYNC_QUEUE, type SyncJob } from './sync.service.js';
import { calendarTools } from './tools.js';

const lastTry = (job: { attemptsMade: number; opts: { attempts?: number } }) =>
  job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Records into calendars, a new connection filled, and the schedule's upkeep. */
export const CalendarSyncQueue = defineQueue<SyncJob, string>({
  name: SYNC_QUEUE,
  concurrency: 4,
  attempts: 5,
  backoffMs: 5000,
  process: (job, ctx) => ctx.get(CalendarSyncService).run(job.data),
});

/** Invite emails: requests, updates and cancellations. */
export const CalendarInvitesQueue = defineQueue<InviteJob, string>({
  name: INVITES_QUEUE,
  concurrency: 4,
  attempts: 3,
  backoffMs: 3000,
  process: (job, ctx) => ctx.get(InvitesService).run(job.data, lastTry(job)),
});

/** Every ten minutes: channels renewed, calendars without one looked at. */
export const CalendarMaintain = defineSchedule({
  name: 'calendar.maintain',
  queue: SYNC_QUEUE,
  every: 10 * 60_000,
  data: { kind: 'maintain' },
});

/** Any stored event about a schedulable record: its calendars and its invites follow. */
export const CalendarRecords = defineSubscriber({
  name: 'calendar.records',
  on: ['*'],
  when: (event) => !!event.resourceId && !!schedulable(event.resourceType),
  handle: async (event, ctx) => {
    const id = event.resourceId as string;
    await ctx
      .get(CalendarSyncService)
      .queueRecord(event.tenantId, event.resourceType, id, event.id);
    await ctx.get(InvitesService).queueFollow(event.tenantId, event.resourceType, id, event.id);
  },
});

/** A calendar connected: open its channel and fill it. */
export const CalendarConnected = defineSubscriber({
  name: 'calendar.connected',
  on: ['calendar.connected'],
  handle: async (event, ctx) => {
    if (event.resourceId)
      await ctx.get(CalendarSyncService).queueConnected(event.resourceId, event.id);
  },
});

/** An invite asked for: send it. */
export const CalendarInviteRequested = defineSubscriber({
  name: 'calendar.invites',
  on: ['calendar.invite_requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(InvitesService).queueSend(event.resourceId, event.id);
  },
});

/** Google's notice that a connected calendar changed: read what changed, as the system. */
export const GoogleCalendarChanges = defineConnectorHandler({
  name: 'calendar.google-changes',
  connector: GOOGLE_CALENDAR_CONNECTOR,
  on: [CHANGED_EVENT],
  handle: async (event, ctx) => {
    const connectionId = ctx.connection.public.calendarConnectionId;
    if (typeof connectionId !== 'string') return;
    const data = (event.data ?? {}) as { channelId?: string };
    await ctx.get(CalendarSyncService).pullChanges(connectionId, {
      tenantId: event.tenantId,
      channelId: data.channelId,
    });
  },
});

export const calendarFeature = defineFeature({
  name: 'calendar',
  controllers: [CalendarController, CalendarPublicController, commandController(SendInvite)],
  providers: [
    CalendarLocks,
    CalendarService,
    CalendarSyncService,
    InvitesService,
    commandHandler(SendInvite),
  ],
  exports: [CalendarService, CalendarSyncService, InvitesService],
  contributes: {
    capabilities: [CalendarCapabilities.availability],
    connectors: [googleCalendarConnector],
    connectorHandlers: [GoogleCalendarChanges],
    queues: [CalendarSyncQueue, CalendarInvitesQueue],
    schedules: [CalendarMaintain],
    subscribers: [CalendarRecords, CalendarConnected, CalendarInviteRequested],
    toolContributions: [calendarTools],
  },
});
