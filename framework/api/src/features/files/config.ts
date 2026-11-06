import { createHmac } from 'node:crypto';

const MIB = 1024 * 1024;

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export type StorageKind = 's3' | 'fs' | 'memory';

export interface FilesConfig {
  driver: StorageKind;
  /** STORAGE_DRIVER was not set: memory, for one process only. */
  defaulted: boolean;
  /** The fs driver's folder. */
  dir: string;
  /** Signs the local drivers' URLs. */
  secret: string;
  s3: {
    /** What the server calls. */
    endpoint: string | undefined;
    /** What presigned URLs name: a phone on the LAN cannot reach localhost. */
    publicEndpoint: string | undefined;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  /** The largest file any field accepts. */
  maxBytes: number;
  /** How long a download URL works. */
  urlTtlS: number;
  /** How long an upload URL works, and a pending upload waits for its bytes. */
  uploadTtlS: number;
  /** How long a file taken off its record is kept before it is deleted (an undo). */
  detachedGraceH: number;
  /** Unconfirmed uploads one person may have in a day. */
  maxPending: number;
}

/**
 * The files feature's settings, from the environment, read when called (tests and the CLI set
 * the environment first):
 * - `STORAGE_DRIVER`: `s3` (MinIO in development, any S3-compatible store elsewhere), `fs` (a
 *   folder, `STORAGE_DIR`) or `memory` (one process: tests and CI). Unset means memory, which
 *   production refuses.
 * - `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
 *   `S3_SECRET_ACCESS_KEY`.
 * - `STORAGE_SECRET` signs the local drivers' URLs; derived from BETTER_AUTH_SECRET when unset.
 * - `FILES_MAX_BYTES` (25 MiB), `FILES_URL_TTL_S` (300), `FILES_UPLOAD_TTL_S` (900),
 *   `FILES_DETACHED_GRACE_H` (168), `FILES_MAX_PENDING` (50).
 */
export function filesConfig(env: NodeJS.ProcessEnv = process.env): FilesConfig {
  const raw = (env.STORAGE_DRIVER ?? '').trim().toLowerCase();
  if (raw && raw !== 's3' && raw !== 'fs' && raw !== 'memory')
    throw new Error(`STORAGE_DRIVER must be s3, fs or memory (got "${raw}")`);
  const secret =
    env.STORAGE_SECRET ||
    createHmac('sha256', env.BETTER_AUTH_SECRET ?? '')
      .update('basecamp.files.storage')
      .digest('hex');
  const endpoint = env.S3_ENDPOINT || undefined;
  return {
    driver: (raw || 'memory') as StorageKind,
    defaulted: !raw,
    dir: env.STORAGE_DIR ?? '',
    secret,
    s3: {
      endpoint,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || endpoint,
      region: env.S3_REGION || 'us-east-1',
      bucket: env.S3_BUCKET || 'basecamp',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    },
    maxBytes: num(env.FILES_MAX_BYTES, 25 * MIB),
    urlTtlS: num(env.FILES_URL_TTL_S, 300),
    uploadTtlS: num(env.FILES_UPLOAD_TTL_S, 900),
    detachedGraceH: num(env.FILES_DETACHED_GRACE_H, 168),
    maxPending: num(env.FILES_MAX_PENDING, 50),
  };
}

/** Refuse a configuration that would lose files or sign with a guessable key. */
export function assertFilesConfig(c: FilesConfig, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' && c.driver === 'memory')
    throw new Error('Set STORAGE_DRIVER to s3 or fs for production: memory loses every file');
  if (c.driver === 'fs' && !c.dir) throw new Error('STORAGE_DRIVER=fs needs STORAGE_DIR');
  if (c.driver === 's3' && (!c.s3.accessKeyId || !c.s3.secretAccessKey))
    throw new Error('STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  if (c.driver !== 's3' && env.STORAGE_SECRET && env.STORAGE_SECRET.length < 32)
    throw new Error('STORAGE_SECRET must be at least 32 characters (openssl rand -hex 32)');
}
