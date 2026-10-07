import { RescheduleMeetingSpec } from '@app/contracts';
import { Link, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { CloseMeetingForm } from '../../components/CloseMeetingForm';
import { StatusBadge, TodoRow } from '../../components/Rows';
import { useScreenContext } from '../../framework/assistant-context';
import { at, when } from '../../framework/dates';
import {
  errorMessage,
  useCommand,
  useEntity,
  useEntityList,
  useEntityMutation,
} from '../../framework/hooks';
import { colors, styles } from '../../theme';

function Reschedule({
  meetingId,
  startsAt,
  endsAt,
  onDone,
}: {
  meetingId: string;
  startsAt: string;
  endsAt: string;
  onDone: () => void;
}) {
  const move = useCommand(RescheduleMeetingSpec);
  const start = new Date(startsAt);
  const [date, setDate] = useState(start.toLocaleDateString('sv'));
  const [time, setTime] = useState(start.toTimeString().slice(0, 5));
  const length = new Date(endsAt).getTime() - start.getTime();
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Reschedule</Text>
      <Text style={styles.muted}>Open to-dos with due dates move by the same number of days.</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { width: 150 }]}
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
        />
        <TextInput
          style={[styles.input, { width: 100 }]}
          value={time}
          onChangeText={setTime}
          placeholder="HH:MM"
          placeholderTextColor={colors.muted}
        />
        <Button
          title="Move"
          busy={move.isPending}
          onPress={async () => {
            const newStart = at(date, time);
            const result = await move.mutateAsync({
              meetingId,
              startsAt: newStart,
              endsAt: new Date(new Date(newStart).getTime() + length).toISOString(),
            });
            if (result.status === 'done') onDone();
          }}
        />
        <Button title="Cancel" variant="ghost" onPress={onDone} />
      </View>
      {move.error && <Text style={styles.error}>{errorMessage(move.error)}</Text>}
    </View>
  );
}

/** One meeting: its notes and to-dos; edit, add, reschedule, close. */
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

  if (meeting.error)
    return <Text style={[styles.error, { padding: 16 }]}>{errorMessage(meeting.error)}</Text>;
  const m = meeting.data;
  if (!m) return <Text style={[styles.muted, { padding: 16 }]}>Loading…</Text>;
  const closed = m.status === 'closed';

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Link href="/meetings" style={[styles.muted, { color: colors.primary }]}>
        ← Meetings
      </Link>
      <View style={styles.card}>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.title}>{m.title}</Text>
          <StatusBadge status={m.status} />
        </View>
        <Text style={styles.muted}>
          {when(m.startsAt)} –{' '}
          {new Date(m.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          {m.attendees.length ? ` · ${m.attendees.join(', ')}` : ''}
        </Text>
        {!closed && (
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            {m.status === 'scheduled' && (
              <Button
                title="Mark held"
                variant="ghost"
                onPress={() =>
                  meetingMutation.update.mutate({ id: m.id, patch: { status: 'held' } })
                }
              />
            )}
            <Button title="Reschedule" variant="ghost" onPress={() => setPanel('reschedule')} />
            <Button title="Close meeting" onPress={() => setPanel('close')} />
          </View>
        )}
      </View>

      {panel === 'reschedule' && (
        <Reschedule
          meetingId={m.id}
          startsAt={m.startsAt}
          endsAt={m.endsAt}
          onDone={() => setPanel(null)}
        />
      )}
      {panel === 'close' && !closed && (
        <CloseMeetingForm meeting={m} onDone={() => setPanel(null)} />
      )}

      <View style={styles.card}>
        <Text style={styles.heading}>Notes</Text>
        {notes.items.map((n) => (
          <View key={n.id} style={{ gap: 2 }}>
            <Text style={styles.text}>{n.title}</Text>
            <Text style={styles.muted}>{n.body}</Text>
          </View>
        ))}
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newNote}
            onChangeText={setNewNote}
            placeholder="Add a note"
            placeholderTextColor={colors.muted}
          />
          <Button
            title="Add"
            disabled={!newNote.trim()}
            onPress={async () => {
              await noteMutation.create.mutateAsync({ title: newNote.trim(), meetingId: m.id });
              setNewNote('');
            }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>To-dos</Text>
        {todos.items.map((t) => (
          <TodoRow key={t.id} todo={t} />
        ))}
        <View style={styles.row}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newTodo}
            onChangeText={setNewTodo}
            placeholder="Add a to-do"
            placeholderTextColor={colors.muted}
          />
          <Button
            title="Add"
            disabled={!newTodo.trim()}
            onPress={async () => {
              await todoMutation.create.mutateAsync({ title: newTodo.trim(), meetingId: m.id });
              setNewTodo('');
            }}
          />
        </View>
      </View>
    </ScrollView>
  );
}
