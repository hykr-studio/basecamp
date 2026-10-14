import { router } from 'expo-router';
import { View } from 'react-native';
import { EmptyState } from '../framework/EmptyState';
import { getAppDomain } from '../runtime';
import { styles } from '../theme';

/**
 * An unknown route. It sends the person `home`: the given one, else the application's
 * `home`, else its first destination.
 */
export function NotFoundScreen({ home }: { home?: { href: string; label: string } }) {
  const app = getAppDomain();
  const first = app.nav[0];
  const target = home ??
    app.home ?? { href: first?.href ?? '/', label: first ? `Go to ${first.label}` : 'Go home' };
  return (
    <View style={styles.content}>
      <EmptyState
        icon="compass"
        title="This page doesn't exist"
        body="The link may be old or mistyped."
        action={{ label: target.label, onPress: () => router.navigate(target.href as never) }}
      />
    </View>
  );
}
