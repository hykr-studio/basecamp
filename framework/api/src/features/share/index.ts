import { ShareCapabilities } from '@hykr/contracts';
import { shareGrantKind, shareGuestsHook, shareLinksCleanup } from '@hykr/core';
import { whatsappProvider } from '../../channels/whatsapp/adapter.provider.js';
import { defineQueue } from '../../queues/define.js';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { ShareCodes } from './codes.js';
import { shareLinksErasure, shareLinksExport } from './privacy.js';
import { ShareSender } from './sender.js';
import { ShareService } from './share.service.js';
import { SharedController } from './shared.controller.js';
import { ShareDraftsController, SharesController } from './shares.controller.js';
import { ShareStart } from './start.js';
import { shareTools } from './tools.js';

/** The queue a link's send is delivered on (decisions B21). */
export const SHARE_SEND_QUEUE = 'share.send';

const lastTry = (job: { attemptsMade: number; opts: { attempts?: number } }) =>
  job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Delivers one send of a link, three tries, at most once (the job that claims it sends it). */
export const ShareSendQueue = defineQueue<{ sendId: string }, string>({
  name: SHARE_SEND_QUEUE,
  concurrency: 4,
  attempts: 3,
  backoffMs: 2000,
  process: (job, ctx) =>
    ctx.get(ShareSender).send(job.data.sendId, {
      by: job.id ?? `share-send-${job.data.sendId}`,
      lastTry: lastTry(job),
    }),
});

/** A link's send asked for (stored with its write): deliver it, in the worker. */
export const ShareSendRequested = defineSubscriber({
  name: 'share.send',
  on: ['share.send_requested'],
  handle: async (event, ctx) => {
    if (event.resourceId)
      await ctx.jobs.add(
        SHARE_SEND_QUEUE,
        { sendId: event.resourceId },
        { jobId: `share-send-${event.resourceId}` },
      );
  },
});

/** A gated link's code asked for (stored with its write): make it and send it, in the worker. */
export const ShareCodeRequested = defineSubscriber({
  name: 'share.otp',
  on: ['otp.requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(ShareCodes).deliver(event.resourceId);
  },
});

/**
 * Share links and public surfaces (docs/decisions/B9.md): a record, a saved page or a public
 * form shown to someone without an account, by an expiring, revocable link, optionally behind a
 * one-time code, or with no end where the application and the business allow it; sent to its
 * recipient by WhatsApp or email when asked (decisions B21). A guest reads by the `share` grant (what its link names, while it is live) and
 * writes only a form's answer, through the entity's own create. The application declares what is
 * shareable (`shareables`) and its forms (`publicForms`).
 */
export const shareFeature = defineFeature({
  name: 'share',
  controllers: [ShareDraftsController, SharesController, SharedController],
  providers: [ShareService, ShareCodes, ShareStart, ShareSender, whatsappProvider],
  exports: [ShareService],
  contributes: {
    grantKinds: [shareGrantKind],
    writeHooks: [shareGuestsHook, shareLinksCleanup],
    queues: [ShareSendQueue],
    subscribers: [ShareCodeRequested, ShareSendRequested],
    toolContributions: [shareTools],
    capabilities: [ShareCapabilities.create, ShareCapabilities.manage],
    erasureContributors: [shareLinksErasure],
    exportContributors: [shareLinksExport],
  },
});
