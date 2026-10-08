import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, space, styles } from '../theme';
import { useAssistant } from './assistant-context';
import { isHovered } from './hover';
import { Icon } from './Icon';

/**
 * A message the assistant understands, offered where it would help ("Try: plan my week").
 * Pressing it sends it as the person, so the product teaches itself by doing the real thing.
 * Styled like the thread's own suggestions: the words in the action colour, a return mark.
 */
export function TryPrompt({ text, what }: { text: string; what?: string }) {
  const assistant = useAssistant();
  const [sending, setSending] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Ask the assistant: ${text}`}
      accessibilityState={{ busy: sending }}
      disabled={sending}
      onPress={async () => {
        setSending(true);
        // Phones keep the thread in a sheet: open it, so the reply is in sight.
        assistant.reveal();
        try {
          await assistant.send(text);
        } finally {
          setSending(false);
        }
      }}
      style={(state) => [
        {
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          alignSelf: 'flex-start',
          paddingHorizontal: space.sm,
          marginHorizontal: -space.sm,
          borderRadius: 8,
        },
        isHovered(state) && { backgroundColor: colors.bg },
      ]}
    >
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={styles.text}>
          <Text style={{ color: colors.muted }}>Try: </Text>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{text}</Text>
        </Text>
        {what ? <Text style={styles.muted}>{what}</Text> : null}
      </View>
      <Icon name="corner-down-left" color={colors.muted} size={16} />
    </Pressable>
  );
}
