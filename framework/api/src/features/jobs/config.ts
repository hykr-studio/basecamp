import { createHmac } from 'node:crypto';

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface JobsConfig {
  /** Derives each job's callback secret. */
  secret: string;
  /** The API's address as an outside service reaches it: callbacks are posted under it. */
  publicUrl: string;
  /** How far a callback's timestamp may be from now, in seconds. */
  toleranceS: number;
  /** Development only: result URLs may be http and point at private addresses. */
  allowPrivateUrls: boolean;
}

/**
 * The jobs feature's settings, from the environment, read when called (tests set it first):
 * - `JOBS_SECRET` derives each job's callback secret; from BETTER_AUTH_SECRET when unset.
 * - `JOBS_PUBLIC_URL`: where an outside service posts callbacks; default BETTER_AUTH_URL.
 * - `JOBS_CALLBACK_TOLERANCE_S` (300).
 * - `JOBS_ALLOW_PRIVATE_URLS=1`: result URLs may be http and private (development).
 */
export function jobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const secret =
    env.JOBS_SECRET ||
    createHmac('sha256', env.BETTER_AUTH_SECRET ?? '')
      .update('basecamp.jobs.secret')
      .digest('hex');
  return {
    secret,
    publicUrl: (env.JOBS_PUBLIC_URL || env.BETTER_AUTH_URL || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    ),
    toleranceS: num(env.JOBS_CALLBACK_TOLERANCE_S, 300),
    allowPrivateUrls: env.JOBS_ALLOW_PRIVATE_URLS === '1',
  };
}

/** Refuse a guessable secret, or private result URLs in production. */
export function assertJobsConfig(c: JobsConfig, env: NodeJS.ProcessEnv = process.env) {
  if (env.JOBS_SECRET && env.JOBS_SECRET.length < 32)
    throw new Error('JOBS_SECRET must be at least 32 characters (openssl rand -hex 32)');
  if (env.NODE_ENV === 'production' && c.allowPrivateUrls)
    throw new Error('JOBS_ALLOW_PRIVATE_URLS is for development: unset it in production');
}

/** One job's callback secret: handed to its service at submission, never stored or shown. */
export const callbackSecret = (secret: string, jobId: string) =>
  createHmac('sha256', secret).update(`basecamp.jobs.callback.${jobId}`).digest('hex');

/** Where a job's service posts its updates. */
export const callbackUrl = (publicUrl: string, jobId: string) =>
  `${publicUrl}/api/jobs/${encodeURIComponent(jobId)}/callback`;
