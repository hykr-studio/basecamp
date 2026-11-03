import { ByAssistant, Loading, Markdown, useEntity } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import { View } from 'react-native';

/** One note, as the canvas shows it (note.detail). */
export function NoteDetail({ id }: { id: string }) {
  const note = useEntity('notes', id);
  if (!note.data) return <Loading error={note.error} />;
  return (
    <View className="gap-3">
      <Text variant="title">{note.data.title}</Text>
      {note.data.createdBy === 'assistant' && <ByAssistant />}
      {note.data.body.trim() ? (
        <Markdown text={note.data.body} />
      ) : (
        <Text variant="muted">No text yet.</Text>
      )}
    </View>
  );
}
