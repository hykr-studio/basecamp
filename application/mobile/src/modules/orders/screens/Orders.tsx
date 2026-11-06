import {
  EmptyState,
  LoadError,
  ScreenTitle,
  styles,
  useEntityList,
  useScreenContext,
} from '@hykr/app';
import { FlatList, Text, View } from 'react-native';

/** Every order, newest first. */
export function Orders() {
  useScreenContext({ screen: 'orders' });
  const list = useEntityList('orders', { sort: '-createdAt' });
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={<ScreenTitle title="Orders" />}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text>{item.title}</Text>
        </View>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="orders" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState icon="list" title="No orders yet" />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
