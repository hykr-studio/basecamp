import type { NoteCardView, NoteListView } from '@application/domain/views';
import { ByAssistant, Markdown, OpenRow, Rows, ViewCard } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';

export function NoteListComponent({ title, items, act, words }: ViewProps<typeof NoteListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(n) => (
          <OpenRow label={`Open note ${n.title}`} onPress={() => act('open', n)}>
            <Text className="font-semibold">{n.title}</Text>
            {n.body.trim() ? <Markdown text={n.body} lines={2} /> : null}
            {n.createdBy === 'assistant' && <ByAssistant />}
          </OpenRow>
        )}
      </Rows>
    </ViewCard>
  );
}

export function NoteCardComponent({ item, act }: ViewProps<typeof NoteCardView>) {
  return (
    <ViewCard title={item.title}>
      {item.body.trim() ? (
        <Markdown text={item.body} lines={8} />
      ) : (
        <Text variant="muted">No text yet.</Text>
      )}
      {item.createdBy === 'assistant' && <ByAssistant />}
      <OpenRow label={`Open note ${item.title}`} onPress={() => act('open', item)}>
        <Text className="font-semibold text-primary">Open the note</Text>
      </OpenRow>
    </ViewCard>
  );
}
