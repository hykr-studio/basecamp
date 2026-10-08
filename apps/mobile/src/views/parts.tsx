import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { ByAssistant } from '../framework/AssistantMark';
import { Icon } from '../framework/Icon';
import { colors } from '../theme';

/** The frame every view shares: a white card with an optional title and a count. */
export function ViewCard({
  title,
  count,
  children,
}: {
  title?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <Card className="gap-2 py-3">
      {(title || count !== undefined) && (
        <View className="flex-row items-baseline justify-between gap-2">
          {title ? <Text variant="heading">{title}</Text> : <View />}
          {count !== undefined && <Text variant="muted">{count}</Text>}
        </View>
      )}
      {children}
    </Card>
  );
}

/** Rows separated by hairlines, inside a ViewCard. */
export function Rows<T>({
  items,
  empty,
  children,
}: {
  items: T[];
  empty?: string;
  children: (item: T) => ReactNode;
}) {
  if (items.length === 0) return empty ? <Text variant="muted">{empty}</Text> : null;
  return (
    <View>
      {items.map((item, i) => (
        <View key={(item as { id?: string }).id ?? i}>
          {i > 0 && <Separator />}
          {children(item)}
        </View>
      ))}
    </View>
  );
}

/** A row that opens something in the canvas. */
export function OpenRow({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="min-h-11 flex-row items-center gap-2 py-2 web:hover:opacity-80"
    >
      <View className="flex-1 gap-0.5">{children}</View>
      <Icon name="chevron-right" color={colors.muted} size={16} />
    </Pressable>
  );
}

export { ByAssistant };
