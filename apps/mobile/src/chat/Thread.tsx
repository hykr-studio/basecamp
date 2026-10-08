import {
  AuiIf,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react-native';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STUDIO_URL } from '../config';
import { appDomain } from '../domain';
import { LeaveChat, useApprovalStatus } from '../framework/ApprovalCard';
import { AssistantMark } from '../framework/AssistantMark';
import { clock } from '../framework/dates';
import { Icon } from '../framework/Icon';
import { inApp, webHref } from '../framework/web-link';
import { colors } from '../theme';
import { MicButton, VoiceBar } from '../voice/VoiceBar';
import { useVoice } from '../voice/VoiceProvider';
import { useAssistantRuntime, useClearConversation } from './ChatRuntime';
import { useDraft } from './draft';
import { ToolPart } from './ToolPart';

const INPUT_ID = 'assistant-input';
const focusInput = () => {
  if (Platform.OS === 'web') document.getElementById(INPUT_ID)?.focus();
};

/**
 * The words a reply said about a request it parked ("Nothing changes until you approve it"),
 * once that request is decided: kept as written, muted, with what happened since.
 */
type Superseded = { texts: ReadonlySet<string>; note: string } | null;
const SupersededContext = createContext<Superseded>(null);

function TextPart({ text }: { text: string }) {
  const superseded = useContext(SupersededContext);
  if (superseded?.texts.has(text)) {
    return (
      <View className="gap-1">
        <Text style={{ color: colors.muted }}>{text}</Text>
        <View className="flex-row items-center gap-1">
          <Icon name="corner-down-right" color={colors.muted} size={14} />
          <Text variant="muted" style={{ color: colors.muted }}>
            {superseded.note}
          </Text>
        </View>
      </View>
    );
  }
  return <Text>{text}</Text>;
}

/** The first request this reply parked, and the text written after it, as one stable key. */
function useParkedInMessage(): { approvalId: string; texts: string[] } | null {
  const key = useAuiState((s) => {
    const parts = s.message.parts as readonly {
      type: string;
      text?: string;
      result?: unknown;
    }[];
    const at = parts.findIndex((p) => {
      const r = (p.result as { result?: { status?: string } } | undefined)?.result;
      return p.type === 'tool-call' && r?.status === 'needs_approval';
    });
    if (at < 0) return '';
    const approvalId = (parts[at].result as { result: { approval?: { id?: string } } }).result
      .approval?.id;
    if (!approvalId) return '';
    const texts = parts.slice(at + 1).flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []));
    return JSON.stringify({ approvalId, texts });
  });
  return useMemo(() => (key ? JSON.parse(key) : null), [key]);
}

const SINCE: Record<string, string> = {
  approved: 'Since approved by you',
  rejected: 'Since rejected by you; nothing changed',
  expired: 'Since expired; nothing changed',
  failed: "Since approved, but it couldn't be done",
};

function useSuperseded(): Superseded {
  const parked = useParkedInMessage();
  const { approval, status } = useApprovalStatus(parked?.approvalId);
  return useMemo(() => {
    if (!parked || !status || status === 'pending' || !SINCE[status]) return null;
    const at = approval?.decidedAt ? ` · ${clock(approval.decidedAt)}` : '';
    return { texts: new Set(parked.texts), note: `${SINCE[status]}${at}` };
  }, [parked, status, approval?.decidedAt]);
}

/** Dev only: the run's trace in Studio (the run id is the trace id). */
function RunLink() {
  const runId = useAuiState(
    (s) => (s.message.metadata as { custom?: { runId?: string } } | undefined)?.custom?.runId,
  );
  if (!__DEV__ || !runId) return null;
  return (
    <Pressable
      accessibilityRole="link"
      {...webHref(`${STUDIO_URL}/traces/${runId}`)}
      onPress={inApp(() => Linking.openURL(`${STUDIO_URL}/traces/${runId}`))}
      className="self-start"
    >
      <Text variant="muted" className="text-primary underline">
        Run {runId.slice(0, 8)}: open the trace in Studio
      </Text>
    </Pressable>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="max-w-[92%] self-end rounded-[10px] bg-user-bubble p-3">
      <MessagePrimitive.Parts
        components={{ Text: ({ text }) => <Text className="text-primary-text">{text}</Text> }}
      />
    </MessagePrimitive.Root>
  );
}

