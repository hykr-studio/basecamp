// Comments and personal data: what a person wrote goes when they are forgotten, and mentions of
// them in other people's comments stop naming them.
import { type Mention, rewriteMentions } from '@hykr/contracts';
import { comments } from '@hykr/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { DataSubject, ErasureContributor, ExportContributor } from '../../hooks.js';
import { both, createdBy } from '../../privacy/contributors.js';

const inBusiness = (a: DataSubject) => (a.tenantId ? eq(comments.tenantId, a.tenantId) : undefined);

/** What a token naming an erased person becomes. */
export const ERASED_MENTION = '@—';

/**
 * What a comment's copies hold of its words and its author (audit rows, `comment.*` events,
 * replies, notifications): `excerpt` and `author { id, name }` are `comment.mentioned`'s.
 */
const WORDS = ['body', 'mentions', 'anchor', 'excerpt', 'author', 'target'];

/**
 * Forgetting a person: their comments are deleted, and in other comments each token naming them
 * becomes `@—` and they leave the mentions. Contacts write no comments. Their comments' copies
 * lose the words and the author; the copies of a comment that named them lose its words and its
 * mentions (a token and a mention carry the name they were written with: `label`), and the
 * comment keeps its rewritten text.
 */
export const CommentsErasure: ErasureContributor = {
  name: 'comments',
  erase: async (a) => {
    if (a.subject.kind !== 'user') return { count: 0 };
    const userId = a.subject.userId;
    const own = await a.tx
      .delete(comments)
      .where(and(eq(comments.authorId, userId), inBusiness(a)) as SQL)
      .returning({ id: comments.id });
    const naming = await a.tx
      .select()
      .from(comments)
      .where(
        and(
          inBusiness(a),
          sql`${comments.mentions} @> ${JSON.stringify([{ kind: 'user', id: userId }])}::jsonb`,
        ) as SQL,
      );
    for (const row of naming) {
      const body = rewriteMentions(row.body, (t) =>
        t.kind === 'user' && t.id === userId ? ERASED_MENTION : undefined,
      );
      const mentions = (row.mentions as Mention[]).filter(
        (m) => !(m.kind === 'user' && m.id === userId),
      );
      await a.tx.update(comments).set({ body, mentions }).where(eq(comments.id, row.id));
    }
    return {
      count: own.length + naming.length,
      erased: [
        {
          type: 'comment',
          // With those they removed before: their copies stay otherwise.
          ids: both(
            own.map((c) => c.id),
            await createdBy(a.tx, { type: 'comment', userId, tenantId: a.tenantId }),
          ),
          fields: WORDS,
          deleted: true,
        },
        {
          type: 'comment',
          ids: naming.map((c) => c.id),
          fields: ['body', 'excerpt', 'mentions', 'target'],
        },
      ],
    };
  },
};

/** A person's export: what they wrote, on which record, when. */
export const CommentsExport: ExportContributor = {
  name: 'comments',
  export: async (a): Promise<Record<string, readonly unknown[]>> => {
    if (a.subject.kind !== 'user') return {};
    const rows = await a.db
      .select()
      .from(comments)
      .where(and(eq(comments.authorId, a.subject.userId), inBusiness(a)) as SQL);
    return {
      comments: rows.map((r) => ({
        on: { entity: r.resourceType, id: r.resourceId },
        body: r.body,
        internal: r.internal,
        createdAt: r.createdAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
      })),
    };
  },
};
