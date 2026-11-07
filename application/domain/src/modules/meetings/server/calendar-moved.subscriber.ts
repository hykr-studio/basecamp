import { defineSubscriber, memberPrincipal, writeAs } from '@hykr/api';
import { CalendarEventChange } from '@hykr/contracts';
import { RescheduleMeeting } from './reschedule-meeting.command.js';

/**
 * The module's answer to a meeting moved in its owner's own calendar (the framework only reports
 * it): the meeting moves too, as that person, through `meeting.reschedule`, so its open to-dos
 * shift with it and the history says who moved it. A meeting they may no longer change, or one
 * that is closed, stays where it is.
 */
export const MeetingMovedInCalendar = defineSubscriber({
  name: 'meetings.calendar-moved',
  on: ['calendar.event_moved'],
  when: (event) => (event.row as { entity?: string } | null)?.entity === 'meeting',
  handle: async (event, ctx) => {
    const change = CalendarEventChange.safeParse(event.row);
    if (!change.success || !change.data.startsAt || !change.data.endsAt) return;
    const { userId, tenantId, recordId, startsAt, endsAt } = change.data;
    const principal = await memberPrincipal(ctx.get, { userId, tenantId });
    if (!principal) return;
    await writeAs(
      ctx,
      {
        principal,
        requestId: `calendar-${event.id}`,
        idempotencyKey: `calendar-moved:${event.id}`,
      },
      RescheduleMeeting.op(),
      { meetingId: recordId, startsAt, endsAt },
    ).catch((e) => {
      // A refusal (closed, gone, not theirs) is the answer; anything else is tried again.
      const status = (e as { getStatus?: () => number }).getStatus?.();
      if (!status || status >= 500) throw e;
    });
  },
});
