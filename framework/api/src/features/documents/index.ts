import { commandController, commandHandler } from '@hykr/core';
import { whatsappProvider } from '../../channels/whatsapp/adapter.provider.js';
import { defineQueue } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { RenderDocument, SendDocument } from './commands.js';
import { createEngine } from './config.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService, RENDER_QUEUE, SEND_QUEUE } from './documents.service.js';
import { DOCUMENT_ENGINE } from './engine/index.js';
import { documentsExport } from './privacy.js';
import { DocumentSender } from './sender.js';
import './routes.js';
import { documentsTools } from './tools.js';

/** The last of a job's tries: a failure then is final (the document or send fails). */
const lastTry = (job: { attemptsMade: number; opts: { attempts?: number } }) =>
  job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Draws one document (a few at once per worker), three tries. */
export const DocumentsRenderQueue = defineQueue<{ documentId: string }, string>({
  name: RENDER_QUEUE,
  concurrency: 2,
  attempts: 3,
  backoffMs: 2000,
  process: (job, ctx) => ctx.get(DocumentsService).render(job.data.documentId, lastTry(job)),
});

/** Delivers one send, three tries. */
export const DocumentsSendQueue = defineQueue<{ sendId: string }, string>({
  name: SEND_QUEUE,
  concurrency: 4,
  attempts: 3,
  backoffMs: 2000,
  process: (job, ctx) => ctx.get(DocumentSender).send(job.data.sendId, lastTry(job)),
});

/** A document asked for (stored with its write): draw it. */
export const DocumentsRequested = defineSubscriber({
  name: 'documents.render',
  on: ['document.requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(DocumentsService).queueRender(event.resourceId);
  },
});

/** A send asked for (stored with its write): deliver it, or wait for its document. */
export const DocumentsSendRequested = defineSubscriber({
  name: 'documents.send',
  on: ['document.send_requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(DocumentsService).queueSend(event.resourceId);
  },
});

/**
 * Documents (docs/decisions/B2.md): an application declares each kind of document of its
 * records (`defineDocument`, contributed as `documents`); asking for one snapshots its data as
 * the person and draws it in the worker (pdfkit, HarfBuzz, the Noto fonts) into a stored file;
 * sending one delivers it by WhatsApp (a template with a document header) or email.
 */
export const documentsFeature = defineFeature({
  name: 'documents',
  controllers: [
    commandController(RenderDocument),
    commandController(SendDocument),
    DocumentsController,
  ],
  providers: [
    { provide: DOCUMENT_ENGINE, useFactory: () => createEngine() },
    whatsappProvider,
    DocumentsService,
    DocumentSender,
    commandHandler(RenderDocument),
    commandHandler(SendDocument),
  ],
  exports: [DocumentsService, DOCUMENT_ENGINE],
  contributes: {
    queues: [DocumentsRenderQueue, DocumentsSendQueue],
    subscribers: [DocumentsRequested, DocumentsSendRequested],
    toolContributions: [documentsTools],
    exportContributors: [documentsExport],
  },
});
