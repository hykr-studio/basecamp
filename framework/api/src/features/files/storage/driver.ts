/**
 * Where file bytes live. The files feature never hands out an object's key, only signed URLs
 * a driver makes for one key, one method and a short time. Two drivers: S3-compatible stores
 * (MinIO in development) and a local one (memory for tests, a folder on disk), whose URLs the
 * API serves itself (blob.controller.ts).
 */
export interface StorageDriver {
  /** 's3', 'fs' or 'memory'. */
  readonly kind: 's3' | 'fs' | 'memory';
  /** Create the bucket (or folder) when it is missing. Called at startup and after a failure. */
  ensureReady(): Promise<void>;
  /**
   * A URL to PUT exactly `size` bytes of type `mime` to this key, until `expiresIn` seconds
   * from now. Any other type or length is refused by the store.
   */
  presignPut(
    key: string,
    o: { mime: string; size: number; expiresIn: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** A URL to GET the object, served with this type and disposition, for `expiresIn` seconds. */
  presignGet(
    key: string,
    o: { mime: string; disposition: string; expiresIn: number },
  ): Promise<string>;
  /** The stored object's size, or null when there is none. */
  head(key: string): Promise<{ size: number } | null>;
  /** The first `bytes` bytes of the object (fewer when it is smaller). */
  readStart(key: string, bytes: number): Promise<Buffer>;
  /** The whole object. */
  read(key: string): Promise<Buffer>;
  /** Store bytes under a key (server-side files: WhatsApp media, documents). */
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  /** Remove the object. Removing one that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/** The storage driver (STORAGE_DRIVER): inject it with `@Inject(STORAGE)`. */
export const STORAGE = Symbol('STORAGE');

/** The store did not answer (down, or the bucket is missing): the request may be retried. */
export class StorageUnavailable extends Error {}
