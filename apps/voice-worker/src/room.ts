import {
  parseVoiceRoom,
  UI_PARTS_TOPIC,
  VOICE_HEARS_ATTRIBUTE,
  VOICE_LANG_TOPIC,
  VoiceDispatch,
  VoiceLang,
} from '@app/contracts';
import { type JobContext, log } from '@livekit/agents';
import { RoomEvent, type TextStreamReader } from '@livekit/rtc-node';
import { config } from './config.js';
import { LangState } from './lang.js';
import { apiFor, type Person, type UiPart } from './turn.js';

/** The framework's own topics (@livekit/agents constants): typed text in, transcripts out. */
export const CHAT_TOPIC = 'lk.chat';
export const TRANSCRIPTION_TOPIC = 'lk.transcription';
/** The participant attribute the app reads the worker's state from. */
export const STATE_ATTRIBUTE = 'lk.agent.state';
export type AgentState = 'listening' | 'thinking' | 'speaking';

/** How long the person has to join the room after the worker is dispatched to it. */
const JOIN_TIMEOUT_MS = 30_000;

/** One voice session: who it is for, the language, the API as their relay, and its usage. */
export type Session = {
  person: Person;
  lang: LangState;
  api: ReturnType<typeof apiFor>;
  turns: number;
  startedAt: number;
  /** Send a reply's tool parts to the app, which renders them like a typed turn's. */
  show(part: UiPart): Promise<void>;
  /** Called on every utterance: the silence timer starts again. */
  heard(): void;
  /** Called when the person pins a language: the live voice follows it. */
  onLangChange?: () => void;
  /** Aborted when the session ends: turns still running on the API stop with it. */
  ended: AbortSignal;
};

/**
 * Text from the person on a topic, handled safely: only from the person the room is for, and
 * a stream that breaks (they dropped mid-send) is logged, never an unhandled rejection that
 * would take the job down before it reports its minutes.
 */
export function onText(
  ctx: JobContext,
  topic: string,
  from: string,
  handle: (text: string) => void | Promise<void>,
) {
  ctx.room.registerTextStreamHandler(topic, (reader: TextStreamReader, who) => {
    if (who.identity !== from) return;
    reader
      .readAll()
      .then((text) => handle(text.trim()))
      .catch((e) => log().warn({ err: e, topic }, 'text from the person failed'));
  });
}

/**
 * Join the room, and decide whether to serve it: the dispatch must name the thread the room
 * is for, and the person in the room must be the one the room is for. Anything else is a
 * room the API did not create, so the worker leaves.
 */
export async function openSession(ctx: JobContext): Promise<Session | undefined> {
  const logger = log().child({ room: ctx.job.room?.name });
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(ctx.job.metadata || '{}');
  } catch {
    // Unparseable: the check below refuses it.
  }
  const dispatch = VoiceDispatch.safeParse(metadata);
  const named = parseVoiceRoom(ctx.job.room?.name ?? '');
  if (!dispatch.success || !named || named.threadId !== dispatch.data.threadId) {
    logger.warn('not a voice room the API dispatched; leaving');
    return undefined;
  }
  await ctx.connect();
  const joined = await Promise.race([
    ctx.waitForParticipant(named.userId),
    new Promise<undefined>((resolve) => setTimeout(resolve, JOIN_TIMEOUT_MS)),
  ]);
  if (!joined) {
    logger.warn('the person never joined; leaving');
    return undefined;
  }
  logger.info({ identity: joined.identity }, 'voice session started');

  const room = ctx.room;
  const roomName = room.name ?? ctx.job.room?.name ?? '';
  // Tell the app whether its microphone is heard here, or only typed lines are.
  await room.localParticipant?.setAttributes({
    [VOICE_HEARS_ATTRIBUTE]: config.mode === 'live' ? 'speech' : 'text',
  });
  const person: Person = {
    userId: named.userId,
    threadId: named.threadId,
    room: roomName,
    timeZone: dispatch.data.timeZone,
  };
  const ending = new AbortController();
  const session: Session = {
    person,
    lang: new LangState(dispatch.data.lang),
    api: apiFor(person),
    turns: 0,
    startedAt: Date.now(),
    show: async (part) => {
      await room.localParticipant?.sendText(JSON.stringify(part), {
        topic: UI_PARTS_TOPIC,
        destinationIdentities: [person.userId],
      });
    },
    heard: () => {},
    ended: ending.signal,
  };

  // The language chip: the person pins a language, or goes back to auto.
  onText(ctx, VOICE_LANG_TOPIC, person.userId, (text) => {
    const lang = VoiceLang.safeParse(text);
    if (!lang.success) return;
    session.lang.pin(lang.data);
    session.onLangChange?.();
  });

  // Limits: two minutes without speech, the session's length (its share of the person's
  // budget, at most VOICE_MAX_SECONDS), and the person leaving.
  let silence: NodeJS.Timeout | undefined;
  session.heard = () => {
    clearTimeout(silence);
    silence = setTimeout(() => ctx.shutdown('silence'), config.silenceMs);
  };
  session.heard();
  const maxMs = Math.min(config.maxMs, (dispatch.data.maxSeconds ?? Infinity) * 1000);
  const cap = setTimeout(() => ctx.shutdown('session limit'), maxMs);
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity === person.userId) ctx.shutdown('the person left');
  });

  // However it ends (the person leaves, a limit, an error), the API counts the minutes. The
  // API records an end once, so retrying a failed report is safe.
  ctx.addShutdownCallback(async () => {
    clearTimeout(silence);
    clearTimeout(cap);
    ending.abort();
    const seconds = Math.round((Date.now() - session.startedAt) / 1000);
    for (const wait of [0, 1000, 3000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        await session.api.voice.end({ room: roomName, seconds, turns: session.turns });
        logger.info({ seconds, turns: session.turns }, 'voice session ended');
        return;
      } catch (e) {
        logger.warn({ err: e }, 'could not report the session end; retrying');
      }
    }
    logger.error({ seconds }, 'the session end was not reported');
  });
  return session;
}

/** Tell the app what the worker is doing (it shows listening, thinking, speaking). */
export async function setState(ctx: JobContext, state: AgentState) {
  await ctx.room.localParticipant?.setAttributes({ [STATE_ATTRIBUTE]: state });
}
