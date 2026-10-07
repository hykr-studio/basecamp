import { Link, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { SavedPageView } from '../../canvas/screens';
import { useScreenContext } from '../../framework/assistant-context';
import { useEntity } from '../../framework/hooks';
import { Icon } from '../../framework/Icon';
import { colors, styles } from '../../theme';

/** One saved page, opened without the assistant: the same blocks, today's data. */
export default function PageRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useScreenContext({ screen: 'page' });
  const page = useEntity('pages', id);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Link href="/pages" asChild>
        <Pressable
          accessibilityRole="link"
          className="min-h-11 flex-row items-center gap-1 self-start"
        >
          <Icon name="chevron-left" color={colors.primary} />
          <Text variant="label" className="text-primary">
            Pages
          </Text>
        </Pressable>
      </Link>
      <View className="gap-1">
        <Text variant="title">{page.data?.name ?? ' '}</Text>
        {page.data && <Text variant="muted">{page.data.spec.title}</Text>}
      </View>
      <SavedPageView id={id} />
    </ScrollView>
  );
}
