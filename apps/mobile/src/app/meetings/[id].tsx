import { ApiError } from '@app/api-client';
import { type MeetingView, RescheduleMeetingSpec } from '@app/contracts';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { CloseMeetingForm } from '../../components/CloseMeetingForm';
import { NoteRow, StatusBadge, TodoRow } from '../../components/Rows';
import { SectionHeading } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { DateField, TimeField } from '../../framework/DateField';
import { at, clock, isValidDate, isValidTime, when } from '../../framework/dates';
import { EmptyState } from '../../framework/EmptyState';
import { Field } from '../../framework/Field';
import { History } from '../../framework/History';
import {
  errorMessage,
  needsClosing,
  useCommand,
  useEntity,
  useEntityList,
  useEntityMutation,
} from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { useToast } from '../../framework/Toast';
import { colors, listRow, space, styles } from '../../theme';

function Reschedule({ meeting, onDone }: { meeting: MeetingView; onDone: () => void }) {
  const move = useCommand(RescheduleMeetingSpec);
  const toast = useToast();
  const start = new Date(meeting.startsAt);
  const [date, setDate] = useState(start.toLocaleDateString('sv'));
  const [time, setTime] = useState(start.toTimeString().slice(0, 5));
  const length = new Date(meeting.endsAt).getTime() - start.getTime();
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.heading}>Reschedule</Text>
        <Button title="Cancel" variant="subtle" onPress={onDone} />
      </View>
      <Text style={styles.muted}>Open to-dos with due dates move by the same number of days.</Text>
      <View style={[styles.row, { flexWrap: 'wrap', alignItems: 'flex-end' }]}>
        <DateField label="New date" value={date} onChange={setDate} />
        <TimeField label="Starts" value={time} onChange={setTime} />
        <Button
          title="Move meeting"
          busy={move.isPending}
          disabled={!isValidDate(date) || !isValidTime(time)}
          onPress={async () => {
            const newStart = at(date, time);
            const result = await move.mutateAsync({
              meetingId: meeting.id,
              startsAt: newStart,
              endsAt: new Date(new Date(newStart).getTime() + length).toISOString(),
            });
            if (result.status === 'done') {
              const n = result.value.shifted.length;
              toast.show({
                tone: 'success',
                message: `Moved to ${when(newStart)}${n ? `; ${n} to-do date${n === 1 ? '' : 's'} moved with it` : ''}`,
              });
              onDone();
            }
          }}
        />
      </View>
      {move.error && <Text style={styles.error}>{errorMessage(move.error)}</Text>}
    </View>
  );
}

function statusLine(m: MeetingView): string | null {
  if (m.status === 'closed') return 'Closed: its summary note and to-dos are below.';
  return null;
}

