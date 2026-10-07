import type { ChatMessage, ToolCallSummary } from '@app/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '../api';
import { STUDIO_URL } from '../config';
import { AssistantMark } from '../framework/AssistantMark';
import { useAssistant } from '../framework/assistant-context';
import { timeZone } from '../framework/dates';
import { errorMessage, useApprovals } from '../framework/hooks';
import { isHovered } from '../framework/hover';
import { Icon, type IconName } from '../framework/Icon';
import { storage } from '../framework/storage';
import { colors, space, styles } from '../theme';
import { Button } from './Button';

type Turn = ChatMessage & { toolCalls?: ToolCallSummary[]; runId?: string };

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

const COMMANDS: { text: string; what: string }[] = [
  { text: 'today', what: "today's meetings and what is due" },
  { text: 'add Book the site visit', what: 'adds a to-do' },
  { text: 'done Book the site visit', what: 'ticks it off' },
  { text: 'delete Book the site visit', what: 'asks you to approve the delete' },
  { text: 'close <meeting>', what: 'then paste notes on the next lines; waits for your approval' },
  { text: 'move <meeting> to 2026-10-31', what: 'moves it and its to-dos' },
];

/** A parked call, followed: once the person decides, the line says what became of it. */
function ParkedLine({ call }: { call: ToolCallSummary }) {
  const { approvals } = useApprovals();
  const pending = call.approvalId ? approvals.some((a) => a.id === call.approvalId) : true;
  const decided = useQuery({
    queryKey: ['approval', call.approvalId],
    queryFn: () => api.getApproval(call.approvalId as string),
    enabled: Boolean(call.approvalId) && !pending,
    // A pending answer is never final: fetch again once it has left the waiting list.
    staleTime: 0,
  });
  const status = pending ? 'pending' : decided.data?.status;
  const [icon, tone, label]: [IconName, string, string] =
    status === 'approved'
      ? ['check-circle', colors.success, 'approved by you']
      : status === 'rejected'
        ? ['slash', colors.muted, 'rejected by you; nothing changed']
        : status === 'failed'
          ? [
              'x-circle',
              colors.danger,
              `approved, but couldn't be done: ${decided.data?.failureReason ?? ''}`,
            ]
          : status === 'expired'
            ? ['clock', colors.muted, 'expired; nothing changed']
            : [
                'clock',
                colors.approvalText,
                `waiting for your approval${call.detail ? `: ${call.detail}` : ''}`,
              ];
  return <Line icon={icon} tone={tone} tool={call.tool} label={label} />;
}

function Line({
  icon,
  tone,
  tool,
  label,
}: {
  icon: IconName;
  tone: string;
  tool: string;
  label: string;
}) {
  return (
    <View style={[styles.row, { gap: space.xs, alignItems: 'flex-start' }]}>
      <Icon name={icon} color={tone} size={14} />
      <Text style={[styles.muted, { color: tone, flexShrink: 1 }]}>
        <Text style={{ fontWeight: '600' }}>{tool}</Text> {label}
      </Text>
    </View>
  );
}

