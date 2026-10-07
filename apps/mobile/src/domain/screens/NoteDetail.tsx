import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { ByAssistant } from '../../framework/AssistantMark';
import { useEntity } from '../../framework/hooks';
import { Loading } from '../../framework/Loading';
import { Markdown } from '../../framework/Markdown';

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
