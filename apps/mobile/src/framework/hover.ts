import type { PressableStateCallbackType } from 'react-native';

/** react-native-web adds `hovered` to Pressable's state; React Native's types don't list it. */
export const isHovered = (state: PressableStateCallbackType) =>
  Boolean((state as { hovered?: boolean }).hovered);
