import type { Access } from '@app/policy';

/**
 * Who reaches this domain's records: the person who owns them; ops and admins the whole
 * business; a customer the ones that are theirs (made by them, or for them). Staff work on
 * their own.
 */
export const BUSINESS_ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};
