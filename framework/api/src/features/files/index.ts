import { whatsappProvider } from '../../channels/whatsapp/adapter.provider.js';
import { SttService } from '../../channels/whatsapp/stt.service.js';
import { defineQueue, defineSchedule } from '../../queues/define.js';
import { defineFeature } from '../feature.js';
import { filesWriteHook } from './attach.hook.js';
import { BlobController } from './blob.controller.js';
import { filesConfig } from './config.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { FilesInboundHook } from './inbound.hook.js';
import { filesErasure, filesExport } from './privacy.js';
import { SPEECH } from './speech.js';
import './routes.js';
import { createStorage, STORAGE } from './storage/index.js';
import { filesTools } from './tools.js';

/** Deletes abandoned uploads, files let go of after the grace period, and erased files. */
export const FilesSweepQueue = defineQueue<Record<string, never>, { deleted: number }>({
  name: 'files.sweep',
  process: (_job, ctx) => ctx.get(FilesService).sweep(),
});

/** Every ten minutes. */
export const FilesSweepSchedule = defineSchedule({
  name: 'files.sweep',
  queue: FilesSweepQueue.name,
  every: 10 * 60 * 1000,
});

/**
 * Files and media (docs/decisions/B1.md): uploads to object storage (S3-compatible, or a local
 * folder or memory) through presigned URLs, files kept on records' file fields (the `files`
 * trait) and reached only through them, files the server stores (WhatsApp media), voice
 * transcription, erasure and export, and the sweeper.
 */
export const filesFeature = defineFeature({
  name: 'files',
  controllers: [FilesController, BlobController],
  providers: [
    { provide: STORAGE, useFactory: () => createStorage(filesConfig()) },
    whatsappProvider,
    SttService,
    { provide: SPEECH, useExisting: SttService },
    FilesService,
    FilesInboundHook,
  ],
  exports: [FilesService, STORAGE],
  contributes: {
    writeHooks: [filesWriteHook],
    erasureContributors: [filesErasure],
    exportContributors: [filesExport],
    queues: [FilesSweepQueue],
    schedules: [FilesSweepSchedule],
    toolContributions: [filesTools],
  },
});
