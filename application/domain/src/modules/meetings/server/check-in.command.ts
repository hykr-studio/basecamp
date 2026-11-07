import { allow, defineCommand, deny, withinMeters } from '@hykr/core';
import { CHECK_IN_RADIUS_M, CheckInSpec } from '../contracts/index.js';
import { Meeting } from './meeting.entity.js';
import { MeetingCheckIn } from './meeting-check-in.entity.js';

/**
 * Check in at a meeting where you are. The server measures (PostGIS, the same spheroid as the
 * `near` filter): within CHECK_IN_RADIUS_M of the meeting's point, with a fix at least that
 * precise. The device's position is what the person sends; the check-in keeps it as evidence.
 */
export const CheckIn = defineCommand(CheckInSpec, {
  resource: { type: 'meeting', id: (input) => input.meetingId },
  // The meeting through its scoped repository (404 if not theirs), measured in the transaction.
  load: async (tx, p, input) => {
    const meeting = await Meeting.repo.get(tx, p, input.meetingId);
    const fence = meeting.location
      ? await withinMeters(tx, input.at, meeting.location, CHECK_IN_RADIUS_M)
      : null;
    return { meeting, fence };
  },
  authorize: (_p, { meeting, fence }, input) => {
    if (meeting.status === 'closed')
      return deny('closed_is_final', `${meeting.title} is closed: there is nothing to check in to`);
    if (!fence) return deny('no_place', `${meeting.title} has no place on the map to check in at`);
    if ((input.accuracyM ?? 0) > CHECK_IN_RADIUS_M)
      return deny(
        'imprecise_location',
        `Your position is only good to ${Math.round(input.accuracyM ?? 0)} m; checking in needs ${CHECK_IN_RADIUS_M} m. Try again outdoors.`,
      );
    if (!fence.inside)
      return deny(
        'outside_geofence',
        `You are ${Math.round(fence.distanceM)} m from ${meeting.title}; check in within ${CHECK_IN_RADIUS_M} m`,
      );
    return allow('within_geofence');
  },
  summarize: (_input, { meeting }) => `Check in at ${meeting.title}`,
  run: async ({ tx, principal, input, loaded: { meeting, fence }, via }) => {
    const checkIn = await MeetingCheckIn.repo.insert(
      tx,
      principal,
      {
        meetingId: meeting.id,
        location: input.at,
        distanceM: fence?.distanceM ?? 0,
        accuracyM: input.accuracyM ?? null,
      },
      via,
    );
    return {
      value: checkIn,
      touched: [{ type: 'meetingCheckIn', id: checkIn.id, change: 'created', after: checkIn }],
    };
  },
});
