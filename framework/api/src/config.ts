import { isTimeZone } from '@hykr/contracts';
import { knownCurrency } from '@hykr/i18n';

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
  /** WhatsApp voice notes: Sarvam speech-to-text (unset: only the tests' fake notes). */
  sarvamKey: env.SARVAM_API_KEY ?? '',
  sarvamSttModel: env.SARVAM_STT_MODEL ?? 'saarika:v2.5',
  /** WhatsApp Cloud API (whaloc in development): the assistant over text, no screen. */
  whatsapp: {
    /** The Graph API: whaloc in development and CI, https://graph.facebook.com elsewhere. */
    graphUrl: (env.WA_GRAPH_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    apiVersion: env.WA_API_VERSION ?? 'v25.0',
    /** The WhatsApp Business Account (templates live here) and the number we send from. */
    wabaId: env.WA_WABA_ID ?? '',
    phoneNumberId: env.WA_PHONE_NUMBER_ID ?? '',
    accessToken: env.WA_ACCESS_TOKEN ?? '',
    /** HMAC key for X-Hub-Signature-256 on webhooks (whaloc's WHALOC_APP_SECRET). */
    appSecret: env.WA_APP_SECRET ?? '',
    verifyToken: env.WA_VERIFY_TOKEN ?? '',
    /** The Meta app's id: templates with a DOCUMENT header are created with a sample file. */
    appId: env.WA_APP_ID || undefined,
    /** Sends per second per number, below Meta's default throughput. */
    sendRatePerSec: Number(env.WA_SEND_RATE_PER_SEC ?? 60),
  },
  /** Signs approval buttons (apr: tokens): only buttons we sent can decide anything. */
  approvalSecret: env.APPROVAL_SECRET ?? '',
  /** Email, for notifications WhatsApp can't deliver (Mailpit in development). */
  smtp: {
    host: env.SMTP_HOST ?? 'localhost',
    port: Number(env.SMTP_PORT ?? 1025),
    from: env.SMTP_FROM ?? 'Basecamp <assistant@basecamp.local>',
  },
  /** Queue keys in Redis: tests run under their own prefix, alongside the dev server. */
  queuePrefix: env.BULL_PREFIX ?? 'bull',
  /** Run the queue workers inside this process (tests); otherwise worker.ts runs them. */
  workerInline: env.WORKER_INLINE === '1',
  /** Where links in messages point: the app (sign-in, a page, an approval). */
  appUrl: (env.APP_URL ?? 'http://localhost:8081').replace(/\/$/, ''),
  /**
   * The currency of a business that set none in its settings (ISO 4217, upper case). Unset:
   * XXX, "no currency": the framework assumes none.
   */
  defaultCurrency: env.DEFAULT_CURRENCY?.trim() || undefined,
  /**
   * The time zone of a business that set none in its settings (UTC or an IANA Area/Location
   * name, e.g. Europe/Berlin; never an offset or an abbreviation): its periods, business hours,
   * quiet hours and dates. Unset: UTC. `assertConfig` checks its shape; at start, CoreModule
   * checks that Postgres reads it as Intl does (`checkTimeZones`).
   */
  defaultTimeZone: env.DEFAULT_TIME_ZONE?.trim() || undefined,
  /**
   * Who to contact about personal data for a business that named nobody (an email, phone number
   * or address): on its privacy register and in WhatsApp's HELP. Unset: none is named. Each
   * business is the one its people's data is held for, so a deployment of many businesses
   * leaves it unset.
   */
  defaultGrievanceContact: env.DEFAULT_GRIEVANCE_CONTACT?.trim() || undefined,
  /** The largest JSON body a request may send (a whole order with its lines). */
  jsonBodyLimit: env.JSON_BODY_LIMIT?.trim() || '1mb',
};

/** Refuse to start with a missing or guessable secret. */
export function assertConfig() {
  const weak = [
    ['BETTER_AUTH_SECRET', config.authSecret],
    ['AGENT_API_KEY', config.agentApiKey],
    // Optional (voice is off without it), but never weak, and never the assistant's own key.
    ...(config.voiceAgentKey ? [['VOICE_AGENT_KEY', config.voiceAgentKey]] : []),
    // Signs WhatsApp approval buttons: without it, approvals are decided in the app only.
    ...(config.approvalSecret ? [['APPROVAL_SECRET', config.approvalSecret]] : []),
  ].filter(([, value]) => value.length < 32);
  if (weak.length > 0) {
    const names = weak.map(([name]) => name).join(', ');
    throw new Error(`${names} must be at least 32 characters (openssl rand -hex 32)`);
  }
  if (config.voiceAgentKey && config.voiceAgentKey === config.agentApiKey) {
    throw new Error('VOICE_AGENT_KEY must differ from AGENT_API_KEY: audit tells them apart');
  }
  if (config.defaultCurrency !== undefined && !knownCurrency(config.defaultCurrency))
    throw new Error(
      `DEFAULT_CURRENCY must be an ISO 4217 currency such as EUR, not "${config.defaultCurrency}"`,
    );
  if (config.defaultTimeZone !== undefined && !isTimeZone(config.defaultTimeZone))
    throw new Error(
      `DEFAULT_TIME_ZONE must be UTC or an IANA zone name such as Europe/Berlin (not an offset or an abbreviation), not "${config.defaultTimeZone}"`,
    );
  if (
    config.defaultGrievanceContact !== undefined &&
    (config.defaultGrievanceContact.length < 3 || config.defaultGrievanceContact.length > 320)
  )
    throw new Error(
      'DEFAULT_GRIEVANCE_CONTACT must be an email, phone number or address (3 to 320 characters)',
    );
  if (!/^\d+(?:\.\d+)?(?:b|kb|mb)?$/i.test(config.jsonBodyLimit))
    throw new Error(`JSON_BODY_LIMIT must be a size such as 1mb, not "${config.jsonBodyLimit}"`);
  // LiveKit's dev-mode pair is fine on a laptop; in production it would let anyone mint tokens.
  const devLiveKit = config.livekit.apiKey === 'devkey' || config.livekit.apiSecret === 'secret';
  if (config.voiceAgentKey && process.env.NODE_ENV === 'production' && devLiveKit) {
    throw new Error('Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET for production voice');
  }
}
