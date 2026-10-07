import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

type Props = {
  title: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
};

export function Button({ title, onPress, busy, disabled, variant = 'primary' }: Props) {
  const inactive = busy || disabled;
  const ghost = variant !== 'primary';
  const tint = variant === 'danger' ? colors.danger : ghost ? colors.primary : colors.primaryText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        s.base,
        ghost ? s.ghost : s.primary,
        variant === 'danger' && s.danger,
        (pressed || inactive) && s.dim,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <Text style={[s.label, { color: tint }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.primary },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  danger: { borderColor: colors.danger },
  dim: { opacity: 0.6 },
  label: { fontSize: 15, fontWeight: '600' },
});
