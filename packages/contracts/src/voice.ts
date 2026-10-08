import { LANGS } from '@app/i18n';
import { z } from 'zod';

/** The languages the assistant speaks and shows (@app/i18n holds the list and the words). */
export const Lang = z.enum(LANGS);
export type Lang = z.infer<typeof Lang>;

/** How a turn reached the assistant. Set by who called (never by the request body). */
export const Channel = z.enum(['app', 'voice', 'whatsapp']);
export type Channel = z.infer<typeof Channel>;

/** A voice session's language: detected per turn ('auto'), or pinned. */
export const VoiceLang = z.enum(['auto', 'en-IN', 'hi-IN', 'te-IN']);
export type VoiceLang = z.infer<typeof VoiceLang>;

/** 'te-IN' → 'te'; 'auto' → undefined (the session decides). */
export const langOfVoice = (v: VoiceLang): Lang | undefined =>
  v === 'auto' ? undefined : (v.slice(0, 2) as Lang);

export const VoiceSessionRequest = z.object({
  /** Continue this thread by voice; omitted, the person's current thread. */
  threadId: z.uuid().optional(),
  lang: VoiceLang.default('auto'),
  /** IANA zone, so spoken dates and times are the person's own. */
  timeZone: z.string().max(64).optional(),
});
export type VoiceSessionRequest = z.infer<typeof VoiceSessionRequest>;

export const VoiceSessionResponse = z.object({
  /** The LiveKit server the app connects to. */
  url: z.string(),
  /** A participant token for this room only, valid for 10 minutes to join. */
  token: z.string(),
  room: z.string(),
  threadId: z.uuid(),
});
export type VoiceSessionResponse = z.infer<typeof VoiceSessionResponse>;

/** Sent by the voice worker when a session ends: usage, for audit and the daily budget. */
export const VoiceSessionEnd = z.object({
  room: z.string().max(200),
  seconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600),
  turns: z.number().int().min(0).max(10_000),
});
export type VoiceSessionEnd = z.infer<typeof VoiceSessionEnd>;

/** Which voice session a relay request belongs to: the API checks it is open, for that person. */
export const VOICE_ROOM_HEADER = 'x-voice-room';

/** The voice worker's identity at the API (x-agent-id), with its own key (VOICE_AGENT_KEY). */
export const VOICE_AGENT_ID = 'voice';

/** The room's data topic for UI parts the worker forwards from a reply. */
export const UI_PARTS_TOPIC = 'ui-parts';

/**
 * What the worker can take in, as a participant attribute: 'speech' (it transcribes the
 * microphone) or 'text' (fake mode: only typed lines, so the app transcribes on the device).
 */
export const VOICE_HEARS_ATTRIBUTE = 'voice.hears';

/** The topic the app pins the session's language on (a VoiceLang), from its language chip. */
export const VOICE_LANG_TOPIC = 'voice-lang';

/** What the API tells the worker about a room when it dispatches it (the dispatch metadata). */
export const VoiceDispatch = z.object({
  threadId: z.uuid(),
  lang: VoiceLang.default('auto'),
  timeZone: z.string().max(64).optional(),
  /** How long this session may run: the person's minutes left today, at most one session's. */
  maxSeconds: z.number().int().min(1).optional(),
});
export type VoiceDispatch = z.infer<typeof VoiceDispatch>;

/**
 * A voice room's name: the person, the thread (which the worker checks against the dispatch)
 * and the session. One room per session: LiveKit dispatches the worker when a room is created,
 * so a session that reused a room still open from the last one would get no worker.
 */
export const voiceRoom = (userId: string, threadId: string, session: string) =>
  `voice:${userId}:${threadId}:${session}`;
export function parseVoiceRoom(
  room: string,
): { userId: string; threadId: string; session: string } | undefined {
  const [kind, userId, threadId, session] = room.split(':');
  return kind === 'voice' && userId && threadId && session
    ? { userId, threadId, session }
    : undefined;
}
