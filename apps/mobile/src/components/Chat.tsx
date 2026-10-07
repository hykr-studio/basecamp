import type { ChatMessage, ToolCallSummary } from '@app/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../api';
import { useAssistant } from '../framework/assistant-context';
import { timeZone } from '../framework/dates';
import { errorMessage } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { storage } from '../framework/storage';
import { colors, space, styles } from '../theme';
import { Button } from './Button';

type Turn = ChatMessage & { toolCalls?: ToolCallSummary[] };

/** The server keeps no chat memory, so we send the recent turns with each message. */
const HISTORY = 12;
const KEEP = 30;

/** Which lists a write tool may have changed, so they refresh without a manual reload. */
function touchedBy(tool: string): string[] {
  if (/^(list|get)-/.test(tool)) return [];
  if (tool === 'close-meeting') return ['meetings', 'notes', 'todos'];
  if (tool === 'reschedule-meeting') return ['meetings', 'todos'];
  return ['todo', 'note', 'meeting'].filter((n) => tool.endsWith(`-${n}`)).map((n) => `${n}s`);
}

/** What each tool call amounted to: done, waiting for the person, or refused. */
function Trace({ calls }: { calls: ToolCallSummary[] }) {
  return (
    <View style={{ gap: 2, marginTop: space.xs }}>
      {calls.map((c, i) => {
        const outcome = c.outcome ?? (c.ok ? 'done' : 'refused');
        const tone =
          outcome === 'done'
            ? colors.muted
            : outcome === 'parked'
              ? colors.warnText
              : colors.danger;
        const label =
          outcome === 'done'
            ? 'done'
            : outcome === 'parked'
              ? `waiting for your approval${c.detail ? `: ${c.detail}` : ''}`
              : `refused${c.detail ? `: ${c.detail}` : ''}`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: calls in order within one turn
          <View key={i} style={[styles.row, { gap: space.xs, alignItems: 'flex-start' }]}>
            <Icon
              name={outcome === 'done' ? 'check' : outcome === 'parked' ? 'clock' : 'x-circle'}
              color={tone}
              size={14}
            />
            <Text style={[styles.muted, { color: tone, flexShrink: 1 }]}>
              <Text style={{ fontWeight: '600' }}>{c.tool}</Text> {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const SUGGESTIONS = ['today', 'add Book the site visit', 'list'];

export function Chat({ storageKey, compact = false }: { storageKey: string; compact?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      return JSON.parse(storage.get(storageKey) ?? '[]') as Turn[];
    } catch {
      return [];
    }
  });
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

  // Reloading keeps the recent conversation on this device.
  useEffect(() => storage.set(storageKey, JSON.stringify(turns.slice(-KEEP))), [storageKey, turns]);

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
        timeZone: timeZone(),
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
      setError(`The assistant couldn't answer: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Screens (the close form's "Draft with the assistant") send through this panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: register once; send reads refs
  useEffect(() => assistant.registerSend(send), []);

  const submit = () => {
    if (busy || !draft.trim()) return;
    send(draft);
    setDraft('');
  };

  return (
    <View style={[s.panel, compact && s.compact]}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.heading}>Assistant</Text>
        {turns.length > 0 && (
          <Button
            title="Clear"
            variant="subtle"
            onPress={() => setTurns([])}
            accessibilityLabel="Clear the conversation"
          />
        )}
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.length === 0 && (
          <View style={{ gap: space.sm }}>
            <Text style={styles.muted}>
              It acts for you through the same API as this app. Anything risky waits for your
              approval.
            </Text>
            <View style={[styles.row, { flexWrap: 'wrap' }]}>
              {SUGGESTIONS.map((t) => (
                <Button key={t} title={t} variant="secondary" onPress={() => send(t)} />
              ))}
            </View>
          </View>
        )}
        {turns.map((t, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
            key={i}
            style={[s.bubble, t.role === 'user' ? s.user : s.agent]}
            accessibilityLiveRegion={
              i === turns.length - 1 && t.role === 'assistant' ? 'polite' : 'none'
            }
          >
            <Text style={[styles.text, t.role === 'user' && { color: colors.primaryText }]}>
              {t.content}
            </Text>
            {t.toolCalls && t.toolCalls.length > 0 && <Trace calls={t.toolCalls} />}
          </View>
        ))}
        {busy && (
          <Text style={styles.muted} accessibilityLiveRegion="polite">
            Working…
          </Text>
        )}
      </ScrollView>
      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Ask the assistant"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Message to the assistant"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
        />
        <Button title="Send" icon="send" onPress={submit} busy={busy} disabled={!draft.trim()} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    flex: 1,
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
  },
  compact: { borderRadius: 0, borderWidth: 0, borderTopWidth: 1 },
  bubble: { borderRadius: 10, padding: space.md, maxWidth: '92%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  agent: { alignSelf: 'flex-start', backgroundColor: colors.agentBubble },
});
