import { BRIEF_FORM } from '@application/domain/modules/briefs/contracts';
import {
  EmptyState,
  LoadError,
  ScreenTitle,
  ShareLinks,
  styles,
  useEntityList,
  useScreenContext,
} from '@hykr/app';
import { FlatList, Text, View } from 'react-native';
import { BriefLine } from '../views';

/**
 * Every brief, newest first, and the brief form's links: make one for a customer (or to post),
 * copy it once, see how often it was answered, revoke it.
 */
export function Briefs() {
  useScreenContext({ screen: 'briefs' });
  const list = useEntityList('briefs', { sort: '-createdAt' });
  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={list.items}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={{ gap: 16 }}>
          <ScreenTitle title="Briefs" />
          <View style={styles.card}>
            <ShareLinks target={{ form: BRIEF_FORM }} />
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <BriefLine brief={item} />
        </View>
      )}
      ListEmptyComponent={
        list.error ? (
          <LoadError what="briefs" onRetry={list.refresh} />
        ) : list.loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <EmptyState icon="list" title="No briefs yet" />
        )
      }
      onEndReached={list.loadMore}
    />
  );
}
