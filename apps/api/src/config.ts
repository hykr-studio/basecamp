const env = process.env;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  authSecret: env.BETTER_AUTH_SECRET ?? '',
  authUrl: env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  webOrigins: list(env.WEB_ORIGINS),
  agentApiKey: env.AGENT_API_KEY ?? '',
  /** The voice worker's own key: a relay that starts turns for a person (channel voice). */
  voiceAgentKey: env.VOICE_AGENT_KEY ?? '',
  /** LiveKit (local dev mode in Compose; LiveKit Cloud or self-hosted elsewhere). */
  livekit: {
    url: env.LIVEKIT_URL ?? 'ws://localhost:7880',
    apiKey: env.LIVEKIT_API_KEY ?? 'devkey',
    apiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
  },
  /** Voice minutes per person per day (UTC), from the sessions' audit rows. */
  voiceDailyMinutes: Number(env.VOICE_DAILY_MINUTES ?? 30),
  /** The longest one session may run; the worker ends it there (VOICE_MAX_SECONDS too). */
  voiceMaxSeconds: Number(env.VOICE_MAX_SECONDS ?? 1200),
  /** WhatsApp Cloud API (whaloc in development): the assistant over text, no screen. */
  whatsapp: {
    apiBaseUrl: (env.WHATSAPP_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    token: env.WHATSAPP_TOKEN ?? '',
    appSecret: env.WHATSAPP_APP_SECRET ?? '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
  },
};

/** Refuse to start with a missing or guessable secret. */
export function assertConfig() {
  const weak = [
    ['BETTER_AUTH_SECRET', config.authSecret],
    ['AGENT_API_KEY', config.agentApiKey],
    // Optional (voice is off without it), but never weak, and never the assistant's own key.
    ...(config.voiceAgentKey ? [['VOICE_AGENT_KEY', config.voiceAgentKey]] : []),
  ].filter(([, value]) => value.length < 32);
  if (weak.length > 0) {
    const names = weak.map(([name]) => name).join(', ');
    throw new Error(`${names} must be at least 32 characters (openssl rand -hex 32)`);
  }
  if (config.voiceAgentKey && config.voiceAgentKey === config.agentApiKey) {
    throw new Error('VOICE_AGENT_KEY must differ from AGENT_API_KEY: audit tells them apart');
  }
  // LiveKit's dev-mode pair is fine on a laptop; in production it would let anyone mint tokens.
  const devLiveKit = config.livekit.apiKey === 'devkey' || config.livekit.apiSecret === 'secret';
  if (config.voiceAgentKey && process.env.NODE_ENV === 'production' && devLiveKit) {
    throw new Error('Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET for production voice');
  }
}
