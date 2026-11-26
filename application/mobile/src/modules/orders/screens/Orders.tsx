import { ORDER_STATES, OrderSpec } from '@application/domain/modules/orders/contracts';
import {
  EmptyState,
  InlineView,
  LoadError,
  OpenRow,
  ScreenTitle,
  SectionHeading,
  StateBadge,
  space,
  styles,
  useEntityList,
  useMoneyText,
  useScreenContext,
  useT,
} from '@hykr/app';
import { router } from 'expo-router';
import { FlatList, Text, View } from 'react-native';

/**
 * Live totals: summaries of the orders computed by the server for whoever looks (the same
 * scope as the list), shown as kpi.row tiles. Never numbers typed in by anyone.
 */
const byStatus = (pick: ReturnType<typeof useT>['pick']) => ({
  entity: 'orders',
  query: { groupBy: ['status'], sum: ['total'] },
  // Each tile is named after its state, in the reader's language.
  labels: Object.fromEntries(
    Object.entries(ORDER_STATES.states).map(([name, s]) => [name, s.label ? pick(s.label) : name]),
  ),
});
const BY_MONTH = {
  entity: 'orders',
  query: { groupBy: ['createdAt:month'], sum: ['total'], sort: '-key', limit: 4 },
};

function Totals() {
  const { pick } = useT();
  return (
    <View style={{ gap: space.sm, marginBottom: space.md }}>
      <SectionHeading>By status</SectionHeading>
      <InlineView view="kpi.row" props={{ of: byStatus(pick) }} />
      <SectionHeading>By month</SectionHeading>
      <InlineView view="kpi.row" props={{ of: BY_MONTH }} />
    </View>
  );
}

/** Every order, newest first, with its number and total; their totals above. */
export function Orders() {
  useScreenContext({ screen: 'orders' });
  const list = useEntityList('orders', { sort: '-createdAt' });
  const money = useMoneyText();
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View>
          <ScreenTitle title="Orders" />
          {list.items.length ? <Totals /> : null}
        </View>
      }
      renderItem={({ item }) => (
        <OpenRow
          label={`Open order ${item.number}, ${item.title}`}
          onPress={() => router.navigate(`/orders/${item.id}`)}
        >
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={styles.text}>{item.title}</Text>
            <Text style={styles.text}>{money(item.total)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.muted}>{item.number}</Text>
            <StateBadge spec={OrderSpec} row={item} />
          </View>
        </OpenRow>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="orders" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState
            icon="list"
            title="No orders yet"
            body='Ask the assistant: "order Kitchen: 2 Cabinet at 1500, 1 Sink at 800 +18%"'
          />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
