// B9: a guest (a share link's holder) as access sees it: it reads by the `share` grant only,
// whatever the map says, writes nothing but a form's customer record, and a shared page's guest
// reads with its maker's roles.
import type { Principal } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { type Access, accessFor } from './access.js';

const ACCESS: Access = {
  read: { owner: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'tenant', staff: 'own', customer: 'customer' },
};

const guest = (extra: Partial<Principal> = {}): Principal => ({
  actor: { kind: 'guest', id: 'link-1' },
  tenantId: 't1',
  roles: [],
  capabilities: [],
  scopes: [],
  channel: 'share',
  share: { linkId: 'link-1', reach: 'link' },
  ...extra,
});

describe('a guest', () => {
  it('reads by the share grant only, even with a customer record', () => {
    const p = guest({ customerId: 'c1', roles: ['customer'] });
    expect(accessFor(p, ACCESS, 'read')).toEqual({
      kind: 'grants',
      grants: ['share'],
      rules: [{ grant: 'share' }],
    });
  });

  it('writes nothing through a record link', () => {
    expect(accessFor(guest({ customerId: 'c1' }), ACCESS, 'write')).toEqual({ kind: 'none' });
  });

  it("a form's answer creates its customer's record, and only with a customer", () => {
    const p = guest({ customerId: 'c1', share: { linkId: 'link-1', reach: 'form' } });
    expect(accessFor(p, ACCESS, 'write')).toEqual({
      kind: 'grants',
      grants: ['customer'],
      rules: [{ grant: 'customer' }],
    });
    const nobody = guest({ share: { linkId: 'link-1', reach: 'form' } });
    expect(accessFor(nobody, ACCESS, 'write')).toEqual({ kind: 'none' });
  });

  it("a shared page's guest reads with its maker's roles, and writes nothing", () => {
    const p = guest({
      roles: ['staff'],
      subject: { kind: 'user', userId: 'maker' },
      share: { linkId: 'link-1', reach: 'sharer' },
    });
    expect(accessFor(p, ACCESS, 'read')).toMatchObject({ kind: 'grants', grants: ['own'] });
    expect(accessFor(p, ACCESS, 'write')).toEqual({ kind: 'none' });
  });

  it('reaches nothing without a business', () => {
    expect(accessFor(guest({ tenantId: undefined }), ACCESS, 'read')).toEqual({ kind: 'none' });
  });
});
