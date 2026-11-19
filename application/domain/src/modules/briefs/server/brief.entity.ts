import { defineEntity } from '@hykr/core';
import { BUSINESS_ACCESS } from '../../../server/access.js';
import { BriefSpec } from '../contracts/index.js';
import { briefs } from '../db/schema.js';

/**
 * Briefs, with the domain's usual access: whoever owns one (a brief answered on the form is owned
 * by the business's default owner), ops and admins the whole business, a customer their own.
 */
export const Brief = defineEntity(BriefSpec, {
  table: briefs,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: BUSINESS_ACCESS,
  summarize: (action, input, row) =>
    `${action === 'create' ? 'Add' : action === 'update' ? 'Change' : 'Delete'} the brief of ${String(input?.name ?? row?.name ?? '')}`,
});
