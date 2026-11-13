import type { MeetingView } from '@application/domain/contracts';
import { clock, colors, Icon, space, styles, when } from '@hykr/app';
import { addressText } from '@hykr/contracts';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../status';

/** A meeting in a list: title, status and time; opens the meeting's page. */
export function MeetingRow({ meeting }: { meeting: MeetingView }) {
  return (
    <Link href={`/meetings/${meeting.id}`} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${meeting.title}, ${when(meeting.startsAt)}`}
        style={s.meeting}
      >
        <View style={{ flex: 1, gap: 2 }}>
          {/* Title and status share a line; the time gets the full width below, so it never wraps mid-time. */}
          <View style={[styles.row, { flexWrap: 'wrap', justifyContent: 'space-between' }]}>
            <Text style={[styles.text, { fontWeight: '600', flexShrink: 1 }]}>{meeting.title}</Text>
            <StatusBadge meeting={meeting} />
          </View>
          <Text style={styles.muted}>
            {when(meeting.startsAt)}–{clock(meeting.endsAt)}
            {meeting.attendees.length ? ` · ${meeting.attendees.join(', ')}` : ''}
          </Text>
          {meeting.address && (
            <Text style={styles.muted} numberOfLines={1}>
              {addressText(meeting.address)}
            </Text>
          )}
        </View>
        <Icon name="chevron-right" color={colors.muted} />
      </Pressable>
    </Link>
  );
}

const s = StyleSheet.create({
  meeting: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
});
