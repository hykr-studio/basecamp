import {
  langOfVoice,
  UI_PARTS_TOPIC,
  VOICE_HEARS_ATTRIBUTE,
  VOICE_LANG_TOPIC,
  type VoiceLang,
} from '@app/contracts';
import { type Lang, scriptOf } from '@app/i18n';
import { useAISDKChat } from '@assistant-ui/ai-sdk';
import { useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import * as Speech from 'expo-speech';
import {
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
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
import { Platform } from 'react-native';
import { api } from '../api';
import { markApplied, useThreadId } from '../chat/ChatRuntime';
import { refreshTouched } from '../chat/touched';
import { timeZone } from '../framework/dates';
import { useLang } from '../framework/lang';
import { canListen, type Listener, listen } from './listen';
import { startAudio, stopAudio } from './setup';

/** What the worker is doing, from its lk.agent.state attribute; 'off' when no session runs. */
export type VoiceStatus = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking';

type Voice = {
  status: VoiceStatus;
  /** Why voice is not working (no microphone, today's minutes used, …), as a catalog key. */
  problem?: 'voice.noMic' | 'voice.budget' | 'voice.failed' | 'voice.noAnswer';
  muted: boolean;
  /** The microphone is on and published: mute means something. */
  micReady: boolean;
  lang: VoiceLang;
  start(): Promise<void>;
  stop(): Promise<void>;
  toggleMute(): Promise<void>;
  setLang(lang: VoiceLang): void;
  /** A typed line, answered as a spoken turn (and how fake mode is driven). */
  send(text: string): Promise<void>;
  /** How loud each side is right now, 0–1: the person's microphone, and the reply. */
  levels(): { you: number; reply: number };
  /** For the dev diagnostics line: who turns speech into words, and the room. */
  debug: { hears?: 'speech' | 'text'; transcribes: 'worker' | 'device' | 'nobody'; room?: string };
};

const VoiceContext = createContext<Voice | null>(null);

export function useVoice() {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error('useVoice outside VoiceProvider');
  return voice;
}

const STATES: Record<string, VoiceStatus> = {
  initializing: 'connecting',
  idle: 'listening',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
};

const newId = () => `voice-${Math.random().toString(36).slice(2)}`;

/** How long to wait for the voice worker to join before giving up. */
const JOIN_TIMEOUT_MS = 15_000;

/** The agent in the room, if it has joined. */
const agentIn = (room: Room | null) =>
  [...(room?.remoteParticipants.values() ?? [])].find((p) => p.kind === ParticipantKind.AGENT);

/**
 * One spoken turn while it happens: the person's message (built from the segments they said)
 * and the reply's. A new line starts a new turn once the reply has begun.
 */
type LiveTurn = { user?: string; reply: string; said: string; replied: boolean };

/**
 * Voice mode: a LiveKit room with the voice worker, on every platform (livekit-client; on
 * iOS and Android over react-native-webrtc). A spoken turn is written into the same chat as
 * a typed one while it happens (the person's words, the reply's tool parts and text), so it
 * renders through the same message and tool components; when it ends, the thread is loaded
 * again from the server, where the reply was saved before its stream ended.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const chat = useAISDKChat();
  const threadId = useThreadId();
  const queryClient = useQueryClient();
  const { setSpoken } = useLang();
  const [status, setStatus] = useState<VoiceStatus>('off');
  const [problem, setProblem] = useState<Voice['problem']>();
  const [muted, setMuted] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [lang, setLangState] = useState<VoiceLang>('auto');
  // The device reads the reply aloud when the worker sends no voice of its own (fake mode, or
  // speech-to-text without text-to-speech): the conversation still talks back.
  const [readingAloud, setReadingAloud] = useState(false);
  // What the worker takes in: 'speech', or only 'text' (then the device transcribes, if it can).
  const [hears, setHears] = useState<'speech' | 'text'>();
  const [roomName, setRoomName] = useState<string>();
  const listener = useRef<Listener | undefined>(undefined);
  const roomRef = useRef<Room | null>(null);
  // Each start gets a number; a start that is no longer the latest (End was pressed while it
  // connected) stops at its next step instead of bringing a session back.
  const attempt = useRef(0);
  const turn = useRef<LiveTurn | null>(null);
  const audioEls = useRef(new Set<HTMLMediaElement>());
  const langRef = useRef(lang);
  langRef.current = lang;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const edit = useCallback((fn: (messages: UIMessage[]) => UIMessage[]) => {
    chatRef.current?.setMessages(fn);
  }, []);

  /** The person said (or typed) something: a segment of the current turn, or a new turn. */
  const userSaid = useCallback(
    (segment: string, final: boolean) => {
      const current = turn.current;
      if (!current || current.replied || !current.user) {
        const next: LiveTurn = { user: newId(), reply: newId(), said: '', replied: false };
        turn.current = next;
        const text = segment;
        if (final) next.said = text;
        edit((m) => [
          ...m,
          { id: next.user as string, role: 'user', parts: [{ type: 'text', text }] },
          { id: next.reply, role: 'assistant', parts: [] },
        ]);
        return;
      }
      const text = [current.said, segment].filter(Boolean).join(' ');
      if (final) current.said = text;
      edit((m) =>
        m.map((x) => (x.id === current.user ? { ...x, parts: [{ type: 'text', text }] } : x)),
      );
    },
    [edit],
  );

  /** The reply changed: its tool parts and its words. A reply with no turn gets its own. */
  const replied = useCallback(
    (change: (parts: UIMessage['parts']) => UIMessage['parts']) => {
      let current = turn.current;
      if (!current) {
        current = { reply: newId(), said: '', replied: true };
        turn.current = current;
        const id = current.reply;
        edit((m) => [...m, { id, role: 'assistant', parts: change([]) }]);
        return;
      }
      current.replied = true;
      const id = current.reply;
      edit((m) => m.map((x) => (x.id === id ? { ...x, parts: change(x.parts) } : x)));
    },
    [edit],
  );

  const readAloud = useCallback((text: string, as: Lang) => {
    Speech.stop();
    Speech.speak(text, {
      language: `${as}-IN`,
      onStart: () => setReadingAloud(true),
      onDone: () => setReadingAloud(false),
      onStopped: () => setReadingAloud(false),
      onError: () => setReadingAloud(false),
    });
  }, []);

  /**
   * The turn is over: show the saved thread (ids, run links, everything as stored). Not while a
   * typed turn is streaming: that would replace it mid-reply. The next settle catches up.
   */
  const settle = useCallback(async () => {
    turn.current = null;
    const id = threadId();
    const busy = chatRef.current?.status === 'submitted' || chatRef.current?.status === 'streaming';
    if (!id || busy) return;
    try {
      const saved = (await api.threads.messages(id)) as unknown as UIMessage[];
      markApplied(saved);
      edit(() => saved);
    } catch {
      // Keep the live copy; the next load brings the saved one.
    }
  }, [edit, threadId]);

  const stop = useCallback(async () => {
    attempt.current += 1; // a start still connecting stops at its next step
    const room = roomRef.current;
    roomRef.current = null;
    Speech.stop();
    setReadingAloud(false);
    listener.current?.stop();
    listener.current = undefined;
    for (const el of audioEls.current) el.remove();
    audioEls.current.clear();
    setHears(undefined);
    setRoomName(undefined);
    setMuted(false);
    setMicReady(false);
    setStatus('off');
    setSpoken(undefined);
    await room?.disconnect();
    await stopAudio().catch(() => {});
    await settle();
  }, [setSpoken, settle]);

  const start = useCallback(async () => {
    if (roomRef.current || status !== 'off') return;
    const mine = ++attempt.current;
    const stale = () => attempt.current !== mine;
    setProblem(undefined);
    setMuted(false);
    setStatus('connecting');
    const room = new Room({ adaptiveStream: true, dynacast: true });
    try {
      const session = await api.voice.session({
        threadId: threadId(),
        lang: langRef.current,
        timeZone: timeZone(),
      });
      if (stale()) return;
      await startAudio();
      if (stale()) return void stopAudio().catch(() => {});
      roomRef.current = room;

      // The worker's state: in its attributes when it joins, then on every change. Joined is
      // enough to listen (typed lines are answered); its state refines it.
      const follow = (p: RemoteParticipant) => {
        if (p.kind !== ParticipantKind.AGENT || roomRef.current !== room) return;
        const takes = p.attributes[VOICE_HEARS_ATTRIBUTE];
        if (takes === 'speech' || takes === 'text') setHears(takes);
        const state = p.attributes['lk.agent.state'];
        setStatus(state ? (STATES[state] ?? 'listening') : 'listening');
      };
      room.on(RoomEvent.ParticipantConnected, follow);
      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
        if (p !== room.localParticipant) follow(p as RemoteParticipant);
      });
      // The worker left (its silence or time limit, or it failed): the session is over.
      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.kind === ParticipantKind.AGENT && roomRef.current === room) void stop();
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        // The browser needs an element to play the voice; native plays it through WebRTC.
        if (Platform.OS === 'web' && track.kind === Track.Kind.Audio)
          audioEls.current.add(track.attach());
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          audioEls.current.delete(el);
          el.remove();
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === room) void stop();
      });

      // Transcripts: the person's (from their own track, segment by segment) and the
      // worker's reply. A reply's stream ends when it is done: that is its final form.
      room.registerTextStreamHandler('lk.transcription', async (reader, from) => {
        const mine = from.identity === room.localParticipant.identity;
        let text = '';
        try {
          for await (const chunk of reader) {
            text += chunk;
            if (mine) userSaid(text, false);
            else
              replied((parts) => [
                ...parts.filter((p) => p.type !== 'text'),
                { type: 'text', text },
              ]);
          }
        } catch {
          return; // the stream broke (the session ended): nothing final to act on
        }
        if (mine) {
          if (reader.info.attributes?.['lk.transcription_final'] !== 'false') userSaid(text, true);
          return;
        }
        if (roomRef.current !== room) return;
        const spokenIn = scriptOf(text);
        if (spokenIn) setSpoken(spokenIn);
        const agent = agentIn(room);
        if (agent && agent.audioTrackPublications.size === 0)
          readAloud(text, spokenIn ?? langOfVoice(langRef.current) ?? 'en');
        await settle();
      });
      // What the reply shows: rendered by the chat's own tool part, like a typed turn's.
      room.registerTextStreamHandler(UI_PARTS_TOPIC, async (reader) => {
        try {
          const part = JSON.parse(await reader.readAll()) as UIMessage['parts'][number];
          replied((parts) => [...parts.filter((p) => p.type !== 'text'), part]);
          refreshTouched(queryClient, [part]);
        } catch {
          // A broken or partial part: skip it; the saved thread has it.
        }
      });

      await room.connect(session.url, session.token);
      if (stale()) return void room.disconnect();
      setRoomName(session.room);
      // Browsers may refuse audio started this far from the tap; the next tap (send, mute,
      // language) asks again.
      if (Platform.OS === 'web') await room.startAudio().catch(() => {});
      for (const p of room.remoteParticipants.values()) follow(p);
      // The worker joins within a second or two; if it never does, say so rather than spin.
      setTimeout(() => {
        if (roomRef.current === room && !agentIn(room))
          void stop().then(() => setProblem('voice.noAnswer'));
      }, JOIN_TIMEOUT_MS);
      // The microphone is published in the background: without one (or without permission)
      // the session still answers typed lines.
      room.localParticipant
        .setMicrophoneEnabled(true)
        .then(() => setMicReady(true))
        .catch(() => setProblem('voice.noMic'));
      const pinned = langOfVoice(langRef.current);
      if (pinned) setSpoken(pinned);
    } catch (e) {
      if (stale()) return;
      const code = (e as { status?: number }).status;
      setProblem(code === 429 ? 'voice.budget' : 'voice.failed');
      roomRef.current = null;
      await room.disconnect().catch(() => {});
      await stopAudio().catch(() => {});
      setStatus('off');
    }
  }, [queryClient, readAloud, replied, setSpoken, settle, status, stop, threadId, userSaid]);

  /** A tap is a chance to start audio the browser held back. */
  const unblockAudio = useCallback(() => {
    if (Platform.OS === 'web') void roomRef.current?.startAudio().catch(() => {});
  }, []);

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !micReady) return;
    unblockAudio();
    try {
      await room.localParticipant.setMicrophoneEnabled(muted);
      setMuted(!muted);
    } catch {
      setProblem('voice.noMic');
    }
  }, [muted, micReady, unblockAudio]);

  const setLang = useCallback(
    (next: VoiceLang) => {
      unblockAudio();
      setLangState(next);
      setSpoken(langOfVoice(next));
      listener.current?.setLang(`${langOfVoice(next) ?? 'en'}-IN`);
      void roomRef.current?.localParticipant
        .sendText(next, { topic: VOICE_LANG_TOPIC })
        .catch(() => {});
    },
    [setSpoken, unblockAudio],
  );

  const send = useCallback(
    async (text: string) => {
      const room = roomRef.current;
      if (!room) return;
      unblockAudio();
      Speech.stop(); // a new line interrupts the old answer, as speaking over it would
      userSaid(text, true);
      await room.localParticipant.sendText(text, { topic: 'lk.chat' }).catch(() => {
        setProblem('voice.failed');
      });
    },
    [userSaid, unblockAudio],
  );

  // The worker cannot hear (fake mode): transcribe here and send each phrase as a turn. Paused
  // while the answer is read aloud, so the device does not hear itself. Language changes go
  // through setLang, without restarting the listener.
  const sendRef = useRef(send);
  sendRef.current = send;
  const userSaidRef = useRef(userSaid);
  userSaidRef.current = userSaid;
  const live = status !== 'off';
  useEffect(() => {
    if (!live || hears !== 'text' || !canListen()) return;
    const l = listen(
      `${langOfVoice(langRef.current) ?? 'en'}-IN`,
      (text, final) => (final ? void sendRef.current(text) : userSaidRef.current(text, false)),
      (error) => setProblem(error === 'not-allowed' ? 'voice.noMic' : 'voice.failed'),
    );
    listener.current = l;
    return () => {
      l?.stop();
      if (listener.current === l) listener.current = undefined;
    };
  }, [live, hears]);
  useEffect(() => listener.current?.pause(readingAloud), [readingAloud]);

  const levels = useCallback(() => {
    const room = roomRef.current;
    return {
      you: muted ? 0 : (room?.localParticipant.audioLevel ?? 0),
      reply: agentIn(room)?.audioLevel ?? 0,
    };
  }, [muted]);

  // Leaving the app (sign-out, a reload) ends the session.
  useEffect(
    () => () => {
      Speech.stop();
      void roomRef.current?.disconnect();
    },
    [],
  );

  // While the device reads the answer, the assistant is speaking, whatever the worker says.
  const shown: VoiceStatus = status !== 'off' && readingAloud ? 'speaking' : status;
  const debug = useMemo(
    () => ({
      hears,
      transcribes:
        hears === 'speech'
          ? ('worker' as const)
          : hears === 'text' && canListen()
            ? ('device' as const)
            : ('nobody' as const),
      room: roomName,
    }),
    [hears, roomName],
  );
  const value = useMemo(
    () => ({
      status: shown,
      problem,
      muted,
      micReady,
      lang,
      start,
      stop,
      toggleMute,
      setLang,
      send,
      levels,
      debug,
    }),
    [shown, problem, muted, micReady, lang, start, stop, toggleMute, setLang, send, levels, debug],
  );
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}
