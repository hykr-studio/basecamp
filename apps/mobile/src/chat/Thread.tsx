import {
  AuiIf,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STUDIO_URL } from '../config';
import { appDomain } from '../domain';
import { AssistantMark } from '../framework/AssistantMark';
import { Icon } from '../framework/Icon';
import { colors } from '../theme';
import { clearConversation, useAssistantRuntime } from './ChatRuntime';
import { ToolPart } from './ToolPart';

const INPUT_ID = 'assistant-input';
const focusInput = () => {
  if (Platform.OS === 'web') document.getElementById(INPUT_ID)?.focus();
};

function TextPart({ text }: { text: string }) {
  return <Text>{text}</Text>;
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
      onPress={() => Linking.openURL(`${STUDIO_URL}/traces/${runId}`)}
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

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="max-w-full flex-row items-start gap-2">
      <AssistantMark size={24} />
      <View className="shrink gap-1 rounded-[10px] border border-assistant-border bg-assistant-tint p-3">
        <MessagePrimitive.Parts components={{ Text: TextPart, tools: { Fallback: ToolPart } }} />
        <ErrorPrimitive.Root>
          <ErrorPrimitive.Message className="text-danger text-small" />
        </ErrorPrimitive.Root>
        <RunLink />
      </View>
    </MessagePrimitive.Root>
  );
}

/**
 * The message box and Send. The text lives in this component's own state (like every other
 * input in the app), not assistant-ui's store: a store round-trip per keystroke reset the
 * cursor on iOS and scrambled fast typing. Enter (web) or the keyboard's Send key submits.
 */
function Composer({
  draft,
  setDraft,
  compact,
}: {
  draft: string;
  setDraft: (text: string) => void;
  compact: boolean;
}) {
  const runtime = useAssistantRuntime();
  const running = useAuiState((s) => s.thread.isRunning);
  const idle = !draft.trim() || running;
  const tone = idle ? colors.disabledText : colors.primaryText;
  const send = () => {
    if (idle) return;
    runtime.thread.append({ role: 'user', content: [{ type: 'text', text: draft.trim() }] });
    setDraft('');
  };
  return (
    <View className="flex-row items-center gap-2">
      <TextInput
        nativeID={INPUT_ID}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={send}
        submitBehavior="submit"
        returnKeyType="send"
        accessibilityLabel="Message to the assistant"
        placeholder={compact ? 'e.g. today' : 'e.g. today   (press / to focus)'}
        placeholderTextColor={colors.placeholder}
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
export function Thread({
  storageKey,
  compact = false,
  onClose,
}: {
  storageKey: string;
  compact?: boolean;
  onClose?: () => void;
}) {
  const runtime = useAssistantRuntime();
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

  const [draft, setDraft] = useState('');
  const pick = (text: string) => {
    setDraft(text);
    focusInput();
  };

  return (
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
                  runtime.thread.reset();
                  clearConversation(storageKey);
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

        <Composer draft={draft} setDraft={setDraft} compact={compact} />
      </ThreadPrimitive.Root>
    </View>
  );
}
