import type { BriefView } from '@application/domain/modules/briefs/contracts';
import type { BriefListView } from '@application/domain/modules/briefs/views';
import { Rows, useMoneyText, ViewCard } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';
import { View } from 'react-native';

/** One brief: who, what they need, their rough budget and by when. */
export function BriefLine({ brief }: { brief: BriefView }) {
  const money = useMoneyText();
  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="shrink font-semibold">{brief.name}</Text>
        {brief.budget ? <Text className="font-semibold">{money(brief.budget)}</Text> : null}
      </View>
      <Text>{brief.summary}</Text>
      <Text variant="muted">
        {[brief.source === 'form' ? 'From the form' : null, brief.neededBy, brief.status]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
}

export function BriefListComponent({ title, items, words }: ViewProps<typeof BriefListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(item) => <BriefLine brief={item} />}
      </Rows>
    </ViewCard>
  );
}
