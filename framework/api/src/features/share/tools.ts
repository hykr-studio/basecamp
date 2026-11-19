import {
  DraftShareInput,
  type Present,
  ShareRecipient,
  ShareSendChannel,
  ShareTarget,
  type WriteResult,
} from '@hykr/contracts';
import { safely, type ToolContribution } from '@hykr/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/** A drafted send waits: the person sees what is waiting, with Approve and Reject. */
const parked = (result: unknown): Present | undefined => {
  const r = result as WriteResult<unknown>;
  return r?.status === 'needs_approval'
    ? {
        kind: 'inline',
        view: 'approval.card',
        props: {
          approvalId: r.approval.id,
          summary: r.approval.summary,
          ...(r.approval.canDecide === false ? { canDecide: false } : {}),
        },
      }
    : undefined;
};

const WAITS =
  ' It waits for the user to approve it: then the run pauses, and goes on once it is decided. You never see the link or its address: say what will be sent, to whom, once approved.';

/**
 * The assistant's share tools (decisions B23). Like every tool they call the API as the agent,
 * acting for the person: a draft of a link and its send to a named recipient, or of a new link
 * sent in place of an old one. Each waits for the person's approval, and neither answer holds
 * the link's token or address.
 */
export const shareTools: ToolContribution = {
  name: 'share',
  tools: (kit) => ({
    'create-share-link': createTool({
      id: 'create-share-link',
      description: `Send someone a link to a record (their page, an order) or a form: the link is made and sent to them on WhatsApp or by email.${WAITS}`,
      inputSchema: z.object({
        target: ShareTarget.describe(
          'What the link opens: { entity, id } for a record, or { form }',
        ),
        to: ShareRecipient.describe(
          "Who it goes to: { customerId }, { contactId }, { email } or { recordCustomer: true } (the record's own customer)",
        ),
        channel: ShareSendChannel.optional().describe('whatsapp or email; leave out to try both'),
        expiresInDays: DraftShareInput.shape.expiresInDays.describe(
          'Days it stays open; null for no end date (only where that is allowed)',
        ),
      }),
      execute: async (input, ctx) =>
        safely('create-share-link', ctx, kit, () => kit.clientFor(ctx).shares.draft(input), parked),
    }),
    'send-share-link': createTool({
      id: 'send-share-link',
      description: `Send a link again to its recipient: the old link stops working and a new one is sent in its place (a link is never kept, so it cannot be sent twice).${WAITS}`,
      inputSchema: z.object({
        linkId: z.uuid().describe("The link, from the record's links"),
        channel: ShareSendChannel.optional().describe('whatsapp or email; leave out to try both'),
      }),
      execute: async ({ linkId, channel }, ctx) =>
        safely(
          'send-share-link',
          ctx,
          kit,
          () => kit.clientFor(ctx).shares.draftReissue(linkId, channel ? { channel } : {}),
          parked,
        ),
    }),
  }),
};
