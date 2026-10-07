import type { Approval } from '@app/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { colors, styles } from '../theme';
import { Button } from './Button';

type Props = {
  approvals: Approval[];
  busyId: string | null;
  onDecide: (id: string, approve: boolean) => void;
};

/** What the assistant asked to do and is waiting on you for. Hidden when there is nothing. */
export function Approvals({ approvals, busyId, onDecide }: Props) {
  if (approvals.length === 0) return null;
  return (
    <View style={[styles.card, s.card]}>
      <Text style={styles.heading}>Waiting for your approval</Text>
      {approvals.map((a) => (
        <View key={a.id} style={s.item}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.text}>{a.summary ?? a.action}</Text>
            <Text style={styles.muted}>
              {a.reason} · expires {new Date(a.expiresAt).toLocaleString()}
            </Text>
          </View>
          <Button title="Approve" onPress={() => onDecide(a.id, true)} busy={busyId === a.id} />
          <Button
            title="Reject"
            variant="ghost"
            onPress={() => onDecide(a.id, false)}
            disabled={busyId === a.id}
          />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.warnBg, borderColor: colors.warnBorder },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
