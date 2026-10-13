import { Text, View } from 'react-native';
import { colors, styles } from '../theme';
import { Icon } from './Icon';

/** The assistant's one icon: in the tab bar, on its chat turns, and wherever it acted. */
export const ASSISTANT_ICON = 'zap' as const;

/**
 * The assistant, marked the same way everywhere it acted: its chat turns, the requests it made,
 * its rows in History, and the records it created. Decorative by default (the words around it
 * say "the assistant"); pass a label to make it the only signal.
 */
export function AssistantMark({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <View
      accessible={Boolean(label)}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      {...(label ? {} : ({ 'aria-hidden': true } as object))}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.assistantTint,
        borderWidth: 1,
        borderColor: colors.assistantBorder,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={ASSISTANT_ICON} color={colors.assistant} size={Math.round(size * 0.6)} />
    </View>
  );
}

/** "by the assistant", with its mark: the provenance line on records it created. */
export function ByAssistant() {
  return (
    <View style={[styles.row, { gap: 4 }]}>
      <AssistantMark size={16} />
      <Text style={[styles.muted, { color: colors.assistant }]}>by the assistant</Text>
    </View>
  );
}
