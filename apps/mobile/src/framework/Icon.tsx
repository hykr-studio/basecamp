import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
import { colors } from '../theme';

export type IconName = ComponentProps<typeof Feather>['name'];

/** One drawn icon family (Feather: one stroke, one weight) for the whole app. */
export function Icon({
  name,
  size = 18,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} accessible={false} />;
}
