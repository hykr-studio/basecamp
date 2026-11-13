import { OrderSpec, type OrderView } from '@application/domain/modules/orders/contracts';
import type { OrderCardView, OrderListView } from '@application/domain/modules/orders/views';
import { OpenRow, Rows, StateBadge, useMoneyText, ViewCard } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';
import { View } from 'react-native';

function OrderLine({ o, onOpen }: { o: OrderView; onOpen: () => void }) {
  const money = useMoneyText();
  return (
    <OpenRow label={`Open order ${o.number}, ${o.title}`} onPress={onOpen}>
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="shrink font-semibold">{o.title}</Text>
        <Text className="font-semibold">{money(o.total)}</Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="muted">{o.number}</Text>
        <StateBadge spec={OrderSpec} row={o} />
      </View>
    </OpenRow>
  );
}

export function OrderListComponent({ title, items, act, words }: ViewProps<typeof OrderListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(o) => <OrderLine o={o} onOpen={() => act('open', o)} />}
      </Rows>
    </ViewCard>
  );
}

export function OrderCardComponent({ item, act }: ViewProps<typeof OrderCardView>) {
  const money = useMoneyText();
  return (
    <ViewCard>
      <OrderLine o={item} onOpen={() => act('open', item)} />
      {item.taxLines.map((t) => (
        <Text key={t.code} variant="muted">
          {t.label ?? t.code}: {money(t.amount)}
        </Text>
      ))}
    </ViewCard>
  );
}
