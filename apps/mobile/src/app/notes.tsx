import type { NoteView } from '@app/contracts';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { NoteRow } from '../components/Rows';
import { ScreenTitle } from '../components/ScreenTitle';
import { useScreenContext } from '../framework/assistant-context';
import { EmptyState, LoadError } from '../framework/EmptyState';
import { Field } from '../framework/Field';
import { SearchBox } from '../framework/FilterChips';
import { errorMessage, useEntityList, useEntityMutation } from '../framework/hooks';
import { listRow, space, styles } from '../theme';

function NoteEditor({ note, onDone }: { note?: NoteView; onDone: () => void }) {
  const { create, update } = useEntityMutation('notes');
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const mutation = note ? update : create;
  return (
    <View style={[styles.card, { marginBottom: space.lg }]}>
      <Field label="Title" value={title} onChangeText={setTitle} autoFocus={!note} />
      <Field
        label="Note"
        hint="Markdown: # headings, - lists."
        value={body}
        onChangeText={setBody}
        multiline
        multilineHeight={160}
      />
      {mutation.error && <Text style={styles.error}>{errorMessage(mutation.error)}</Text>}
      <View style={styles.row}>
        <Button
          title={note ? 'Save changes' : 'Save note'}
          busy={mutation.isPending}
          disabled={!title.trim()}
          onPress={async () => {
            if (note)
              await update.mutateAsync({ id: note.id, patch: { title: title.trim(), body } });
            else await create.mutateAsync({ title: title.trim(), body });
            onDone();
          }}
        />
        <Button title="Cancel" variant="subtle" onPress={onDone} />
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
  const count = list.items.length;
  return (
    <FlatList
      contentContainerStyle={[styles.content, { gap: 0 }]}
      data={list.items}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={
        <View style={{ gap: space.lg, marginBottom: space.lg }}>
          <ScreenTitle
            title="Notes"
            action={
              editing !== 'new' && (
                <Button title="New note" icon="plus" onPress={() => setEditing('new')} />
              )
            }
          />
          {editing === 'new' && <NoteEditor onDone={() => setEditing(null)} />}
          <SearchBox value={q} onChange={setQ} placeholder="Search notes" />
        </View>
      }
      renderItem={({ item, index }) =>
        editing === item.id ? (
          <NoteEditor note={item} onDone={() => setEditing(null)} />
        ) : (
          <View style={listRow(index, count)}>
            <NoteRow note={item} onPress={() => setEditing(item.id)} />
          </View>
        )
      }
      ListEmptyComponent={
        list.error ? (
          <LoadError what="notes" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState
            icon="file-text"
            title={q.trim() ? `No notes match “${q.trim()}”` : 'No notes yet'}
            body={q.trim() ? undefined : 'Closing a meeting writes its summary here too.'}
            action={
              q.trim() ? undefined : { label: 'Write a note', onPress: () => setEditing('new') }
            }
          />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
