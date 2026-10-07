import { ScrollView, Text, View } from 'react-native';
import { MeetingRow, TodoRow } from '../../components/Rows';
import { useScreenContext } from '../../framework/assistant-context';
import { dayBounds, todayLocal } from '../../framework/dates';
import { useEntityList } from '../../framework/hooks';
import { styles } from '../../theme';

/** Today: meetings starting today, to-dos due today or overdue. Approvals sit above every screen. */
export default function Today() {
  useScreenContext({ screen: 'today' });
  const meetings = useEntityList('meetings', { startsAt: dayBounds(), sort: 'startsAt' });
  const todos = useEntityList('todos', {
    done: false,
    dueOn: { lte: todayLocal() },
    sort: 'dueOn',
  });
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.heading}>Meetings today</Text>
        {meetings.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : meetings.items.length === 0 ? (
          <Text style={styles.muted}>No meetings today.</Text>
        ) : (
          meetings.items.map((m) => <MeetingRow key={m.id} meeting={m} />)
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>Due today or overdue</Text>
        {todos.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : todos.items.length === 0 ? (
          <Text style={styles.muted}>Nothing due.</Text>
        ) : (
          todos.items.map((t) => <TodoRow key={t.id} todo={t} />)
        )}
      </View>
    </ScrollView>
  );
}
