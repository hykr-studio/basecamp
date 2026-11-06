import {
  EmptyState,
  LoadError,
  OpenRow,
  ScreenTitle,
  styles,
  useEntityList,
  useMoneyText,
  useScreenContext,
} from '@hykr/app';
import { router } from 'expo-router';
import { FlatList, Text, View } from 'react-native';

/** Every order, newest first, with its number and total. */
export function Orders() {
  useScreenContext({ screen: 'orders' });
  const list = useEntityList('orders', { sort: '-createdAt' });
  const money = useMoneyText();
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={<ScreenTitle title="Orders" />}
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
