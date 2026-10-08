import type { Inbox as InboxData, InboxItem } from '@app/contracts';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ago, windowOf } from '../time';
import { Badge, Empty } from './ui';

type Tab = keyof InboxData;
const TABS: { key: Tab; label: string; empty: string }[] = [
  { key: 'open', label: 'Open', empty: 'Nobody is waiting for a person right now.' },
  { key: 'mine', label: 'Mine', empty: 'Conversations you take show up here.' },
  {
    key: 'waiting',
    label: 'Waiting',
    empty: 'None closing soon. These have under two hours left to reply as text.',
  },
];

export const REASONS: Record<string, string> = {
  customer_asked: 'Asked for a person',
  agent_failed: "The assistant couldn't answer",
  agent_tool: 'The assistant handed over',
  staff_took: 'Taken by the team',
};

const nameOf = (i: InboxItem) => i.contact.name ?? `+${i.contact.address}`;

function Row({
  item,
  selected,
  onPress,
}: {
  item: InboxItem;
  selected: boolean;
  onPress: () => void;
}) {
  const window = windowOf(item.windowEndsAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`gap-1 border-b border-divider px-4 py-3 ${selected ? 'bg-primary-tint' : 'bg-card'}`}
    >
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="flex-1 text-body font-heading text-text">
          {nameOf(item)}
        </Text>
        <Text className="text-small text-muted">{ago(item.openedAt)}</Text>
      </View>
      <Text numberOfLines={1} className="text-small text-muted">
        {REASONS[item.reason] ?? item.reason}
        {item.state === 'taken' ? ' · taken' : ''}
      </Text>
      <View className="flex-row gap-2">
        {item.flagged ? <Badge label="Waiting over a day" tone="danger" /> : null}
        <Badge
          label={window.label}
          tone={
            window.state === 'closing' ? 'warn' : window.state === 'closed' ? 'neutral' : 'success'
          }
        />
      </View>
    </Pressable>
  );
}

export function Inbox(props: {
  data: InboxData | undefined;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('open');
  const items = props.data?.[tab] ?? [];
  const current = TABS.find((t) => t.key === tab);
  return (
    <View className="flex-1">
      <View
        accessibilityRole="tablist"
        className="flex-row gap-1 border-b border-divider bg-card px-3 py-2"
      >
        {TABS.map((t) => {
          const count = props.data?.[t.key].length ?? 0;
          const active = t.key === tab;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(t.key)}
              className={`flex-row items-center gap-1.5 rounded-control px-3 py-1.5 ${active ? 'bg-rail' : ''}`}
            >
              <Text className={`text-small font-heading ${active ? 'text-text' : 'text-muted'}`}>
                {t.label}
              </Text>
              <Text className="text-small text-muted">{count}</Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView className="flex-1">
        {items.length === 0 ? (
          <Empty title="All clear">{current?.empty}</Empty>
        ) : (
          items.map((i) => (
            <Row
              key={i.id}
              item={i}
              selected={i.id === props.selectedId}
              onPress={() => props.onSelect(i.id)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
