import { router, usePathname } from 'expo-router';
import { View } from 'react-native';
import { matchRoute } from '../framework/compose-app';
import { EmptyState } from '../framework/EmptyState';
import { getApp } from '../runtime';
import { styles } from '../theme';

/**
 * A path no route file claims. A framework plugin's route (`AppPlugin.routes`) renders here;
 * anything else is unknown, and sends the person `home`: the given one, else the application's
 * `home`, else its first destination. The application's `+not-found.tsx` re-exports it.
 */
export function NotFoundScreen({ home }: { home?: { href: string; label: string } }) {
  const app = getApp();
  const hit = matchRoute(app.routes, usePathname());
  if (hit) {
    const Screen = hit.route.screen;
    return <Screen params={hit.params} />;
  }
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
