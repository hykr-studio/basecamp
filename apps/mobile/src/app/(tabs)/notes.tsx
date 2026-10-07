import type { NoteView } from '@app/contracts';
import { useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { useScreenContext } from '../../framework/assistant-context';
import { SearchBox } from '../../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../../framework/hooks';
import { colors, styles } from '../../theme';

function NoteEditor({ note, onDone }: { note?: NoteView; onDone: () => void }) {
  const { create, update } = useEntityMutation('notes');
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const mutation = note ? update : create;
  return (
    <View style={styles.card}>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder="Title"
        placeholderTextColor={colors.muted}
      />
      <TextInput
        style={[styles.input, { minHeight: 140, textAlignVertical: 'top' }]}
        value={body}
        onChangeText={setBody}
        placeholder="Markdown"
        placeholderTextColor={colors.muted}
        multiline
      />
      {mutation.error && <Text style={styles.error}>{errorMessage(mutation.error)}</Text>}
      <View style={styles.row}>
        <Button
          title="Save"
          busy={mutation.isPending}
          disabled={!title.trim()}
          onPress={async () => {
            if (note)
              await update.mutateAsync({ id: note.id, patch: { title: title.trim(), body } });
            else await create.mutateAsync({ title: title.trim(), body });
            onDone();
          }}
        />
        <Button title="Cancel" variant="ghost" onPress={onDone} />
      </View>
    </View>
  );
}

/** All notes, newest first, with search. Tap one to edit it. */
export default function Notes() {
  useScreenContext({ screen: 'notes' });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const list = useEntityList('notes', { ...(q.trim() ? { q: q.trim() } : {}), sort: '-createdAt' });
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <View style={[styles.row, { flexWrap: 'wrap' }]}>
            <SearchBox value={q} onChange={setQ} placeholder="Search notes" />
            <Button title="New note" onPress={() => setEditing('new')} />
          </View>
          {editing === 'new' && <NoteEditor onDone={() => setEditing(null)} />}
        </View>
      }
      renderItem={({ item }) =>
        editing === item.id ? (
          <NoteEditor note={item} onDone={() => setEditing(null)} />
        ) : (
          <Pressable
            style={[styles.card, { marginTop: 8 }]}
            onPress={() => setEditing(item.id)}
            accessibilityRole="button"
          >
            <Text style={styles.heading}>{item.title}</Text>
            <Text style={styles.muted} numberOfLines={3}>
              {item.body || '(empty)'}
            </Text>
          </Pressable>
        )
      }
      ListEmptyComponent={!list.loading ? <Text style={styles.muted}>No notes.</Text> : null}
      onEndReached={list.loadMore}
    />
  );
}
