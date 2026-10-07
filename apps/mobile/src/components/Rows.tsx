import type { MeetingView, Todo } from '@app/contracts';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { when } from '../framework/dates';
import { useEntityMutation } from '../framework/hooks';
import { colors, styles } from '../theme';
import { Button } from './Button';

/** A to-do: tick it, tap the title to edit, delete. */
export function TodoRow({ todo }: { todo: Todo }) {
  const { update, remove } = useEntityMutation('todos');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const overdue = !todo.done && todo.dueOn && todo.dueOn < new Date().toLocaleDateString('sv');
  return (
    <View style={s.row}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: todo.done }}
        accessibilityLabel={todo.title}
        onPress={() => update.mutate({ id: todo.id, patch: { done: !todo.done } })}
        style={[s.box, todo.done && s.boxDone]}
      >
        {todo.done && <Text style={s.tick}>✓</Text>}
      </Pressable>
      {editing ? (
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={title}
          onChangeText={setTitle}
          autoFocus
          onSubmitEditing={() => {
            if (title.trim() && title !== todo.title)
              update.mutate({ id: todo.id, patch: { title: title.trim() } });
            setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <Pressable
          style={{ flex: 1 }}
          onPress={() => setEditing(true)}
          accessibilityHint="Edit the title"
        >
          <Text style={[styles.text, todo.done && s.done]}>{todo.title}</Text>
        </Pressable>
      )}
      {todo.dueOn && (
        <Text style={[styles.muted, overdue && { color: colors.danger }]}>due {todo.dueOn}</Text>
      )}
      <Button
        title="Delete"
        variant="danger"
        onPress={() => remove.mutate(todo.id)}
        busy={remove.isPending}
      />
    </View>
  );
}

export function MeetingRow({ meeting }: { meeting: MeetingView }) {
  return (
    <Link href={`/meetings/${meeting.id}`} asChild>
      <Pressable accessibilityRole="link" style={s.meeting}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.text}>{meeting.title}</Text>
          <Text style={styles.muted}>
            {when(meeting.startsAt)}
            {meeting.attendees.length ? ` · ${meeting.attendees.join(', ')}` : ''}
          </Text>
        </View>
        <StatusBadge status={meeting.status} />
      </Pressable>
    </Link>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'closed' ? colors.muted : status === 'held' ? colors.primary : '#1b7f4b';
  return (
    <View style={[s.badge, { borderColor: tone }]}>
      <Text style={[styles.muted, { color: tone, textTransform: 'capitalize' }]}>{status}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.primaryText, fontSize: 14, fontWeight: '700' },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
  meeting: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
});
