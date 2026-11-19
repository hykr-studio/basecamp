import type { MeetingView } from '@application/domain/contracts';
import { colors, styles } from '@hykr/app';
import { Badge, Text } from '@hykr/app/ui';
import { Text as RNText, StyleSheet, View } from 'react-native';

/** A meeting that already started and is not closed: its real job now is to be closed. */
export const needsClosing = (m: { status: string; startsAt: string }) =>
  m.status !== 'closed' && new Date(m.startsAt).getTime() <= Date.now();

/** Status as the person needs it, as a badge in the chat's views (StatusBadge below in rows). */
export function MeetingStatus({ meeting }: { meeting: MeetingView }) {
  if (needsClosing(meeting))
    return (
      <Badge variant="warn">
        <Text>Needs closing</Text>
      </Badge>
    );
  if (meeting.status === 'closed')
    return (
      <Badge>
        <Text>Closed</Text>
      </Badge>
    );
  if (meeting.status === 'held')
    return (
      <Badge variant="info">
        <Text>Held</Text>
      </Badge>
    );
  return (
    <Badge variant="success">
      <Text>Upcoming</Text>
    </Badge>
  );
}

/** Status as the person needs it: a past meeting that is still open says so. */
export function StatusBadge({ meeting }: { meeting: { status: string; startsAt: string } }) {
  const pending = needsClosing(meeting);
  const [label, fg, bg] = pending
    ? ['Needs closing', colors.warnText, colors.warnBg]
    : meeting.status === 'closed'
      ? ['Closed', colors.muted, colors.agentBubble]
      : meeting.status === 'held'
        ? ['Held', colors.primary, colors.primaryTint]
        : ['Upcoming', colors.success, colors.successTint];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <RNText style={[styles.muted, { color: fg, fontWeight: '600' }]}>{label}</RNText>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
});
