import type { MeetingView, NoteView, Todo } from '@app/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { ByAssistant } from '../../framework/AssistantMark';
import { clock, relativeDay, when } from '../../framework/dates';
import { entityApi, useEntity, useEntityMutation, useUndoableDelete } from '../../framework/hooks';
import { isFocused, isHovered } from '../../framework/hover';
import { Icon } from '../../framework/Icon';
import { Markdown } from '../../framework/Markdown';
import { useToast } from '../../framework/Toast';
import { colors, space, styles } from '../../theme';
import { needsClosing } from '../meetings';

/** A to-do: tick it, tap the title to rename, delete with undo. */
/** Where a to-do came from: a link to its meeting, by title. */
function FromMeeting({ id }: { id: string }) {
  const meeting = useEntity('meetings', id);
  if (!meeting.data) return null;
  return (
    <Link href={`/meetings/${id}`} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`From the meeting ${meeting.data.title}`}
        style={StyleSheet.flatten([styles.row, { gap: 4, alignSelf: 'flex-start' as const }])}
      >
        <Icon name="calendar" color={colors.primary} size={13} />
        <Text style={[styles.muted, { color: colors.primary }]}>{meeting.data.title}</Text>
      </Pressable>
    </Link>
  );
}

export function TodoRow({
  todo,
  canDelete = true,
  showMeeting = true,
}: {
  todo: Todo;
  canDelete?: boolean;
  /** Off on the meeting's own page, where it would only repeat the title above. */
  showMeeting?: boolean;
}) {
  const { update } = useEntityMutation('todos');
  const toast = useToast();
  /** Ticking can move a to-do out of the current list, so it says so and offers Undo. */
  const client = useQueryClient();
  const toggle = () => {
    const done = !todo.done;
    update.mutate({ id: todo.id, patch: { done } });
    // Shown now, not on success: ticking can remove this row (and its callbacks) from the list.
    // Undo talks to the API directly for the same reason.
    toast.show({
      message: done ? `Marked “${todo.title}” done` : `Reopened “${todo.title}”`,
      durationMs: 5000,
      action: {
        label: 'Undo',
        onPress: async () => {
          await entityApi('todos').update(todo.id, { done: !done });
          await Promise.all([
            client.invalidateQueries({ queryKey: ['todos'] }),
            client.invalidateQueries({ queryKey: ['history'] }),
          ]);
        },
      },
    });
  };
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
        onPress={toggle}
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
            style={s.rename}
          >
            {(state) => (
              <>
                <Text style={[styles.text, { flexShrink: 1 }, todo.done && s.done]}>
                  {todo.title}
                </Text>
                {/* Hover or keyboard focus shows that the title can be renamed. */}
                {(isHovered(state) || isFocused(state)) && (
                  <Icon name="edit-2" color={colors.muted} size={14} />
                )}
              </>
            )}
          </Pressable>
        )}
        {(due || (showMeeting && todo.meetingId) || todo.createdBy === 'assistant') && (
          <View style={[styles.row, { flexWrap: 'wrap', columnGap: space.md, rowGap: 2 }]}>
            {due && (
              <Text
                style={[styles.muted, due.overdue && { color: colors.danger, fontWeight: '600' }]}
              >
                {due.text}
              </Text>
            )}
            {showMeeting && todo.meetingId && <FromMeeting id={todo.meetingId} />}
            {todo.createdBy === 'assistant' && <ByAssistant />}
          </View>
        )}
      </View>
      {canDelete && (
        <Button
          title="Delete"
          icon="trash-2"
          iconOnly
          variant="ghost"
          accessibilityLabel={`Delete “${todo.title}”`}
          onPress={() => remove(todo)}
        />
      )}
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

export function NoteRow({
  note,
  onPress,
  full,
}: {
  note: NoteView;
  onPress?: () => void;
  full?: boolean;
}) {
  const body = (
    <View style={{ gap: 2, paddingVertical: space.xs }}>
      <Text style={[styles.text, { fontWeight: '600' }]}>{note.title}</Text>
      {note.body.trim() ? (
        <Markdown text={note.body} lines={full ? undefined : 3} />
      ) : (
        <Text style={styles.muted}>No text yet.</Text>
      )}
      {note.createdBy === 'assistant' && <ByAssistant />}
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
  // A 44px target that takes only a line of text's room: the negative margin keeps the row's
  // spacing as it was, and the extra height reaches into the row's own padding.
  rename: {
    minHeight: 44,
    marginVertical: -8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.controlBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
  meeting: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
});
