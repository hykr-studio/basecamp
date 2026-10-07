import type { ChatStreamRequest, Surface } from '@app/contracts';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import { type AssistantRuntime, AssistantRuntimeProvider } from '@assistant-ui/react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';
import { authHeaders, credentials } from '../api';
import { currentPage, useCanvas } from '../canvas/store';
import { API_URL } from '../config';
import { useAssistant } from '../framework/assistant-context';
import { timeZone } from '../framework/dates';
import { storage } from '../framework/storage';
import { touchedBy } from './touched';

const RuntimeContext = createContext<AssistantRuntime | null>(null);

/** The assistant's runtime, for code outside assistant-ui's primitives (composer text, canvas). */
export function useAssistantRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useAssistantRuntime outside ChatRuntime');
  return runtime;
}

/** How many messages a reload keeps on this device. */
const KEEP = 30;

/**
 * The app can always show things inline and on the canvas (beside the chat when wide, a
 * full-screen sheet on a phone), so every turn declares both.
 */
const SURFACES: Surface[] = ['inline', 'canvas'];

/** Where a person's conversation is kept on this device (v2: AI SDK UI messages). */
export const conversationKey = (userId: string) => `chat:v2:${userId}`;

/** A message the runtime can replay: anything else (an older format, a hand edit) is dropped. */
const isUIMessage = (m: unknown): m is UIMessage =>
  typeof m === 'object' &&
  m !== null &&
  typeof (m as UIMessage).id === 'string' &&
  ((m as UIMessage).role === 'user' || (m as UIMessage).role === 'assistant') &&
  Array.isArray((m as UIMessage).parts);

function load(key: string): UIMessage[] {
  try {
    const saved: unknown = JSON.parse(storage.get(key) ?? '[]');
    return Array.isArray(saved) ? saved.filter(isUIMessage) : [];
  } catch {
    return [];
  }
}

/**
 * The assistant's runtime: one per signed-in person, shared by the side panel, the phone
 * sheet and the canvas. It streams turns from /api/chat (the AI SDK UI message stream) and
 * keeps the recent conversation on this device.
 */
export function ChatRuntime({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const assistant = useAssistant();
  const queryClient = useQueryClient();
  // Read per request, so each turn sends where the person is right now.
  const contextRef = useRef(assistant.context);
  contextRef.current = assistant.context;

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: `${API_URL}/api/chat`,
        credentials,
        headers: authHeaders,
        // Our own body: the server reads text, surfaces and context, and nothing that could
        // add tools or instructions (the transport would otherwise forward both).
        prepareSendMessagesRequest: ({ messages }) => {
          const body: ChatStreamRequest = {
            messages: messages.slice(-12).map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts.filter((p) => p.type === 'text'),
            })),
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
    const messages = load(storageKey);
    // Canvas intents already in the history were applied when they arrived: never again.
    const { applied } = useCanvas.getState();
    for (const m of messages)
      for (const p of m.parts) if ('toolCallId' in p) applied.add(String(p.toolCallId));
    return messages;
  }, [storageKey]);

  const runtime = useChatRuntime({
    transport,
    messages: initial,
    onFinish: ({ messages }) => {
      storage.set(storageKey, JSON.stringify(messages.slice(-KEEP)));
      // A write tool changed data: refresh the lists that might show it.
      const names = new Set<string>();
      const last = messages.at(-1);
      for (const part of last?.parts ?? []) {
        if (part.type.startsWith('tool-'))
          for (const n of touchedBy(part.type.slice(5))) names.add(n);
      }
      if (names.size > 0) names.add('approvals');
      for (const n of names) queryClient.invalidateQueries({ queryKey: [n] });
    },
  });

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

  return (
    <RuntimeContext.Provider value={runtime}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeContext.Provider>
  );
}

/** Forget this device's copy of the conversation. */
export function clearConversation(storageKey: string) {
  storage.remove(storageKey);
}