/** What each tool call amounted to: done, waiting (then decided), or refused. */
function Trace({ calls, runId }: { calls: ToolCallSummary[]; runId?: string }) {
  return (
    <View style={{ gap: 2, marginTop: space.xs }}>
      {calls.map((c, i) => {
        const outcome = c.outcome ?? (c.ok ? 'done' : 'refused');
        const key = `${i}:${c.tool}`;
        if (outcome === 'parked') return <ParkedLine key={key} call={c} />;
        return outcome === 'done' ? (
          <Line key={key} icon="check" tone={colors.muted} tool={c.tool} label="done" />
        ) : (
          <Line
            key={key}
            icon="x-circle"
            tone={colors.danger}
            tool={c.tool}
            label={`refused${c.detail ? `: ${c.detail}` : ''}`}
          />
        );
      })}
      {__DEV__ && runId && (
        <Pressable
          accessibilityRole="link"
          onPress={() => Linking.openURL(`${STUDIO_URL}/traces/${runId}`)}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text style={[styles.muted, { color: colors.primary, textDecorationLine: 'underline' }]}>
            Run {runId.slice(0, 8)}: open the trace in Studio
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function Chat({
  storageKey,
  compact = false,
  onClose,
}: {
  storageKey: string;
  compact?: boolean;
  onClose?: () => void;
}) {
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
  const [help, setHelp] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const input = useRef<TextInput>(null);
  const queryClient = useQueryClient();
  const assistant = useAssistant();
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const contextRef = useRef(assistant.context);
  contextRef.current = assistant.context;

  // Reloading keeps the recent conversation on this device.
  useEffect(() => storage.set(storageKey, JSON.stringify(turns.slice(-KEEP))), [storageKey, turns]);

  // "/" jumps to the message box from anywhere, unless you are already typing.
  useEffect(() => {
    if (Platform.OS !== 'web' || compact) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact]);

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
        {
          role: 'assistant',
          content: res.reply || '(no reply)',
          toolCalls: res.toolCalls,
          runId: res.runId,
        },
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
        <View style={styles.row}>
          <AssistantMark size={24} />
          <Text style={styles.heading}>Assistant</Text>
        </View>
        <View style={styles.row}>
          <Button
            title={help ? 'Hide commands' : 'What can it do?'}
            variant="subtle"
            onPress={() => setHelp(!help)}
          />
          {turns.length > 0 && (
            <Button
              title="Clear"
              variant="subtle"
              onPress={() => setTurns([])}
              accessibilityLabel="Clear the conversation"
            />
          )}
          {onClose && (
            <Button
              title="Close the assistant"
              icon="x"
              iconOnly
              variant="subtle"
              onPress={onClose}
            />
          )}
        </View>
      </View>
      {(help || turns.length === 0) && (
        <View style={s.help}>
          <Text style={styles.muted}>
            It acts for you through the same API as this app. Deletes and meeting closes wait for
            your approval.
          </Text>
          {COMMANDS.map((c) => (
            <Pressable
              key={c.text}
              accessibilityRole="button"
              accessibilityLabel={`Use: ${c.text}`}
              onPress={() => {
                setDraft(c.text.includes('<') ? c.text.replace(/<[^>]+>/, '') : c.text);
                input.current?.focus();
              }}
              style={(state) => [s.command, isHovered(state) && { backgroundColor: colors.bg }]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.text, { fontWeight: '600', color: colors.primary }]}>
                  {c.text}
                </Text>
                <Text style={styles.muted}>{c.what}</Text>
              </View>
              <Icon name="corner-down-left" color={colors.muted} size={16} />
            </Pressable>
          ))}
        </View>
      )}
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.map((t, i) =>
          t.role === 'user' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
            <View key={i} style={[s.bubble, s.user]}>
              <Text style={[styles.text, { color: colors.primaryText }]}>{t.content}</Text>
            </View>
          ) : (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
              key={i}
              style={s.agentTurn}
              accessibilityLiveRegion={i === turns.length - 1 ? 'polite' : 'none'}
            >
              <AssistantMark size={24} />
              <View style={[s.bubble, s.agent]}>
                <Text style={styles.text}>{t.content}</Text>
                {t.toolCalls && t.toolCalls.length > 0 && (
                  <Trace calls={t.toolCalls} runId={t.runId} />
                )}
              </View>
            </View>
          ),
        )}
        {busy && (
          <View style={s.agentTurn} accessibilityLiveRegion="polite">
            <AssistantMark size={24} />
            <View style={[s.bubble, s.agent, styles.row]}>
              <ActivityIndicator size="small" color={colors.assistant} />
              <Text style={[styles.text, { color: colors.assistant }]}>Working on it…</Text>
            </View>
          </View>
        )}
      </ScrollView>
      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <View style={styles.row}>
        <TextInput
          ref={input}
          style={[styles.input, { flex: 1 }]}
          placeholder={compact ? 'e.g. today' : 'e.g. today   (press / to focus)'}
          placeholderTextColor={colors.placeholder}
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
  help: { gap: space.xs },
  command: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: 8,
    minHeight: 44,
  },
  bubble: { borderRadius: 10, padding: space.md, maxWidth: '92%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  agentTurn: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, maxWidth: '100%' },
  agent: {
    flexShrink: 1,
    backgroundColor: colors.assistantTint,
    borderWidth: 1,
    borderColor: colors.assistantBorder,
  },
});
