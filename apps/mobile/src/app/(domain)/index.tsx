import { router } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { MeetingRow, TodoRow } from '../../domain/components/Rows';
import { useScreenContext } from '../../framework/assistant-context';
import { dayBounds, todayLocal } from '../../framework/dates';
import { EmptyState, LoadError } from '../../framework/EmptyState';
import { useEntityList } from '../../framework/hooks';
import { listRow, space, styles } from '../../theme';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionHeading>{title}</SectionHeading>
      {children}
    </View>
  );
}

/** Today: what needs closing, today's meetings, and what is due. Approvals sit above every screen. */
export default function Today() {
  useScreenContext({ screen: 'today' });
  const bounds = dayBounds();
  const pending = useEntityList('meetings', {
    status: { in: ['scheduled', 'held'] },
    startsAt: { lt: bounds.gte },
    sort: '-startsAt',
    limit: 5,
  });
  const meetings = useEntityList('meetings', { startsAt: bounds, sort: 'startsAt' });
  const todos = useEntityList('todos', {
    done: false,
    dueOn: { lte: todayLocal() },
    sort: 'dueOn',
  });
  const date = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScreenTitle title="Today" subtitle={date} />

      {pending.items.length > 0 && (
        <Section title="Needs closing">
          <Text style={styles.muted}>
            Earlier meetings without a summary. Close them to record what was agreed.
          </Text>
          <View>
            {pending.items.map((m, i) => (
              <View key={m.id} style={listRow(i, pending.items.length)}>
                <MeetingRow meeting={m} />
              </View>
            ))}
          </View>
        </Section>
      )}

      <Section title="Meetings today">
        {meetings.error ? (
          <LoadError what="today's meetings" onRetry={meetings.refresh} />
        ) : meetings.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : meetings.items.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="No meetings today"
            action={{ label: 'Plan a meeting', onPress: () => router.navigate('/meetings?new=1') }}
          />
        ) : (
          <View>
            {meetings.items.map((m, i) => (
              <View key={m.id} style={listRow(i, meetings.items.length)}>
                <MeetingRow meeting={m} />
              </View>
            ))}
          </View>
        )}
      </Section>

      <Section title="Due today or overdue">
        {todos.error ? (
          <LoadError what="your to-dos" onRetry={todos.refresh} />
        ) : todos.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : todos.items.length === 0 ? (
          <View style={{ gap: space.sm }}>
            <Text style={styles.muted}>Nothing due. Nicely done.</Text>
            <View style={styles.row}>
              <Button
                title="See all to-dos"
                variant="secondary"
                onPress={() => router.navigate('/todos')}
              />
            </View>
          </View>
        ) : (
          <View>
            {todos.items.map((t, i) => (
              <View key={t.id} style={listRow(i, todos.items.length)}>
                <TodoRow todo={t} />
              </View>
            ))}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}
