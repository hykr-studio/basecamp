/** The worker's settings, read from the environment when used (the repo's .env in development). */
const env = process.env;

/** A positive number of seconds from the environment, or the default (never NaN or 0). */
const seconds = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  /** Where the API is: the worker starts every turn there, as the person's relay. */
  get apiUrl() {
    return (env.API_INTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  },
  /** The worker's own key (never the assistant's): the API knows it as agent "voice". */
  get agentKey() {
    return env.VOICE_AGENT_KEY ?? '';
  },
  /** fake: no audio models; text in over lk.chat, text out. live: Sarvam STT and TTS. */
  get mode(): 'fake' | 'live' {
    return env.VOICE_MODE === 'live' ? 'live' : 'fake';
  },
  get sarvamKey() {
    return env.SARVAM_API_KEY ?? '';
  },
  /** A session ends after this long without speech, and at this length regardless. */
  get silenceMs() {
    return seconds(env.VOICE_SILENCE_SECONDS, 120) * 1000;
  },
  get maxMs() {
    return seconds(env.VOICE_MAX_SECONDS, 1200) * 1000;
  },
};

export function assertConfig() {
  if (config.agentKey.length < 32) throw new Error('VOICE_AGENT_KEY must be set (32+ characters)');
  if (config.mode === 'live' && !config.sarvamKey)
    throw new Error('VOICE_MODE=live needs SARVAM_API_KEY (or set VOICE_MODE=fake)');
}