/** One meeting: its notes and to-dos; reschedule; close. */
export default function MeetingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useScreenContext({ screen: 'meeting', meetingId: id });
  const meeting = useEntity('meetings', id);
  const notes = useEntityList('notes', { meetingId: id, sort: '-createdAt' });
  const todos = useEntityList('todos', { meetingId: id, sort: 'dueOn' });
  const noteMutation = useEntityMutation('notes');
  const todoMutation = useEntityMutation('todos');
  const meetingMutation = useEntityMutation('meetings');
  const [panel, setPanel] = useState<'close' | 'reschedule' | null>(null);
  const [newNote, setNewNote] = useState('');
  const [newTodo, setNewTodo] = useState('');

  const back = (
    <Link href="/meetings" asChild>
      <Pressable
        accessibilityRole="link"
        style={StyleSheet.flatten([
          styles.row,
          { gap: space.xs, minHeight: 44, alignSelf: 'flex-start' as const },
        ])}
      >
        <Icon name="chevron-left" color={colors.primary} />
        <Text style={[styles.label, { color: colors.primary }]}>Meetings</Text>
      </Pressable>
    </Link>
  );

  if (meeting.error) {
    const missing = meeting.error instanceof ApiError && [400, 404].includes(meeting.error.status);
    return (
      <View style={styles.content}>
        {back}
        <EmptyState
          icon={missing ? 'calendar' : 'alert-circle'}
          title={missing ? "This meeting doesn't exist" : "Couldn't load this meeting"}
          body={
            missing
              ? 'It may have been deleted, or the link is wrong.'
              : errorMessage(meeting.error)
          }
          action={
            missing
              ? { label: 'Back to meetings', onPress: () => router.navigate('/meetings') }
              : { label: 'Try again', onPress: () => meeting.refetch() }
          }
        />
      </View>
    );
  }
  const m = meeting.data;
  if (!m) return <Text style={[styles.muted, { padding: space.lg }]}>Loading…</Text>;
  const closed = m.status === 'closed';
  const started = new Date(m.startsAt).getTime() <= Date.now();
  const line = statusLine(m);
  const summaryTitle = `Summary: ${m.title}`;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {back}
      <View style={{ gap: space.sm }}>
        <View style={[styles.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
          <Text style={styles.title} accessibilityRole="header">
            {m.title}
          </Text>
          <StatusBadge meeting={m} />
        </View>
        <Text style={styles.muted}>
          {when(m.startsAt)}–{clock(m.endsAt)}
          {m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}
        </Text>
        {line && <Text style={styles.text}>{line}</Text>}
        {/* The "Needs closing" badge carries the alarm; this line only says what closing does. */}
        {needsClosing(m) && (
          <Text style={styles.muted}>Closing records its summary note and its to-dos.</Text>
        )}
        {!closed && !started && (
          <Text style={styles.muted}>
            You can close it once it starts, to record its summary and to-dos.
          </Text>
        )}
        {!closed && !panel && (
          <View style={[styles.row, { flexWrap: 'wrap', marginTop: space.xs }]}>
            {started ? (
              <Button title="Write the close…" icon="edit-3" onPress={() => setPanel('close')} />
            ) : null}
            <Button
              title="Reschedule"
              variant={started ? 'secondary' : 'primary'}
              icon="calendar"
              onPress={() => setPanel('reschedule')}
            />
            {m.status === 'scheduled' && started && (
              <Button
                title="Mark as held"
                accessibilityLabel="Mark as held: it happened, notes to follow"
                variant="subtle"
                onPress={() =>
                  meetingMutation.update.mutate({ id: m.id, patch: { status: 'held' } })
                }
              />
            )}
          </View>
        )}
      </View>

      {panel === 'reschedule' && <Reschedule meeting={m} onDone={() => setPanel(null)} />}
      {panel === 'close' && !closed && (
        <CloseMeetingForm meeting={m} onDone={() => setPanel(null)} />
      )}

      <View style={styles.section}>
        <SectionHeading>Notes</SectionHeading>
        {notes.items.length === 0 ? (
          <Text style={styles.muted}>
            {closed ? 'No notes.' : 'No notes yet. Closing the meeting writes a summary note.'}
          </Text>
        ) : (
          <View>
            {notes.items.map((n, i) => (
              <View key={n.id} style={listRow(i, notes.items.length)}>
                <NoteRow full note={n.title === summaryTitle ? { ...n, title: 'Summary' } : n} />
              </View>
            ))}
          </View>
        )}
        {!closed && (
          <View style={[styles.row, { alignItems: 'flex-end' }]}>
            <Field
              label="Add a note"
              value={newNote}
              onChangeText={setNewNote}
              placeholder="e.g. Supplier quote received"
            />
            <Button
              title="Add note"
              icon="plus"
              variant="secondary"
              disabled={!newNote.trim()}
              onPress={async () => {
                await noteMutation.create.mutateAsync({ title: newNote.trim(), meetingId: m.id });
                setNewNote('');
              }}
            />
          </View>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading>To-dos</SectionHeading>
        {todos.items.length === 0 ? (
          <Text style={styles.muted}>
            {closed
              ? 'No to-dos.'
              : 'No to-dos yet. Action items become to-dos when you close the meeting.'}
          </Text>
        ) : (
          <View>
            {todos.items.map((t, i) => (
              <View key={t.id} style={listRow(i, todos.items.length)}>
                <TodoRow todo={t} canDelete={!closed} showMeeting={false} />
              </View>
            ))}
          </View>
        )}
        {!closed && (
          <View style={[styles.row, { alignItems: 'flex-end' }]}>
            <Field
              label="Add a to-do"
              value={newTodo}
              onChangeText={setNewTodo}
              placeholder="e.g. Print the drawings"
            />
            <Button
              title="Add to-do"
              icon="plus"
              variant="secondary"
              disabled={!newTodo.trim()}
              onPress={async () => {
                await todoMutation.create.mutateAsync({ title: newTodo.trim(), meetingId: m.id });
                setNewTodo('');
              }}
            />
          </View>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading>History</SectionHeading>
        <Text style={styles.muted}>
          Who asked for what, who approved it, and when, from the audit trail.
        </Text>
        <View style={styles.card}>
          <History type="meeting" id={m.id} />
        </View>
      </View>
    </ScrollView>
  );
}
