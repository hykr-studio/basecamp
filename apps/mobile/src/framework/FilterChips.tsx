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
            // Announced as a toggle that is pressed or not.
            {...({ 'aria-pressed': on } as object)}
            onPress={() => onSelect(c)}
            style={s.hit}
          >
            <View style={[s.chip, on && s.on]}>
              <Text style={[styles.label, { color: on ? colors.primary : colors.muted }]}>
                {c.label}
              </Text>
            </View>
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
      style={[styles.input, { flexGrow: 1, minWidth: 160 }]}
      placeholder={placeholder}
      placeholderTextColor={colors.placeholder}
      value={value}
      onChangeText={onChange}
      accessibilityLabel={placeholder}
    />
  );
}

const s = StyleSheet.create({
  // A 44px target around a chip drawn smaller; the negative margin keeps the row's spacing.
  hit: { minHeight: 44, marginVertical: -7, justifyContent: 'center', borderRadius: 999 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  // Selected reads as selected, not as another primary button.
  on: { backgroundColor: colors.primaryTint, borderColor: colors.primary },
});
