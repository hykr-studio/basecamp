import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { isHovered } from '../framework/hover';
import { Icon, type IconName } from '../framework/Icon';
import { colors, space } from '../theme';

type Props = {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** primary: the one main action in an area. secondary: outlined. subtle: text-weight. danger: destructive. */
  variant?: 'primary' | 'secondary' | 'subtle' | 'danger';
  icon?: IconName;
  /** Visually icon-only; title is still the accessible name. */
  iconOnly?: boolean;
  /** Overrides the accessible name when the title alone is ambiguous (e.g. which item). */
  accessibilityLabel?: string;
  fullWidth?: boolean;
};

export function Button({
  title,
  onPress,
  busy,
  disabled,
  variant = 'primary',
  icon,
  iconOnly,
  accessibilityLabel,
  fullWidth,
}: Props) {
  const inactive = busy || disabled;
  const tint = inactive
    ? colors.disabledText
    : variant === 'primary'
      ? colors.primaryText
      : variant === 'danger'
        ? colors.danger
        : variant === 'subtle'
          ? colors.primary
          : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      onPress={onPress}
      disabled={inactive}
      style={(state) => [
        s.base,
        iconOnly && s.iconOnly,
        fullWidth && { flexGrow: 1 },
        variant === 'primary' && s.primary,
        variant === 'secondary' && s.secondary,
        variant === 'danger' && s.secondary,
        variant === 'subtle' && s.subtle,
        isHovered(state) && !inactive && (variant === 'primary' ? s.primaryHover : s.quietHover),
        state.pressed && !inactive && { opacity: 0.85 },
        inactive && (variant === 'primary' ? s.disabledFill : s.disabledLine),
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={variant === 'primary' ? colors.primary : tint} />
      ) : (
        <>
          {icon && <Icon name={icon} color={tint} size={iconOnly ? 18 : 16} />}
          {!iconOnly && <Text style={[s.label, { color: tint }]}>{title}</Text>}
        </>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: space.lg,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  iconOnly: { paddingHorizontal: 0, width: 44 },
  primary: { backgroundColor: colors.primary },
  primaryHover: { backgroundColor: '#264cc8' },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  subtle: { backgroundColor: 'transparent', paddingHorizontal: space.sm },
  quietHover: { backgroundColor: colors.primaryTint },
  disabledFill: { backgroundColor: colors.disabledBg },
  disabledLine: { borderColor: colors.disabledBg },
  label: { fontSize: 15, fontWeight: '600' },
});
