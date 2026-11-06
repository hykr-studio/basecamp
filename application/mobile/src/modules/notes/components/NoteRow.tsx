import type { NoteView } from '@application/domain/contracts';
import { ByAssistant, Markdown, space, styles } from '@hykr/app';
import { Pressable, Text, View } from 'react-native';

/** A note in a list: its title and the first lines; `onPress` makes it editable. */
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
