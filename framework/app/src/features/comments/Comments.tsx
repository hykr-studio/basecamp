import type { Comment, Mention } from '@hykr/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { ByAssistant } from '../../framework/AssistantMark';
import { when } from '../../framework/dates';
import { errorMessage } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { colors, space, styles } from '../../theme';
import { bodyParts, composeBody, mentionQuery, pickMention } from './body';
import { useCanWriteInternal, useCommentActions, useComments, useMentionable } from './hooks';

/** A comment's text, with the people it names in bold. */
function Body({ body }: { body: string }) {
  return (
    <Text style={styles.text}>
      {bodyParts(body).map((part, i) =>
        part.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <Text key={i}>{part.text}</Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text
          <Text key={i} style={s.mention}>
            @{part.label}
          </Text>
        ),
      )}
    </Text>
  );
}

function CommentRow({
  comment,
  onEdit,
  onRemove,
  busy,
}: {
  comment: Comment;
  onEdit: (body: string) => Promise<unknown>;
  onRemove: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (editing === null || !editing.trim()) return;
    try {
      await onEdit(editing);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <View style={s.comment}>
      <View style={[styles.row, s.meta]}>
        <Text style={styles.label}>{comment.author.name ?? 'Someone'}</Text>
        <Text style={styles.muted}>
          {when(comment.createdAt)}
          {comment.editedAt ? ' · edited' : ''}
        </Text>
        {comment.internal ? (
          <View style={s.badge}>
            <Text style={s.badgeText}>Team only</Text>
          </View>
        ) : null}
        {comment.createdBy === 'assistant' ? <ByAssistant /> : null}
      </View>
      {editing === null ? (
        <Body body={comment.body} />
      ) : (
        <TextInput
          value={editing}
          onChangeText={setEditing}
          multiline
          accessibilityLabel="Comment text"
          style={[styles.input, s.editor]}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {comment.can.edit || comment.can.remove ? (
        <View style={styles.row}>
          {editing === null ? (
            <>
              {comment.can.edit ? (
                <Button
                  title="Edit"
                  variant="ghost"
                  icon="edit-3"
                  onPress={() => setEditing(comment.body)}
                />
              ) : null}
              {comment.can.remove ? (
                <Button
                  title="Remove"
                  variant="ghost"
                  icon="trash-2"
                  busy={busy}
                  onPress={onRemove}
                />
              ) : null}
            </>
          ) : (
            <>
              <Button title="Save" variant="secondary" onPress={save} busy={busy} />
              <Button title="Cancel" variant="subtle" onPress={() => setEditing(null)} />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A record's discussion: its comments, oldest first, and a box to add one. Typing @ offers the
 * people who may read the record; a picked person is told. People who may write team-only
 * comments get a switch for them. Everything the API refuses (the record is not theirs, a person
 * who cannot see it) is said under the box.
 */
export function Comments({
  entity,
  id,
  title = 'Comments',
}: {
  /** The record's entity name ('order'). */
  entity: string;
  id: string;
  title?: string;
}) {
  const comments = useComments(entity, id);
  const { add, edit, remove } = useCommentActions(entity, id);
  const canInternal = useCanWriteInternal();
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [picked, setPicked] = useState<Mention[]>([]);
  const [internal, setInternal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const typing = mentionQuery(text, cursor ?? text.length);
  const suggestions = useMentionable(entity, id, typing?.q ?? null, internal);

  const choose = (m: Mention) => {
    if (!typing) return;
    const next = pickMention(text, typing, m.label);
    setText(next);
    setCursor(undefined);
    setPicked((list) => [...list, m]);
  };

  const send = async () => {
    const body = composeBody(text, picked);
    if (!body) return;
    try {
      const result = await add.mutateAsync({ body, ...(internal ? { internal: true } : {}) });
      setText('');
      setPicked([]);
      setNotice(
        result.status === 'needs_approval'
          ? `Waiting for approval: ${result.approval.summary ?? 'your comment'}`
          : null,
      );
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  return (
    <View style={styles.section} accessibilityLabel={title}>
      <Text style={styles.heading}>{title}</Text>
      {comments.error ? (
        <Text style={styles.error}>
          Comments could not be loaded: {errorMessage(comments.error)}
        </Text>
      ) : null}
      {comments.hasEarlier ? (
        <Button
          title="Show earlier comments"
          variant="subtle"
          onPress={() => void comments.loadEarlier()}
        />
      ) : null}
      {!comments.loading && !comments.error && comments.items.length === 0 ? (
        <Text style={styles.muted}>No comments yet.</Text>
      ) : null}
      {comments.items.map((c) => (
        <CommentRow
          key={c.id}
          comment={c}
          busy={edit.isPending || remove.isPending}
          onEdit={(body) => edit.mutateAsync({ commentId: c.id, body })}
          onRemove={() => remove.mutate(c.id, { onError: (e) => setNotice(errorMessage(e)) })}
        />
      ))}
      <View style={s.composer}>
        <TextInput
          value={text}
          onChangeText={(v) => {
            setText(v);
            setCursor(undefined);
          }}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
          multiline
          placeholder="Write a comment. Type @ to mention someone."
          placeholderTextColor={colors.placeholder}
          accessibilityLabel="New comment"
          style={[styles.input, s.editor]}
        />
        {typing && (suggestions.data?.length ?? 0) > 0 ? (
          <View style={s.suggestions} accessibilityRole="menu">
            {(suggestions.data ?? []).map((m) => (
              <Pressable
                key={`${m.kind}:${m.id}`}
                accessibilityRole="menuitem"
                accessibilityLabel={`Mention ${m.label}`}
                onPress={() => choose(m)}
                style={s.suggestion}
              >
                <Icon name="at-sign" size={14} color={colors.muted} />
                <Text style={styles.text}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={[styles.row, s.actions]}>
          {canInternal ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: internal }}
              onPress={() => setInternal((v) => !v)}
              style={styles.row}
            >
              <Icon name={internal ? 'check-square' : 'square'} size={18} color={colors.text} />
              <Text style={styles.text}>Team only</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Button
            title="Comment"
            icon="send"
            onPress={send}
            busy={add.isPending}
            disabled={!text.trim()}
          />
        </View>
        {notice ? (
          <Text style={styles.muted} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  comment: {
    gap: space.xs,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  meta: { flexWrap: 'wrap' },
  mention: { fontWeight: '600', color: colors.primary },
  badge: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { fontSize: 12, color: colors.warnText, fontWeight: '600' },
  composer: { gap: space.sm, paddingTop: space.sm },
  editor: { minHeight: 72, textAlignVertical: 'top' },
  suggestions: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.card,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    minHeight: 44,
  },
  actions: { justifyContent: 'space-between' },
});
