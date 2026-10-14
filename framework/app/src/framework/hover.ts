import type { PressableStateCallbackType } from 'react-native';

/** react-native-web adds `hovered` to Pressable's state; React Native's types don't list it. */
export const isHovered = (state: PressableStateCallbackType) =>
  Boolean((state as { hovered?: boolean }).hovered);

/** react-native-web also adds `focused` (keyboard or pointer focus); native leaves it out. */
export const isFocused = (state: PressableStateCallbackType) =>
  Boolean((state as { focused?: boolean }).focused);
