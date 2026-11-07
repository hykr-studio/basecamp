// What applications and other features use of files on the server: the service (store bytes the
// server has, read them, sign a download URL), the storage token and driver type, and the
// helpers the tests share.
import './routes.js';

export { type FilesConfig, filesConfig } from './config.js';
export {
  dispositionOf,
  type FileRow,
  FilesService,
  infoOf,
  type Uploader,
  uploadedBy,
} from './files.service.js';
export { type FileHolder, fileHolders } from './holders.js';
export { fileLine, sizeText } from './lines.js';
export { bytesFit, type Sniffed, sniff } from './sniff.js';
export { SPEECH, type Speech } from './speech.js';
export { STORAGE, type StorageDriver, StorageUnavailable } from './storage/index.js';
export { type FileTarget, fileTargets } from './targets.js';
