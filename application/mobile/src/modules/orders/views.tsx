import type { OrderListView } from '@application/domain/modules/orders/views';
import { Rows, ViewCard } from '@hykr/app';
import { Text } from '@hykr/app/ui';
import type { ViewProps } from '@hykr/ui-registry/react';

export function OrderListComponent({ title, items, words }: ViewProps<typeof OrderListView>) {
  return (
    <ViewCard title={title ?? words.title} count={items.length}>
      <Rows items={items} empty={words.empty}>
        {(item) => <Text className="font-semibold">{item.title}</Text>}
      </Rows>
    </ViewCard>
  );
}
