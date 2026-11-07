// Share links (docs/decisions/B9.md), in the write and read path: the `share` grant a guest reads
// by (what its link names, while the link is live), the write hook that refuses a guest's write
// that would wait for an approval, and the one that revokes a deleted record's links. The share
// feature (@hykr/api) contributes these.
import { shareableOfChild, shareables } from '@hykr/contracts';
import { shareLinks } from '@hykr/db';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { deny, RuleDenied } from '../authorize.js';
import { childLinkOf } from '../entity/children.js';
import type { GrantKind, GrantTarget, WriteHook } from '../hooks.js';

/** The link's own conditions: this link, in the row's business, not revoked, not ended. */
const live = (linkId: string, tenant: unknown): SQL =>
  sql`${shareLinks.id} = ${linkId} and ${shareLinks.tenantId} = ${tenant} and ${shareLinks.revokedAt} is null and ${shareLinks.expiresAt} > now()`;

/**
 * `share`: given by `accessFor` to a guest (never written in an access map). A row of a declared
 * shareable whose id the guest's record link names, or a row of a child it declares whose parent
 * the link names. Any other entity, or any other principal: no rows.
 */
export const shareGrantKind: GrantKind = {
  name: 'share',
  where(p, _rule, target: GrantTarget) {
    if (p.actor.kind !== 'guest' || (p.share?.reach ?? 'link') !== 'link') return undefined;
    const tenant = target.columns.tenantId;
    const name = target.spec.name;
    if (shareables.has(name)) {
      const id = target.columns.id;
      return sql`exists (select 1 from ${shareLinks} where ${live(p.actor.id, tenant)} and ${shareLinks.kind} = 'record' and ${shareLinks.resourceType} = ${name} and ${shareLinks.resourceId} = ${id})`;
    }
    const parent = shareableOfChild(name);
    const link = childLinkOf(name);
    if (!parent || !link || link.parent.name !== parent.entity) return undefined;
    return sql`exists (select 1 from ${shareLinks} where ${live(p.actor.id, tenant)} and ${shareLinks.kind} = 'record' and ${shareLinks.resourceType} = ${parent.entity} and ${shareLinks.resourceId} = ${link.fk})`;
  },
};

const cannotWait = () =>
  deny(
    'guest_cannot_wait',
    'This would need someone to approve it, and nobody can be asked for a share link',
  );

/**
 * A guest's write never parks: nobody can be asked on its behalf, and an approved replay would
 * have nobody to act as. A write that would wait is refused (audited as denied); `afterRun`
 * catches a park that came later (an approval level), and rolls it back.
 */
export const shareGuestsHook: WriteHook = {
  name: 'share-guests',
  decide({ ctx, decision }) {
    if (ctx.principal.actor.kind !== 'guest') return null;
    return decision.decision === 'needs_approval' ? cannotWait() : null;
  },
  afterRun({ ctx, result }) {
    if (ctx.principal.actor.kind === 'guest' && result.status === 'needs_approval')
      throw new RuleDenied(cannotWait());
  },
};

/**
 * A deleted record's links are revoked with it, in the same transaction, whichever write deleted
 * it (a CRUD delete, or a command's `touched`). The rows stay, for the audit.
 */
export const shareLinksCleanup: WriteHook = {
  name: 'share-links',
  async afterRun({ tx, touched, result, ctx }) {
    if (result.status !== 'done' || !ctx.principal.tenantId) return;
    const gone = touched.filter((t) => t.change === 'deleted');
    for (const type of new Set(gone.map((t) => t.type))) {
      const ids = gone.filter((t) => t.type === type).map((t) => t.id);
      await tx
        .update(shareLinks)
        .set({ revokedAt: new Date(), revokedBy: 'record.deleted' })
        .where(
          and(
            eq(shareLinks.tenantId, ctx.principal.tenantId),
            eq(shareLinks.resourceType, type),
            inArray(shareLinks.resourceId, ids),
            isNull(shareLinks.revokedAt),
          ),
        );
    }
  },
};
