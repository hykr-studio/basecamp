import { router } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { applyCanvasIntent } from '../../canvas/store';
import { ScreenTitle } from '../../components/ScreenTitle';
import { ByAssistant } from '../../framework/AssistantMark';
import { useScreenContext } from '../../framework/assistant-context';
import { when } from '../../framework/dates';
import { EmptyState, LoadError } from '../../framework/EmptyState';
import { useEntityList, useUndoableDelete } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { colors, listRow, styles } from '../../theme';

/** Pages saved from the canvas. Each holds queries, so it opens with today's data. */
export default function Pages() {
  useScreenContext({ screen: 'pages' });
  const pages = useEntityList('pages', { sort: '-updatedAt' });
  const remove = useUndoableDelete('pages');

  return (
    <View style={styles.content}>
      <ScreenTitle
        title="Pages"
        subtitle="Pages the assistant composed and you kept. They always show current data."
      />
      {pages.error ? (
        <LoadError what="your pages" onRetry={() => pages.refresh()} />
      ) : !pages.loading && pages.items.length === 0 ? (
        <EmptyState
          icon="layout"
          title="No saved pages yet"
          body="Ask the assistant to plan your week, then press Save on the page it composes."
          ask="plan my week"
        />
      ) : (
        <FlatList
          data={pages.items}
          keyExtractor={(p) => p.id}
          onEndReached={pages.loadMore}
          renderItem={({ item, index }) => (
            <View style={listRow(index, pages.items.length)}>
              <View className="min-h-14 flex-row items-center gap-2">
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${item.name}`}
                  onPress={() => router.navigate(`/pages/${item.id}`)}
                  className="flex-1 gap-0.5 py-2"
                >
                  <Text className="font-semibold">{item.name}</Text>
                  <View className="flex-row flex-wrap items-center gap-x-3">
                    <Text variant="muted">
                      {item.spec.blocks.length} blocks · saved {when(item.updatedAt)}
                    </Text>
                    {item.createdBy === 'assistant' && <ByAssistant />}
                  </View>
                </Pressable>
                <Button
                  variant="subtle"
                  size="sm"
                  accessibilityLabel={`Open ${item.name} beside the chat`}
                  onPress={() =>
                    applyCanvasIntent({ kind: 'page', page: item.spec, pageId: item.id })
                  }
                >
                  <Text>Beside the chat</Text>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  accessibilityLabel={`Delete ${item.name}`}
                  onPress={() => remove({ id: item.id, title: item.name })}
                >
                  <Icon name="trash-2" color={colors.muted} size={18} />
                </Button>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}
