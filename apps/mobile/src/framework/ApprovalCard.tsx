import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { colors, styles } from '../theme';
import { errorMessage, useApprovals } from './hooks';

/**
 * Everything waiting for this person, from any command or entity action: a delete the
 * assistant asked for, or a whole meeting close. It knows nothing about either.
 */
export function ApprovalCard({
  filter,
}: {
  filter?: (a: { action: string; resourceId: string | null }) => boolean;
}) {
  const { approvals, decide } = useApprovals();
  const shown = filter ? approvals.filter(filter) : approvals;
  if (shown.length === 0) return null;
  return (
    <View style={[styles.card, s.card]}>
      <Text style={styles.heading}>Waiting for your approval</Text>
      {shown.map((a) => (
        <View key={a.id} style={s.item}>
          <View style={{ flex: 1, gap: 2, minWidth: 220 }}>
            <Text style={styles.text}>{a.summary ?? a.action}</Text>
            <Text style={styles.muted}>
              {a.requestedBy === 'agent' ? 'Asked by the assistant' : 'Asked by you'} · {a.reason} ·
              expires {new Date(a.expiresAt).toLocaleString()}
            </Text>
          </View>
          <Button
            title="Approve"
            onPress={() => decide.mutate({ id: a.id, approve: true })}
            busy={decide.isPending && decide.variables?.id === a.id && decide.variables.approve}
          />
          <Button
            title="Reject"
            variant="ghost"
            onPress={() => decide.mutate({ id: a.id, approve: false })}
            disabled={decide.isPending}
          />
        </View>
      ))}
      {decide.error && <Text style={styles.error}>{errorMessage(decide.error)}</Text>}
      {decide.data?.status === 'failed' && (
        <Text style={styles.error}>It could not be done: {decide.data.failureReason}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
