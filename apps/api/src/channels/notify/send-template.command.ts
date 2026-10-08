import { SendTemplateSpec } from '@app/contracts';
import { allow, defineCommand, deny, needsApproval } from '@app/core';
import { schema } from '@app/db';
import { templates } from '@app/notifications';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

/** The outbox key for a template sent by hand, not by a notification. */
export const TEMPLATE_KEY = 'template:';

const STAFF = ['owner', 'admin', 'ops', 'staff'] as const;

/**
 * notify.send: a template to one customer, written to the outbox with the audit row, so it is
 * sent once the transaction commits. Dispatch then applies consent, quiet hours and the cap.
 */
export const SendTemplate = defineCommand(SendTemplateSpec, {
  resource: { type: 'customer', id: (input) => input.customerId },
  load: async (tx, p, input) => {
    const [customer] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(
        and(
          eq(schema.customers.id, input.customerId),
          eq(schema.customers.tenantId, p.tenantId ?? ''),
        ),
      );
    if (!customer) throw new NotFoundException('No such customer');
    return { customer, template: templates.find((t) => t.name === input.template) };
  },
  authorize: (p, { template }, input) => {
    if (!p.roles?.some((r) => (STAFF as readonly string[]).includes(r)))
      return deny('staff_only', 'Only the business can message its customers');
    if (!template) return deny('unknown_template', `There is no template ${input.template}`);
    if (template.category === 'authentication')
      return deny('not_sendable', 'Login codes are sent by the app, not by hand');
    const missing = Object.keys(template.params.shape).filter((k) => !input.params[k]?.trim());
    if (missing.length) return deny('missing_params', `Fill in ${missing.join(', ')}`);
    if (template.category === 'marketing')
      return needsApproval('marketing_send', 'A marketing message needs the owner to approve it');
    return allow('staff_sends_service');
  },
  summarize: (input) => `Send ${input.template} to a customer`,
  approval: { by: ['owner', 'admin'] },
  run: async ({ tx, principal, input }) => {
    await tx.insert(schema.outbox).values({
      tenantId: principal.tenantId ?? '',
      key: `${TEMPLATE_KEY}${input.template}`,
      payload: {
        row: { id: input.customerId, tenantId: principal.tenantId, params: input.params },
        dedupe: `send:${crypto.randomUUID()}`,
      },
    });
    return { value: { queued: true }, touched: [] };
  },
});
