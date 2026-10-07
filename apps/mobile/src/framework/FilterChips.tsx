import type { ListInput } from '@app/contracts';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, styles } from '../theme';

export type Chip = { label: string; query: ListInput };

/** One chip at a time; each is a piece of list-grammar query the screen passes straight on. */
export function FilterChips({
  chips,
  selected,
  onSelect,
}: {
  chips: Chip[];
  selected: string;
  onSelect: (c: Chip) => void;
}) {
  return (
    <View style={[styles.row, { flexWrap: 'wrap' }]}>
      {chips.map((c) => {
        const on = c.label === selected;
        return (
          <Pressable
            key={c.label}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(c)}
            style={[s.chip, on && s.on]}
          >
            <Text style={[styles.muted, on && { color: colors.primaryText }]}>{c.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The list grammar's `q`. */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      style={[styles.input, { flex: 1, minWidth: 160 }]}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      value={value}
      onChangeText={onChange}
      accessibilityLabel={placeholder}
    />
  );
}

const s = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  on: { backgroundColor: colors.primary, borderColor: colors.primary },
});