/**
 * The assistant's turn: its mark, then its words and what it did, in plain rows on the
 * panel (no card in the card). A hairline in its hue keeps the turn together.
 */
function AssistantMessage() {
  const superseded = useSuperseded();
  return (
    <MessagePrimitive.Root className="max-w-full flex-row items-start gap-2">
      <AssistantMark size={24} />
      <View className="shrink grow gap-1.5 border-assistant-border border-l pl-3">
        <SupersededContext.Provider value={superseded}>
          <MessagePrimitive.Parts components={{ Text: TextPart, tools: { Fallback: ToolPart } }} />
        </SupersededContext.Provider>
        <ErrorPrimitive.Root>
          <ErrorPrimitive.Message className="text-danger text-small" />
        </ErrorPrimitive.Root>
        <RunLink />
      </View>
    </MessagePrimitive.Root>
  );
}

/** The message box grows with what is typed or pasted, up to this, then scrolls. */
const MIN_INPUT = 44;
const MAX_INPUT = 168;

/**
 * The message box and Send. It takes several lines, so pasted notes keep their line breaks
 * ("close this one" and the notes under it). On the web Enter sends and Shift+Enter starts a
 * new line; on a phone the return key starts a new line and Send sends. The text lives in a
 * small store of its own, not assistant-ui's (a store round-trip per keystroke reset the
 * cursor on iOS) and not this component's (the phone sheet unmounts when it closes).
 */
function Composer({ compact }: { compact: boolean }) {
  const runtime = useAssistantRuntime();
  const voice = useVoice();
  const draft = useDraft((d) => d.text);
  const setDraft = useDraft((d) => d.set);
  const running = useAuiState((s) => s.thread.isRunning);
  const [height, setHeight] = useState(MIN_INPUT);
  // While voice connects there is nowhere to send a line yet: wait, rather than lose it.
  const idle = !draft.trim() || running || voice.status === 'connecting';
  const tone = idle ? colors.disabledText : colors.primaryText;
  const send = () => {
    if (idle) return;
    const text = draft.trim();
    // While voice is on, a typed line is answered as a spoken turn.
    if (voice.status !== 'off') void voice.send(text);
    else runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] });
    setDraft('');
  };

  // The web measures the text itself: a textarea's scrollHeight never shrinks below its
  // current height, so collapse it first, read, then set the height that fits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text or the width changes
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = document.getElementById(INPUT_ID) as HTMLTextAreaElement | null;
    if (!el) return;
    el.style.resize = 'none';
    el.style.height = '0px';
    const fits = Math.min(MAX_INPUT, Math.max(MIN_INPUT, el.scrollHeight + 2));
    el.style.height = `${fits}px`;
    el.style.overflowY = el.scrollHeight + 2 > MAX_INPUT ? 'auto' : 'hidden';
  }, [draft, compact]);

  return (
    <View className="gap-2">
      <VoiceBar compact={compact} />
      <View className="flex-row items-end gap-2">
        <TextInput
          nativeID={INPUT_ID}
          value={draft}
          onChangeText={setDraft}
          multiline
          // Native: grow with the content (the web sizes itself above).
          onContentSizeChange={(e) =>
            Platform.OS !== 'web' &&
            setHeight(
              Math.min(MAX_INPUT, Math.max(MIN_INPUT, e.nativeEvent.contentSize.height + 22)),
            )
          }
          onKeyPress={(e) => {
            if (Platform.OS !== 'web') return;
            const k = e.nativeEvent as unknown as {
              key: string;
              shiftKey?: boolean;
              isComposing?: boolean;
            };
            if (k.key !== 'Enter' || k.shiftKey || k.isComposing) return;
            e.preventDefault();
            send();
          }}
          accessibilityLabel="Message to the assistant"
          accessibilityHint={
            Platform.OS === 'web'
              ? 'Enter sends; Shift+Enter starts a new line. Press / anywhere to come back here.'
              : undefined
          }
          placeholder="e.g. today"
          placeholderTextColor={colors.placeholder}
          textAlignVertical="top"
          style={Platform.OS === 'web' ? undefined : { height }}
          className="min-h-11 flex-1 rounded-control border border-border bg-card px-3 py-2.5 text-body text-text"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: idle }}
          disabled={idle}
          onPress={send}
          className={`min-h-11 flex-row items-center gap-2 rounded-control px-4 ${idle ? 'bg-disabled-bg' : 'bg-primary'}`}
        >
          <Icon name="send" color={tone} size={16} />
          <Text className="font-semibold" style={{ color: tone }}>
            Send
          </Text>
        </Pressable>
        <MicButton />
      </View>
    </View>
  );
}

