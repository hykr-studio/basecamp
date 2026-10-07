import type { ChatMessage, ToolCallSummary } from '@app/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../api';
import { useAssistant } from '../framework/assistant-context';
import { errorMessage } from '../framework/hooks';
import { colors, styles } from '../theme';
import { Button } from './Button';

type Turn = ChatMessage & { toolCalls?: ToolCallSummary[] };

/** The server keeps no chat memory, so we send the recent turns with each message. */
const HISTORY = 12;

/** Which lists a write tool may have changed, so they refresh without a manual reload. */
function touchedBy(tool: string): string[] {
  if (/^(list|get)-/.test(tool)) return [];
  if (tool === 'close-meeting') return ['meetings', 'notes', 'todos'];
  if (tool === 'reschedule-meeting') return ['meetings', 'todos'];
  return ['todo', 'note', 'meeting'].filter((n) => tool.endsWith(`-${n}`)).map((n) => `${n}s`);
}

export function Chat({ compact = false }: { compact?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const queryClient = useQueryClient();
  const assistant = useAssistant();
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const contextRef = useRef(assistant.context);
  contextRef.current = assistant.context;

  async function send(text: string) {
    const content = text.trim();
    if (!content) return;
    const next: Turn[] = [...turnsRef.current, { role: 'user', content }];
    setTurns(next);
    setBusy(true);
    setError(null);
    try {
      const messages = next.slice(-HISTORY).map(({ role, content }) => ({ role, content }));
      const res = await api.chat({
        messages,
        ...(contextRef.current ? { context: contextRef.current } : {}),
      });
      setTurns([
        ...next,
        { role: 'assistant', content: res.reply || '(no reply)', toolCalls: res.toolCalls },
      ]);
      const names = new Set(res.toolCalls.flatMap((c) => touchedBy(c.tool)));
      if (names.size > 0) names.add('approvals');
      await Promise.all([...names].map((n) => queryClient.invalidateQueries({ queryKey: [n] })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Screens (the close form's "Draft from notes") send through this panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: register once; send reads refs
  useEffect(() => assistant.registerSend(send), []);

  return (
    <View style={[styles.card, s.card, compact && { minHeight: 0 }]}>
      <Text style={styles.heading}>Assistant</Text>
      <ScrollView
        ref={scroll}
        style={[s.log, compact && { maxHeight: 260 }]}
        contentContainerStyle={{ gap: 8 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.length === 0 && (
          <Text style={styles.muted}>
            Try "today", "add Book site visit", or paste notes on a meeting.
          </Text>
        )}
        {turns.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
          <View key={i} style={[s.bubble, t.role === 'user' ? s.user : s.agent]}>
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
          style={[styles.input, { flex: 1 }]}
          placeholder="Ask the assistant"
          placeholderTextColor={colors.muted}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => {
            send(draft);
            setDraft('');
          }}
          editable={!busy}
          multiline={false}
        />
        <Button
          title="Send"
          onPress={() => {
            send(draft);
            setDraft('');
          }}
          busy={busy}
          disabled={!draft.trim()}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { flex: 1, minHeight: 360 },
  log: { flex: 1, maxHeight: 520 },
  bubble: { borderRadius: 10, padding: 10, gap: 4, maxWidth: '90%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  agent: { alignSelf: 'flex-start', backgroundColor: colors.agentBubble },
});
