import type { ChatStreamRequest, Surface } from '@app/contracts';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, View } from 'react-native';
import { api, authHeaders, credentials } from '../api';
import { currentPage, useCanvas } from '../canvas/store';
import { API_URL } from '../config';
import { useAssistant } from '../framework/assistant-context';
import { timeZone } from '../framework/dates';
import { colors } from '../theme';
import { VoiceProvider } from '../voice/VoiceProvider';
import { refreshTouched } from './touched';

type Chat = {
  runtime: AssistantRuntime;
  clear: () => Promise<void>;
  /** The thread turns go into (typed and spoken alike). */
  threadId: () => string | undefined;
};
const ChatContext = createContext<Chat | null>(null);

function useChat() {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error('useChat outside ChatRuntime');
  return chat;
}

/** The assistant's runtime, for code outside assistant-ui's primitives (composer text, canvas). */
export const useAssistantRuntime = () => useChat().runtime;

/** Start a new conversation: the server keeps the old one, and the next turn goes to the new one. */
export const useClearConversation = () => useChat().clear;

export const useThreadId = () => useChat().threadId;

/** Canvas intents already in the history were applied when they arrived: never again. */
export function markApplied(messages: UIMessage[]) {
  const { applied } = useCanvas.getState();
  for (const m of messages)
    for (const p of m.parts) if ('toolCallId' in p) applied.add(String(p.toolCallId));
}

/**
 * The app can always show things inline and on the canvas (beside the chat when wide, a
 * full-screen sheet on a phone), so every turn declares both.
 */
const SURFACES: Surface[] = ['inline', 'canvas'];

/** The text of a person's message: the server keeps the history, so a turn sends only this. */
const textOf = (m: UIMessage | undefined) =>
  (m?.parts ?? [])
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();

type Loaded = { threadId?: string; messages: UIMessage[] };

/** The person's current conversation, from the server (empty if it cannot be reached). */
async function loadCurrent(): Promise<Loaded> {
  try {
    const thread = await api.threads.current();
    const messages = (await api.threads.messages(thread.id)) as unknown as UIMessage[];
    return { threadId: thread.id, messages };
  } catch {
    // The next turn still lands in the current thread: the server finds it.
    return { messages: [] };
  }
}

/**
 * The assistant's runtime: one per signed-in person, shared by the side panel, the phone
 * sheet and the canvas. The conversation lives on the server (typed, spoken and WhatsApp turns
 * share it): this loads the current thread, then streams each turn from /api/chat (the AI SDK
 * UI message stream), sending only the new message.
 */
export function ChatRuntime({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    loadCurrent().then((l) => live && setLoaded(l));
    return () => {
      live = false;
    };
  }, []);
  if (!loaded)
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ActivityIndicator
          style={{ marginTop: 96 }}
          color={colors.primary}
          accessibilityLabel="Loading your conversation"
        />
      </View>
    );
  return <Runtime loaded={loaded}>{children}</Runtime>;
}

function Runtime({ loaded, children }: { loaded: Loaded; children: ReactNode }) {
  const assistant = useAssistant();
  const queryClient = useQueryClient();
  // Read per request, so each turn sends where the person is right now.
  const contextRef = useRef(assistant.context);
  contextRef.current = assistant.context;
  const threadRef = useRef(loaded.threadId);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${API_URL}/api/chat`,
        credentials,
        headers: authHeaders,
        // Our own body: the server reads the thread, the new text, surfaces and context, and
        // nothing that could add tools or instructions (the transport would otherwise forward both).
        prepareSendMessagesRequest: ({ messages }) => {
          const body: ChatStreamRequest = {
            threadId: threadRef.current,
            message: textOf(messages.findLast((m) => m.role === 'user')),
            surfaces: SURFACES,
            timeZone: timeZone(),
            // Where the person is, and the page on the canvas (for "only overdue" and "save this").
            context: { ...contextRef.current, canvas: currentPage() },
          };
          return { body };
        },
      }),
    [],
  );

  const initial = useMemo(() => {
    markApplied(loaded.messages);
    return loaded.messages;
  }, [loaded]);

  const runtime = useChatRuntime({
    transport,
    messages: initial,
    onFinish: ({ message }) => {
      // A reply from a thread that was cleared meanwhile does not take the new one's place.
      const meta = message.metadata as { threadId?: string } | undefined;
      if (meta?.threadId && !threadRef.current) threadRef.current = meta.threadId;
      refreshTouched(queryClient, message.parts);
    },
  });

  // The new thread first: if it cannot be made, the conversation stays as it was.
  const clear = useCallback(async () => {
    const fresh = await api.threads.create().catch(() => undefined);
    if (!fresh) return;
    threadRef.current = fresh.id;
    runtime.thread.reset();
  }, [runtime]);

  // Screens send through the assistant too ("Draft with the assistant"): resolves when the
  // turn ends, so the button can show it is working.
  useEffect(() => {
    assistant.registerSend(
      (text) =>
        new Promise<void>((resolve) => {
          runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] });
          const off = runtime.thread.subscribe(() => {
            if (!runtime.thread.getState().isRunning) {
              off();
              resolve();
            }
          });
        }),
    );
  }, [assistant, runtime]);

  const chat = useMemo(
    () => ({ runtime, clear, threadId: () => threadRef.current }),
    [runtime, clear],
  );
  return (
    <ChatContext.Provider value={chat}>
      <AssistantRuntimeProvider runtime={runtime}>
        <VoiceProvider>{children}</VoiceProvider>
      </AssistantRuntimeProvider>
    </ChatContext.Provider>
  );
}
