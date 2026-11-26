import {
  AssistantActivity,
  BrandMark,
  Button,
  DecisionScrollView,
  dayBounds,
  LoadError,
  listRow,
  OverdueList,
  ScreenTitle,
  SectionHeading,
  space,
  styles,
  TryPrompt,
  todayLocal,
  useApprovals,
  useBranding,
  useEntityList,
  useScreenContext,
  WaitingForYou,
} from '@hykr/app';
import { router } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import { MeetingRow, needsClosing as toClose } from '@/modules/meetings';
import { TodoRow } from '@/modules/todos';
import { settings } from '@/settings';

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

/**
 * The business's logo and name (its branding settings, white label) over its day. Nothing when
 * it has neither: the product's name is already in the shell.
 */
function Business() {
  const brand = useBranding();
  if (!brand?.name && !brand?.logoUrl) return null;
  return <BrandMark fallback={settings.title} />;
}

/**
 * Today: what waits for your decision, what the assistant did, then the day itself (its
 * meetings, those still to close, and what is due). The first two are the framework's. The
 * application's own screen: it combines the meetings and to-dos modules. What the assistant did
 * links each record where its module opens it.
 */
export function Today() {
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
      what="The assistant drafts the close; nothing changes until it is approved."
    />
  );

  const activity = <AssistantActivity ask="add Book the site visit" />;

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
    <DecisionScrollView contentContainerStyle={styles.content}>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Business />
          <ScreenTitle title="Today" subtitle={date} />
        </View>
        {wide ? (
          // Reading order matches what you see: the day on the left, the assistant beside it.
          <View style={{ flexDirection: 'row', gap: space.xxl, alignItems: 'flex-start' }}>
            <View style={{ flex: 3, minWidth: 0, gap: space.xl }}>
              <WaitingForYou place="Today" />
              <OverdueList />
              {today}
              {needsClosing}
              {due}
            </View>
            <View style={{ flex: 2, minWidth: 0 }}>{activity}</View>
          </View>
        ) : (
          <>
            <WaitingForYou place="Today" />
            <OverdueList />
            {activity}
            {today}
            {needsClosing}
            {due}
          </>
        )}
      </View>
    </DecisionScrollView>
  );
}
