import type { ChatContext } from '@app/contracts';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

/**
 * Where the person is, for the assistant ("close this one"), and a way for a screen to
 * send the assistant a message (the close form's "Draft from notes").
 */
type Assistant = {
  context: ChatContext | undefined;
  setContext: (c: ChatContext | undefined) => void;
  /** Set by the chat panel; screens call it to send a message as the person. */
  send: (text: string) => Promise<void>;
  registerSend: (fn: (text: string) => Promise<void>) => void;
  /** Bring the thread into view (the phone layout opens its sheet; wide layouts show it). */
  reveal: () => void;
  registerReveal: (fn: () => void) => void;
};

const AssistantContext = createContext<Assistant | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<ChatContext | undefined>();
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});
  const revealRef = useRef<() => void>(() => {});
  return (
    <AssistantContext.Provider
      value={{
        context,
        setContext,
        send: (text) => sendRef.current(text),
        registerSend: (fn) => {
          sendRef.current = fn;
        },
        reveal: () => revealRef.current(),
        registerReveal: (fn) => {
          revealRef.current = fn;
        },
      }}
    >
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant() {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('useAssistant outside AssistantProvider');
  return value;
}

/**
 * Call from a screen: tells the assistant where the person is while it is shown. Pass
 * undefined for a screen shown inside the canvas, which is not where the person navigated.
 */
export function useScreenContext(context: ChatContext | undefined) {
  const { setContext } = useAssistant();
  const key = JSON.stringify(context ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the context's content
  useEffect(() => {
    if (!context) return;
    setContext(context);
    return () => setContext(undefined);
  }, [key]);
}
