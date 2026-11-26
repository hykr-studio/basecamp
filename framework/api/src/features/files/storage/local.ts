import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { StorageDriver } from './driver.js';

/** Where the API serves the local drivers' signed URLs (blob.controller.ts). */
export const BLOB_PATH = '/api/files/blob';

/** What a local driver's URL lets its holder do: one method on one key, until it expires. */
export interface BlobGrant {
  /** The object's key. */
  k: string;
  m: 'GET' | 'PUT';
  /** The content type: the PUT must send it; the GET is served with it. */
  t: string;
  /** PUT: exactly this many bytes. */
  s?: number;
  /** GET: the Content-Disposition it is served with. */
  d?: string;
  /** Expiry, in seconds since the epoch. */
  e: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const mac = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`basecamp.blob.${body}`).digest();

/** A signed token for one grant. */
export function signBlob(secret: string, grant: BlobGrant): string {
  const body = b64(JSON.stringify(grant));
  return `${body}.${b64(mac(secret, body))}`;
}

/** The grant a token carries, or null when it is forged, garbled or expired. */
export function verifyBlob(secret: string, token: string, now = Date.now()): BlobGrant | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(secret, body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let grant: BlobGrant;
  try {
    grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as BlobGrant;
  } catch {
    return null;
  }
  if (typeof grant.e !== 'number' || grant.e * 1000 < now) return null;
  if (grant.m !== 'GET' && grant.m !== 'PUT') return null;
  return grant;
}

interface Bytes {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, bytes: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
  ready(): Promise<void>;
}

/** In this process's memory: tests and CI. Another process (the worker) has its own. */
function memoryBytes(): Bytes {
  const objects = new Map<string, Buffer>();
  return {
    get: async (key) => objects.get(key),
    set: async (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
    },
    delete: async (key) => {
      objects.delete(key);
    },
    ready: async () => {},
  };
}

/** In a folder (STORAGE_DIR), one file per key. */
function folderBytes(dir: string): Bytes {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const path = resolve(join(root, key));
    // Keys are the server's own (t/<tenant>/<id>); refuse anything that leaves the folder.
    if (!path.startsWith(root + sep)) throw new Error(`Bad storage key "${key}"`);
    return path;
  };
  return {
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
    },
    async set(key, bytes) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },
    delete: (key) => rm(pathOf(key), { force: true }),
    async ready() {
      await mkdir(root, { recursive: true });
      await stat(root);
    },
  };
}

/**
 * A local store, in memory or in a folder, whose URLs the API serves itself
 * (`/api/files/blob/<token>`, relative to the API): each token is an HMAC-signed grant for one
 * method on one key, with the type and size a PUT must send, until it expires.
 */
export function localDriver(
  o: { kind: 'memory' } | { kind: 'fs'; dir: string },
  secret: string,
): StorageDriver & { accept(grant: BlobGrant, bytes: Buffer): Promise<void> } {
  const bytes = o.kind === 'memory' ? memoryBytes() : folderBytes(o.dir);
  const expiry = (expiresIn: number) => Math.floor(Date.now() / 1000) + expiresIn;
  const url = (grant: BlobGrant) => `${BLOB_PATH}/${signBlob(secret, grant)}`;
  return {
    kind: o.kind,
    ensureReady: () => bytes.ready(),
    async presignPut(key, p) {
      return {
        url: url({ k: key, m: 'PUT', t: p.mime, s: p.size, e: expiry(p.expiresIn) }),
        headers: { 'content-type': p.mime },
      };
    },
    async presignGet(key, p) {
      return url({ k: key, m: 'GET', t: p.mime, d: p.disposition, e: expiry(p.expiresIn) });
    },
    async head(key) {
      const b = await bytes.get(key);
      return b ? { size: b.length } : null;
    },
    async readStart(key, n) {
      const b = await bytes.get(key);
      if (!b) throw new Error(`No object at ${key}`);
      return b.subarray(0, n);
    },
    async read(key) {
      const b = await bytes.get(key);
      if (!b) throw new Error(`No object at ${key}`);
      return b;
    },
    put: (key, b) => bytes.set(key, b),
    delete: (key) => bytes.delete(key),
    /** A PUT through a verified grant (the blob route checked its type and size). */
    accept: (grant, b) => bytes.set(grant.k, b),
  };
}

export type LocalDriver = ReturnType<typeof localDriver>;
