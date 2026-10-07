import type { NoteCardView, NoteListView } from '@app/ui-registry';
import type { ViewProps } from '@app/ui-registry/react';
import { Text } from '@/components/ui/text';
import { Markdown } from '../../framework/Markdown';
import { ByAssistant, OpenRow, Rows, ViewCard } from '../../views/parts';

export function NoteListComponent({ title, items, act }: ViewProps<typeof NoteListView>) {
  return (
    <ViewCard title={title ?? 'Notes'} count={items.length}>
      <Rows items={items} empty="No notes here.">
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
