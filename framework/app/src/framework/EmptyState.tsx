import { Text, View } from 'react-native';
import { Button } from '../components/Button';
import { colors, space, styles } from '../theme';
import { Icon, type IconName } from './Icon';
import { TryPrompt } from './TryPrompt';

/** An empty list that teaches: what goes here, the main action, and what to ask the assistant. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  ask,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  /** A message to send the assistant, shown as a suggestion: the same thing, done by asking. */
  ask?: string;
}) {
  return (
    <View style={{ alignItems: 'flex-start', gap: space.sm, paddingVertical: space.md }}>
      <Icon name={icon} color={colors.muted} size={22} />
      <Text style={styles.heading}>{title}</Text>
      {body ? <Text style={styles.muted}>{body}</Text> : null}
      {action && (
        <View style={styles.row}>
          <Button title={action.label} onPress={action.onPress} variant="secondary" />
        </View>
      )}
      {ask && <TryPrompt text={ask} />}
    </View>
  );
}

/** A list that failed to load: what happened and how to retry. */
export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <View style={{ gap: space.sm, paddingVertical: space.md }} accessibilityLiveRegion="polite">
      <Text style={styles.error}>
        Couldn't load {what}. Check that the API is running, then try again.
      </Text>
      <Button title="Try again" variant="secondary" icon="refresh-cw" onPress={onRetry} />
    </View>
  );
}
