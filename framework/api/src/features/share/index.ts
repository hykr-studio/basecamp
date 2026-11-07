import { ShareCapabilities } from '@hykr/contracts';
import { shareGrantKind, shareGuestsHook, shareLinksCleanup } from '@hykr/core';
import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { ShareCodes } from './codes.js';
import { ShareService } from './share.service.js';
import { SharedController } from './shared.controller.js';
import { SharesController } from './shares.controller.js';
import { ShareStart } from './start.js';

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
 * one-time code. A guest reads by the `share` grant (what its link names, while it is live) and
 * writes only a form's answer, through the entity's own create. The application declares what is
 * shareable (`shareables`) and its forms (`publicForms`).
 */
export const shareFeature = defineFeature({
  name: 'share',
  controllers: [SharesController, SharedController],
  providers: [ShareService, ShareCodes, ShareStart],
  exports: [ShareService],
  contributes: {
    grantKinds: [shareGrantKind],
    writeHooks: [shareGuestsHook, shareLinksCleanup],
    subscribers: [ShareCodeRequested],
    capabilities: [ShareCapabilities.create, ShareCapabilities.manage],
  },
});
