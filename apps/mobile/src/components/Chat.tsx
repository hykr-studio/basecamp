import type { ChatMessage, ToolCallSummary } from '@app/contracts';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, errorMessage } from '../api';
import { colors, styles } from '../theme';
import { Button } from './Button';

type Turn = ChatMessage & { toolCalls?: ToolCallSummary[] };

/** The server keeps no chat memory, so we send the recent turns with each message. */
const HISTORY = 12;

export function Chat({ onToolUse }: { onToolUse: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  async function send() {
    const content = draft.trim();
    if (!content || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content }];
    setTurns(next);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const messages = next.slice(-HISTORY).map(({ role, content }) => ({ role, content }));
      const res = await api.chat({ messages });
      setTurns([
        ...next,
        { role: 'assistant', content: res.reply || '(no reply)', toolCalls: res.toolCalls },
      ]);
      if (res.toolCalls.length > 0) onToolUse();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.card, s.card]}>
      <Text style={styles.heading}>Assistant</Text>
      <ScrollView
        ref={scroll}
        style={s.log}
        contentContainerStyle={{ gap: 8 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.length === 0 && (
          <Text style={styles.muted}>Try "add Book site visit" or "what's on my list?"</Text>
        )}
        {turns.map((t, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
            key={i}
            style={[s.bubble, t.role === 'user' ? s.user : s.agent]}
          >
            <Text style={[styles.text, t.role === 'user' && { color: colors.primaryText }]}>
              {t.content}
            </Text>
            {t.toolCalls && t.toolCalls.length > 0 && (
              <Text style={styles.muted}>
                {t.toolCalls.map((c) => `${c.tool} ${c.ok ? 'ok' : 'refused'}`).join(' · ')}
              </Text>
            )}
          </View>
        ))}
        {busy && <Text style={styles.muted}>Thinking…</Text>}
      </ScrollView>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <TextInput
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
          placeholder="Ask the assistant"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={send}
          editable={!busy}
        />
        <Button title="Send" onPress={send} busy={busy} disabled={!draft.trim()} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { flex: 1, minHeight: 360 },
  log: { flex: 1, maxHeight: 480 },
  bubble: { borderRadius: 10, padding: 10, gap: 4, maxWidth: '90%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  agent: { alignSelf: 'flex-start', backgroundColor: colors.agentBubble },
});
