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
};

/** Refuse to start with a missing or guessable secret. */
export function assertConfig() {
  const weak = [
    ['BETTER_AUTH_SECRET', config.authSecret],
    ['AGENT_API_KEY', config.agentApiKey],
  ].filter(([, value]) => value.length < 32);
  if (weak.length > 0) {
    const names = weak.map(([name]) => name).join(', ');
    throw new Error(`${names} must be at least 32 characters (openssl rand -hex 32)`);
  }
}
