import type { InboxEntry } from '@hykr/contracts';
import { router } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { ScreenTitle } from '../../components/ScreenTitle';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { EmptyState, LoadError } from '../../framework/EmptyState';
import { Icon } from '../../framework/Icon';
import { inApp } from '../../framework/web-link';
import { hrefFor } from '../../runtime';
import { colors, listRow, space, styles } from '../../theme';
import { useInbox, useMarkRead } from './hooks';

/** Where an item opens: its own link, else its record's, else nowhere. */
function linkOf(item: InboxEntry): string | null {
  if (item.url) return item.url;
  if (!item.record) return null;
  try {
    return hrefFor(item.record.type, item.record.id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The signed-in person's inbox: mentions and anything else a notification left for them in the
 * app, newest first. Opening an item marks it read.
 */
export function InboxScreen() {
  useScreenContext({ screen: 'inbox' });
  const inbox = useInbox();
  const read = useMarkRead();

  const open = (item: InboxEntry) => {
    if (!item.readAt) read.mutate([item.id]);
    const href = linkOf(item);
    if (href) router.navigate(href as never);
  };

  return (
    <View style={styles.content}>
      <ScreenTitle title="Inbox" subtitle="Mentions and notices for you, in this business." />
      {inbox.unread > 0 ? (
        <View style={styles.row}>
          <Button
            title={`Mark all ${inbox.unread} read`}
            variant="secondary"
            icon="check"
            busy={read.isPending}
            onPress={() => read.mutate('all')}
          />
        </View>
      ) : null}
      {inbox.error ? (
        <LoadError what="your inbox" onRetry={() => void inbox.refresh()} />
      ) : !inbox.loading && inbox.items.length === 0 ? (
        <EmptyState
          icon="bell"
          title="Nothing here yet"
          body="When someone mentions you in a comment, it shows up here."
        />
      ) : (
        <FlatList
          data={inbox.items}
          keyExtractor={(i) => i.id}
          onEndReached={() => {
            if (inbox.hasMore) void inbox.loadMore();
          }}
          renderItem={({ item, index }) => (
            <View style={listRow(index, inbox.items.length)}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`${item.readAt ? '' : 'Unread: '}${item.title}`}
                onPress={inApp(() => open(item))}
                style={{ flexDirection: 'row', gap: space.sm, paddingVertical: space.sm }}
              >
                <View style={{ paddingTop: 6, width: 10 }}>
                  {item.readAt ? null : (
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: colors.primary,
                      }}
                    />
                  )}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.text, item.readAt ? null : { fontWeight: '600' }]}>
                    {item.title}
                  </Text>
                  {item.body ? (
                    <Text style={styles.muted} numberOfLines={3}>
                      {item.body}
                    </Text>
                  ) : null}
                  <Text style={styles.muted}>{when(item.createdAt)}</Text>
                </View>
                {linkOf(item) ? <Icon name="chevron-right" size={18} color={colors.muted} /> : null}
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}
