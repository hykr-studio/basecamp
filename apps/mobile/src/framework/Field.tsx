import { Text, TextInput, type TextInputProps, View } from 'react-native';
import { colors, space, styles } from '../theme';

type FieldProps = Omit<TextInputProps, 'style'> & {
  label: string;
  /** Format or requirement, shown before submission. */
  hint?: string;
  error?: string | null;
  width?: number;
  multilineHeight?: number;
};

/** A persistent label above the input; the placeholder is only an example. */
export function Field({ label, hint, error, width, multilineHeight, ...input }: FieldProps) {
  return (
    <View style={[{ gap: space.xs }, width ? { width } : { flexGrow: 1, minWidth: 160 }]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          multilineHeight ? { minHeight: multilineHeight, textAlignVertical: 'top' } : null,
          error ? { borderColor: colors.danger } : null,
        ]}
        {...input}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.muted}>{hint}</Text>
      ) : null}
    </View>
  );
}
