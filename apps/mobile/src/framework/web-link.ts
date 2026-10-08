import { Platform } from 'react-native';

/**
 * A Pressable with accessibilityRole="link" answers Enter on the web only when it is a real
 * `<a href>`: react-native-web leaves a link's activation to the browser's own click. Spread
 * this onto the Pressable (it renders an anchor), and wrap its onPress in `inApp`.
 */
export const webHref = (href: string): object => (Platform.OS === 'web' ? { href } : {});

/** The app's own navigation instead of the browser loading the anchor's page. */
export const inApp =
  (go: () => void) =>
  (e?: { preventDefault?: () => void }): void => {
    e?.preventDefault?.();
    go();
  };
