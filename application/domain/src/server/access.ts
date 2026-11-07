import type { Access } from '@hykr/policy';

/**
 * Who reaches this domain's records: the person who owns them; ops and admins the whole
 * business; a customer the ones that are theirs (made by them, or for them). Staff work on
 * their own.
 */
export const BUSINESS_ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

/**
 * The same, and the records a person (or WhatsApp contact) outside the team participates in, in
 * these participant roles (the module's own): read only. Someone outside the team holds the
 * `customer` role, a participant included.
 */
export function readByParticipants(roles: readonly string[]): Access {
  return {
    read: {
      ...BUSINESS_ACCESS.read,
      customer: ['customer', { grant: 'participant', as: roles }],
    },
    write: BUSINESS_ACCESS.write,
  };
}
