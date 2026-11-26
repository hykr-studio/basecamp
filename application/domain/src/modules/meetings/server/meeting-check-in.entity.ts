import { defineEntity, deny } from '@hykr/core';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { MeetingCheckInSpec } from '../contracts/index.js';
import { meetingCheckIns } from '../db/schema.js';

/** Check-ins are the person's own; ops and admins see the business's. */
export const MeetingCheckIn = defineEntity(MeetingCheckInSpec, {
  table: meetingCheckIns,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  rules: [
    // Only meeting.check-in measures where the person is: nothing else writes one.
    (_p, action, _row, _input, ctx) =>
      action === 'create' && ctx.via !== 'meeting.check-in'
        ? deny('check_in_through_command', 'Check in with meeting.check-in')
        : null,
  ],
});
