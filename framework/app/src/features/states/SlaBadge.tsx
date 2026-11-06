import type { SlaTimer } from '@hykr/contracts';
import { Text, View } from 'react-native';
import { Icon } from '../../framework/Icon';
import { colors, space, styles } from '../../theme';
import { useSlaTimers } from './hooks';

/** "3 h", "2 d", "25 min": a length of time in a few characters. */
function span(ms: number): string {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** One clock in words: due in, overdue by, or how it ended. */
function line(t: SlaTimer, now: number): { text: string; late: boolean } {
  const due = new Date(t.dueAt).getTime();
  if (t.status === 'running')
    return due > now
      ? { text: `Due in ${span(due - now)} (${when(t.dueAt)})`, late: false }
      : { text: `Overdue by ${span(now - due)}`, late: true };
  if (t.status === 'breached')
    return {
      text: `Overdue since ${when(t.breachedAt ?? t.dueAt)}${t.escalationError ? ` · ${t.escalationError}` : ''}`,
      late: true,
    };
  return { text: t.status === 'met' ? 'Met in time' : 'Stopped', late: false };
}

/**
 * A record's SLA clocks: the ones running (due in, or overdue) and the ones breached. With
 * `all`, also those met or stopped. Nothing when the record has none.
 */
export function SlaBadge({
  plural,
  id,
  all = false,
}: {
  plural: string;
  id: string;
  all?: boolean;
}) {
  const q = useSlaTimers(plural, id);
  const now = Date.now();
  const shown = (q.data ?? []).filter(
    (t) => all || t.status === 'running' || t.status === 'breached',
  );
  if (!shown.length) return null;
  return (
    <View style={{ gap: space.xs }}>
      {shown.map((t) => {
        const l = line(t, now);
        return (
          <View key={t.id} style={styles.row} accessibilityLabel={l.text}>
            <Icon
              name={l.late ? 'alert-circle' : 'clock'}
              size={14}
              color={l.late ? colors.danger : colors.muted}
            />
            <Text style={[styles.muted, l.late ? { color: colors.danger } : null]}>{l.text}</Text>
          </View>
        );
      })}
    </View>
  );
}
