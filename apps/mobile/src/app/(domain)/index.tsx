import { router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle, SectionHeading } from '../../components/ScreenTitle';
import { MeetingRow, TodoRow } from '../../domain/components/Rows';
import { needsClosing as toClose } from '../../domain/meetings';
import { AssistantActivity } from '../../framework/AssistantActivity';
import { useScreenContext } from '../../framework/assistant-context';
import { dayBounds, todayLocal } from '../../framework/dates';
import { LoadError } from '../../framework/EmptyState';
import { useApprovals, useEntityList } from '../../framework/hooks';
import { TryPrompt } from '../../framework/TryPrompt';
import { WaitingForYou } from '../../framework/WaitingForYou';
import { listRow, space, styles } from '../../theme';

/** Below this width the sections stack; above it, what the assistant did sits beside the day. */
const TWO_COLUMNS = 720;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionHeading>{title}</SectionHeading>
      {children}
    </View>
  );
}

/** A section with nothing in it: one quiet line, the direct action, and what to ask instead. */
function Quiet({
  line,
  action,
  ask,
}: {
  line: string;
  action?: { label: string; onPress: () => void };
  ask: string;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.muted}>{line}</Text>
      <View style={[styles.row, { flexWrap: 'wrap', columnGap: space.lg }]}>
        {action && <Button title={action.label} variant="secondary" onPress={action.onPress} />}
        <TryPrompt text={ask} />
      </View>
    </View>
  );
}

/** A record the assistant touched, opened where it lives (meetings have their own page). */
const hrefFor = (type: string, id: string) => {
  if (type === 'meeting') return `/meetings/${id}`;
  if (type === 'todo') return '/todos';
  if (type === 'note') return '/notes';
  return undefined;
};

/**
 * Today: what waits for your decision, what the assistant did, then the day itself (its
 * meetings, those still to close, and what is due). The first two are the framework's.
 */
export default function Today() {
  useScreenContext({ screen: 'today' });
  const [width, setWidth] = useState(0);
  const wide = width >= TWO_COLUMNS;
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

  // The first meeting still to close, today's or earlier: the assistant can draft it.
  // Not once its close already waits for a decision.
  const { approvals } = useApprovals();
  const open = (m: { id: string }) => !approvals.some((a) => a.resourceId === m.id);
  const closeToday = meetings.items.find((m) => toClose(m) && open(m));
  const closeable = closeToday ?? pending.items.find(open);
  const closePrompt = closeable && (
    <TryPrompt
      text={`close ${closeable.title}`}
      what="The assistant drafts the close; nothing changes until you approve it."
    />
  );

  const activity = <AssistantActivity hrefFor={hrefFor} ask="add Book the site visit" />;

  const needsClosing = pending.items.length > 0 && (
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
      {!closeToday && closePrompt}
    </Section>
  );

  const today = (
    <Section title="Meetings today">
      {meetings.error ? (
        <LoadError what="today's meetings" onRetry={meetings.refresh} />
      ) : meetings.loading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : meetings.items.length === 0 ? (
        <Quiet
          line="No meetings today."
          action={{ label: 'Plan a meeting', onPress: () => router.navigate('/meetings?new=1') }}
          ask="plan my week"
        />
      ) : (
        <>
          <View>
            {meetings.items.map((m, i) => (
              <View key={m.id} style={listRow(i, meetings.items.length)}>
                <MeetingRow meeting={m} />
              </View>
            ))}
          </View>
          {/* Once, under whichever list holds the meeting to close. */}
          {closeToday && closePrompt}
        </>
      )}
    </Section>
  );

  const due = (
    <Section title="Due today or overdue">
      {todos.error ? (
        <LoadError what="your to-dos" onRetry={todos.refresh} />
      ) : todos.loading ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : todos.items.length === 0 ? (
        <Quiet
          line="Nothing due. Nicely done."
          action={{ label: 'See all to-dos', onPress: () => router.navigate('/todos') }}
          ask="what's due this week"
        />
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
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.xl }}>
        <ScreenTitle title="Today" subtitle={date} />
        {wide ? (
          // Reading order matches what you see: the day on the left, the assistant beside it.
          <View style={{ flexDirection: 'row', gap: space.xxl, alignItems: 'flex-start' }}>
            <View style={{ flex: 3, minWidth: 0, gap: space.xl }}>
              <WaitingForYou />
              {today}
              {needsClosing}
              {due}
            </View>
            <View style={{ flex: 2, minWidth: 0 }}>{activity}</View>
          </View>
        ) : (
          <>
            <WaitingForYou />
            {activity}
            {today}
            {needsClosing}
            {due}
          </>
        )}
      </View>
    </ScrollView>
  );
}
