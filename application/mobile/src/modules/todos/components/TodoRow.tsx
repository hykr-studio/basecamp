import type { Todo } from '@application/domain/contracts';
import {
  Button,
  ByAssistant,
  colors,
  entityApi,
  hrefFor,
  Icon,
  isFocused,
  isHovered,
  relativeDay,
  space,
  styles,
  useEntity,
  useEntityMutation,
  useToast,
  useUndo,
  useUndoableDelete,
} from '@hykr/app';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Where a to-do came from: its meeting, by title, linked where meetings open (`hrefFor`). By
 * entity name only: this module imports nothing from the meetings module.
 */
function FromMeeting({ id }: { id: string }) {
  const meeting = useEntity('meetings', id);
  if (!meeting.data) return null;
  const href = hrefFor('meeting', id);
  const label = (
    <>
      <Icon name="calendar" color={colors.primary} size={13} />
      <Text style={[styles.muted, { color: colors.primary }]}>{meeting.data.title}</Text>
    </>
  );
  const style = StyleSheet.flatten([styles.row, { gap: 4, alignSelf: 'flex-start' as const }]);
  if (!href) return <View style={style}>{label}</View>;
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`From the meeting ${meeting.data.title}`}
        style={style}
      >
        {label}
      </Pressable>
    </Link>
  );
}

/** A to-do: tick it, tap the title to rename, delete with undo. */
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
  const undo = useUndo();
  const toggle = () => {
    const done = !todo.done;
    // A failed write shows no Undo to act on: it resolves to nothing.
    const result = update.mutateAsync({ id: todo.id, patch: { done } }).catch(() => undefined);
    // Shown now, not on success: ticking can remove this row (and its callbacks) from the list.
    // Undo talks to the API directly for the same reason: the server's undo when the write
    // came back with one (the to-do's approval level gives it a window), else the reverse write.
    toast.show({
      message: done ? `Marked “${todo.title}” done` : `Reopened “${todo.title}”`,
      durationMs: 5000,
      action: {
        label: 'Undo',
        onPress: async () => {
          const written = await result;
          if (written?.status === 'done' && written.undo) {
            await undo(written.undo.id, ['todos']);
            return;
          }
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
});
