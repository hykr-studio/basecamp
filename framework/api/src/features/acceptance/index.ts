import { defineSubscriber } from '../events/subscriber.js';
import { defineFeature } from '../feature.js';
import { AcceptanceService } from './acceptance.service.js';
import { AcceptancesController } from './acceptances.controller.js';
import { AcceptanceEvidenceCapability } from './capability.js';
import { AcceptanceCodes } from './codes.js';
import './routes.js';
import { AcceptanceStart } from './start.js';

/** An acceptance's code asked for (stored with its write): make it and send it, in the worker. */
export const AcceptanceCodeRequested = defineSubscriber({
  name: 'acceptance.otp',
  on: ['otp.requested'],
  handle: async (event, ctx) => {
    if (event.resourceId) await ctx.get(AcceptanceCodes).deliver(event.resourceId);
  },
});

/**
 * Acceptance by one-time code (docs/decisions/B8.md): an application declares what can be
 * accepted (`defineAcceptance`, contributed as `acceptances`): one document's PDF of a record, by
 * whom, and the record's transition when accepted. A code goes to the signer's own WhatsApp
 * number or email; the code typed back accepts that PDF (its hash) of that version of the
 * record, through the write path, and leaves an append-only, hash-chained evidence row. An
 * `ESignProvider` (none ships) can sign instead.
 */
export const acceptanceFeature = defineFeature({
  name: 'acceptance',
  controllers: [AcceptancesController],
  providers: [AcceptanceService, AcceptanceCodes, AcceptanceStart],
  exports: [AcceptanceService],
  contributes: {
    subscribers: [AcceptanceCodeRequested],
    capabilities: [AcceptanceEvidenceCapability],
  },
});
