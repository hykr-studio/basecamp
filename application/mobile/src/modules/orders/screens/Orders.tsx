import {
  EmptyState,
  InlineView,
  LoadError,
  OpenRow,
  ScreenTitle,
  SectionHeading,
  space,
  styles,
  useEntityList,
  useMoneyText,
  useScreenContext,
} from '@hykr/app';
import { router } from 'expo-router';
import { FlatList, Text, View } from 'react-native';

/**
 * Live totals: summaries of the orders computed by the server for whoever looks (the same
 * scope as the list), shown as kpi.row tiles. Never numbers typed in by anyone.
 */
const BY_STATUS = {
  entity: 'orders',
  query: { groupBy: ['status'], sum: ['total'] },
  labels: { open: 'Open', cancelled: 'Cancelled' },
};
const BY_MONTH = {
  entity: 'orders',
  query: { groupBy: ['createdAt:month'], sum: ['total'], sort: '-key', limit: 4 },
};

function Totals() {
  return (
    <View style={{ gap: space.sm, marginBottom: space.md }}>
      <SectionHeading>By status</SectionHeading>
      <InlineView view="kpi.row" props={{ of: BY_STATUS }} />
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
          <Text style={styles.muted}>
            {item.number}
            {item.status === 'cancelled' ? ' · cancelled' : ''}
          </Text>
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
