import type { MeetingView, NoteView, Todo } from '@app/contracts';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { clock, relativeDay, when } from '../framework/dates';
import { needsClosing, useEntityMutation, useUndoableDelete } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { colors, space, styles } from '../theme';
import { Button } from './Button';

/** A to-do: tick it, tap the title to rename, delete with undo. */
export function TodoRow({ todo }: { todo: Todo }) {
  const { update } = useEntityMutation('todos');
  const remove = useUndoableDelete('todos');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const due = todo.dueOn && !todo.done ? relativeDay(todo.dueOn) : null;
  const save = () => {
    if (title.trim() && title !== todo.title)
      update.mutate({ id: todo.id, patch: { title: title.trim() } });
    setEditing(false);
  };
  return (
    <View style={s.row}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: todo.done }}
        accessibilityLabel={todo.title}
        onPress={() => update.mutate({ id: todo.id, patch: { done: !todo.done } })}
        style={s.hit}
      >
        <View style={[s.box, todo.done && s.boxDone]}>
          {todo.done && <Icon name="check" color={colors.primaryText} size={14} />}
        </View>
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        {editing ? (
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            autoFocus
            accessibilityLabel={`Rename “${todo.title}”`}
            onSubmitEditing={save}
            onBlur={save}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Rename “${todo.title}”`}
            onPress={() => setEditing(true)}
            style={{ minHeight: 28, justifyContent: 'center' }}
          >
            <Text style={[styles.text, todo.done && s.done]}>{todo.title}</Text>
          </Pressable>
        )}
        {due && (
          <Text style={[styles.muted, due.overdue && { color: colors.danger, fontWeight: '600' }]}>
            {due.text}
          </Text>
        )}
      </View>
      <Button
        title="Delete"
        icon="trash-2"
        iconOnly
        variant="subtle"
        accessibilityLabel={`Delete “${todo.title}”`}
        onPress={() => remove(todo)}
      />
    </View>
  );
}

export function MeetingRow({ meeting }: { meeting: MeetingView }) {
  return (
    <Link href={`/meetings/${meeting.id}`} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${meeting.title}, ${when(meeting.startsAt)}`}
        style={s.meeting}
      >
        <View style={{ flex: 1, gap: 2 }}>
          {/* Title and status share a line; the time gets the full width below, so it never wraps mid-time. */}
          <View style={[styles.row, { flexWrap: 'wrap', justifyContent: 'space-between' }]}>
            <Text style={[styles.text, { fontWeight: '600', flexShrink: 1 }]}>{meeting.title}</Text>
            <StatusBadge meeting={meeting} />
          </View>
          <Text style={styles.muted}>
            {when(meeting.startsAt)}–{clock(meeting.endsAt)}
            {meeting.attendees.length ? ` · ${meeting.attendees.join(', ')}` : ''}
          </Text>
        </View>
        <Icon name="chevron-right" color={colors.muted} />
      </Pressable>
    </Link>
  );
}

export function NoteRow({ note, onPress }: { note: NoteView; onPress?: () => void }) {
  const body = (
    <View style={{ gap: 2, paddingVertical: space.xs }}>
      <Text style={[styles.text, { fontWeight: '600' }]}>{note.title}</Text>
      <Text style={styles.muted} numberOfLines={2}>
        {note.body.replace(/^#+\s*/gm, '') || 'No text yet.'}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Edit note “${note.title}”`}
      onPress={onPress}
      style={{ minHeight: 44 }}
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** Status as the person needs it: a past meeting that is still open says so. */
export function StatusBadge({ meeting }: { meeting: { status: string; startsAt: string } }) {
  const pending = needsClosing(meeting);
  const [label, fg, bg] = pending
    ? ['Needs closing', colors.warnText, colors.warnBg]
    : meeting.status === 'closed'
      ? ['Closed', colors.muted, colors.agentBubble]
      : meeting.status === 'held'
        ? ['Held', colors.primary, colors.primaryTint]
        : ['Upcoming', colors.success, colors.successTint];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={[styles.muted, { color: fg, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52 },
  hit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#aab2bf',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
  meeting: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
});