function Help({ onPick }: { onPick: (text: string) => void }) {
  return (
    <View className="gap-1">
      <Text variant="muted">
        It acts for you through the same API as this app. Anything risky waits for your approval.
      </Text>
      {appDomain.suggestions.map((c) => (
        <Pressable
          key={c.text}
          accessibilityRole="button"
          accessibilityLabel={`Use: ${c.text}`}
          onPress={() => onPick(c.text.includes('<') ? c.text.replace(/<[^>]+>/, '') : c.text)}
          className="-mx-2 min-h-11 flex-row items-center gap-2 rounded-control px-2 py-1 web:hover:bg-bg"
        >
          <View className="flex-1 gap-0.5">
            <Text className="font-semibold text-primary">{c.text}</Text>
            <Text variant="muted">{c.what}</Text>
          </View>
          <Icon name="corner-down-left" color={colors.muted} size={16} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The assistant's thread, on assistant-ui's React Native primitives. Text streams in;
 * tool calls render through ToolPart. Used as the side panel and as the phone sheet.
 */
export function Thread({ compact = false, onClose }: { compact?: boolean; onClose?: () => void }) {
  const clear = useClearConversation();
  const voice = useVoice();
  const empty = useAuiState((s) => s.thread.messages.length === 0);
  const [help, setHelp] = useState(false);

  // "/" jumps to the message box from anywhere, unless you are already typing.
  useEffect(() => {
    if (Platform.OS !== 'web' || compact) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      focusInput();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact]);

  const setDraft = useDraft((d) => d.set);
  const pick = (text: string) => {
    setDraft(text);
    focusInput();
  };

  return (
    <LeaveChat.Provider value={onClose}>
      <View
        className={
          compact
            ? 'flex-1 gap-3 border-t border-border bg-card p-4'
            : 'flex-1 gap-3 rounded-card border border-border bg-card p-4'
        }
      >
        <ThreadPrimitive.Root className="flex-1 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <AssistantMark size={24} />
              <Text variant="heading">Assistant</Text>
            </View>
            <View className="flex-row items-center">
              <Button variant="subtle" onPress={() => setHelp(!help)}>
                <Text>{help ? 'Hide commands' : 'What can it do?'}</Text>
              </Button>
              {!empty && (
                <Button
                  variant="subtle"
                  accessibilityLabel="Clear the conversation"
                  onPress={() => {
                    // A new conversation ends a voice session: it was bound to the old thread.
                    void voice.stop().then(clear);
                  }}
                >
                  <Text>Clear</Text>
                </Button>
              )}
              {onClose && (
                <Button
                  variant="subtle"
                  size="icon"
                  accessibilityLabel="Close the assistant"
                  onPress={onClose}
                >
                  <Icon name="x" color={colors.primary} size={18} />
                </Button>
              )}
            </View>
          </View>

          {/* The help scrolls with the messages, so the message box always stays in view. */}
          <ThreadPrimitive.MessagesFlatList
            className="flex-1"
            contentContainerClassName="gap-2 pb-2"
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={help || empty ? <Help onPick={pick} /> : null}
          >
            {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.MessagesFlatList>

          <AuiIf condition={(s) => s.thread.isRunning}>
            <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
              <ActivityIndicator size="small" color={colors.assistant} />
              <Text className="text-assistant">Working on it…</Text>
            </View>
          </AuiIf>

          <Composer compact={compact} />
        </ThreadPrimitive.Root>
      </View>
    </LeaveChat.Provider>
  );
}
