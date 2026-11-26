import { CHECK_IN_RADIUS_M, CheckInSpec, type MeetingView } from '@application/domain/contracts';
import {
  Button,
  errorMessage,
  LocationField,
  listRow,
  SectionHeading,
  space,
  styles,
  useCommand,
  useCurrentLocation,
  useEntityList,
  useEntityMutation,
  useToast,
  when,
} from '@hykr/app';
import { Text, View } from 'react-native';

/**
 * Where a meeting is held, and who checked in there. The place is set from the phone (its
 * position, and the address its geocoder finds); a check-in sends where the phone is, and the
 * server takes it only within CHECK_IN_RADIUS_M of the meeting.
 */
export function MeetingPlace({ meeting }: { meeting: MeetingView }) {
  const closed = meeting.status === 'closed';
  const { update } = useEntityMutation('meetings');
  const checkIn = useCommand(CheckInSpec);
  const here = useCurrentLocation({ accuracy: 'high' });
  const toast = useToast();
  const checkIns = useEntityList('meetingCheckIns', { meetingId: meeting.id, limit: 10 });

  const save = (patch: { location?: MeetingView['location']; address?: MeetingView['address'] }) =>
    update.mutate({ id: meeting.id, patch });

  const checkInHere = async () => {
    const fix = await here.locate();
    if (!fix) return;
    const result = await checkIn.mutateAsync({
      meetingId: meeting.id,
      at: fix.point,
      ...(fix.accuracyM !== null ? { accuracyM: fix.accuracyM } : {}),
    });
    if (result.status === 'done')
      toast.show({
        tone: 'success',
        message: `Checked in, ${Math.round(result.value.distanceM)} m from ${meeting.title}`,
      });
  };

  return (
    <View style={styles.section}>
      <SectionHeading>Place</SectionHeading>
      {closed ? (
        <Text style={styles.muted}>
          {meeting.location
            ? `${meeting.location.lat.toFixed(5)}, ${meeting.location.lng.toFixed(5)}`
            : 'No place was set.'}
        </Text>
      ) : (
        <LocationField
          label="Where it is held"
          value={meeting.location}
          onChange={(location) => save({ location })}
          address={meeting.address}
          onAddress={(address) => save({ address })}
          hint={`People check in within ${CHECK_IN_RADIUS_M} m of this point.`}
        />
      )}
      {update.error && <Text style={styles.error}>{errorMessage(update.error)}</Text>}
      {meeting.location && !closed ? (
        <View style={{ gap: space.xs }}>
          <View style={styles.row}>
            <Button
              title="Check in here"
              icon="check-circle"
              busy={here.busy || checkIn.isPending}
              onPress={checkInHere}
            />
          </View>
          {here.error && <Text style={styles.error}>{here.error}</Text>}
          {checkIn.error && <Text style={styles.error}>{errorMessage(checkIn.error)}</Text>}
        </View>
      ) : null}
      {checkIns.items.length ? (
        <View>
          {checkIns.items.map((c, i) => (
            <View key={c.id} style={listRow(i, checkIns.items.length)}>
              <Text style={styles.text}>
                {when(c.createdAt)} · {Math.round(c.distanceM)} m away
                {c.accuracyM !== null ? ` (±${Math.round(c.accuracyM)} m)` : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
