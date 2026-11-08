import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { labelOf } from '../../framework/ApprovalPreview';
import { Icon } from '../../framework/Icon';
import { hrefFor } from '../../runtime';
import { colors, space, styles } from '../../theme';
import { useSlaList } from './hooks';

/**
 * What ran out of time: the business's breached SLA clocks still running late (the server
 * leaves out the ones whose record has moved on), on records the person reads, each opening where
 * the app shows its record, newest deadline last: the first `limit` of them. Nothing when none is
 * late. For a Today screen.
 */
export function OverdueList({
  resourceType,
  limit = 10,
}: {
  resourceType?: string;
  limit?: number;
}) {
  const q = useSlaList({ status: 'breached', open: true, resourceType, limit });
  const late = q.data?.items ?? [];
  if (!late.length) return null;
  return (
    <View style={{ gap: space.xs }}>
      {late.map((t) => {
        const href = hrefFor(t.resourceType, t.resourceId);
        const label = labelOf(t.resourceType);
        const words = `${label.charAt(0).toUpperCase()}${label.slice(1)} overdue since ${new Date(
          t.breachedAt ?? t.dueAt,
        ).toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}`;
        return (
          <Pressable
            key={t.id}
            accessibilityRole={href ? 'link' : 'text'}
            accessibilityLabel={words}
            disabled={!href}
            onPress={() => href && router.navigate(href as never)}
            style={styles.row}
          >
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text style={[styles.text, { color: colors.danger }]}>{words}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
