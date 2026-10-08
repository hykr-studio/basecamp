import { z } from 'zod';
import { commandSpec } from '../framework/spec.js';

export const SendTemplateInput = z.object({
  customerId: z.string().describe('The customer to message (an id from their record)'),
  template: z.string().describe('The template name, with its version: monthly_update_v1'),
  params: z.record(z.string(), z.string()).default({}).describe("The template's named parameters"),
});
export type SendTemplateInput = z.input<typeof SendTemplateInput>;

export const SendTemplateResult = z.object({ queued: z.boolean() });

/**
 * Send a customer an approved WhatsApp template. Staff may send service templates; a
 * marketing one waits for the owner's approval; a customer cannot send at all. Consent, quiet
 * hours and the weekly marketing cap still apply when it goes out.
 */
export const SendTemplateSpec = commandSpec({
  name: 'notify.send',
  description:
    'Send a customer an approved WhatsApp template by name, with its parameters. Use it only when the user asks to message a customer. Consent and quiet hours are checked when it goes out, so it may arrive later or by email.',
  input: SendTemplateInput,
  output: SendTemplateResult,
  http: { method: 'POST', path: '/api/notify/send' },
  tool: 'send-template',
  expose: 'all',
  approvalNote: 'A marketing template waits for the owner to approve it.',
  verb: { do: 'send', did: 'sent' },
  touches: [],
});
