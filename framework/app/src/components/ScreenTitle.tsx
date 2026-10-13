import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { space, styles } from '../theme';

/** Where you are, in words, with the screen's main action beside it. */
export function ScreenTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View
      style={[styles.row, { justifyContent: 'space-between', flexWrap: 'wrap', gap: space.md }]}
    >
      <View style={{ gap: 2, flexShrink: 1 }}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

/** A section heading: level 2 under the screen's title (the web otherwise renders every header as h1). */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.heading} accessibilityRole="header" {...({ 'aria-level': 2 } as object)}>
      {children}
    </Text>
  );
}
