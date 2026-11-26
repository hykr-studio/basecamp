import type { FilesConfig } from '../config.js';
import type { StorageDriver } from './driver.js';
import { localDriver } from './local.js';
import { s3Driver } from './s3.js';

export { STORAGE, type StorageDriver, StorageUnavailable } from './driver.js';
export { BLOB_PATH, type BlobGrant, type LocalDriver, signBlob, verifyBlob } from './local.js';

/** The driver STORAGE_DRIVER names. */
export function createStorage(c: FilesConfig): StorageDriver {
  if (c.driver === 's3') return s3Driver(c.s3);
  if (c.driver === 'fs') return localDriver({ kind: 'fs', dir: c.dir }, c.secret);
  return localDriver({ kind: 'memory' }, c.secret);
}
