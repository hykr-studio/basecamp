import { MeetingSpec, type MeetingStatus } from '@app/contracts';
import { defineEntity, deny } from '@app/core';
import { meetings } from '@app/db';
import { BUSINESS_ACCESS } from '../access.js';

const order: MeetingStatus[] = ['scheduled', 'held', 'closed'];

export const Meeting = defineEntity(MeetingSpec, {
  table: meetings,
  owner: (t) => t.ownerId,
  // Who reaches which meetings: the owner theirs, ops and admins the whole business, a
  // customer (on WhatsApp, or with an account) the ones that are theirs.
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  rules: [
    // Domain rules run after the framework's owner and expose checks.
    (_p, action, row, input) =>
      action === 'update' && row?.status === 'closed' && input?.status !== undefined
        ? deny('closed_is_final', 'A closed meeting cannot change status')
        : null,
    (_p, action, row, input) =>
      action === 'update' &&
      row &&
      input?.status &&
      order.indexOf(input.status as MeetingStatus) < order.indexOf(row.status)
        ? deny('status_forward_only', 'A meeting moves scheduled → held → closed, never back')
        : null,
    // Closing writes a note and to-dos; a bare PATCH would skip them.
    (_p, action, _row, input, ctx) =>
      action === 'update' && input?.status === 'closed' && ctx.via !== 'meeting.close'
        ? deny(
            'use_close_meeting',
            'Close a meeting with close-meeting, so its summary and to-dos are written',
          )
        : null,
  ],
});
