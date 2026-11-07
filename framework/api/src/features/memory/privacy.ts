import { subjectKey } from '@hykr/contracts';
import { memories, memoryIndex } from '@hykr/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { ErasureContributor, ExportContributor } from '../../hooks.js';

/**
 * A person asks to be forgotten: the vectors of what they said go (a deleted message's vector
 * goes with it anyway), and for a person with an account, the business memories they wrote and
 * those memories' vectors.
 */
export const EraseMemory: ErasureContributor = {
  name: 'memory',
  async erase({ subject, tenantId, tx }) {
    const inTenant = (col: typeof memoryIndex.tenantId | typeof memories.tenantId) =>
      tenantId ? eq(col, tenantId) : undefined;
    const said = await tx
      .delete(memoryIndex)
      .where(and(eq(memoryIndex.subject, subjectKey(subject)), inTenant(memoryIndex.tenantId)))
      .returning({ id: memoryIndex.id });
    if (subject.kind !== 'user') return { count: said.length };
    const written = await tx
      .delete(memories)
      .where(and(eq(memories.ownerId, subject.userId), inTenant(memories.tenantId)))
      .returning({ id: memories.id });
    if (written.length)
      await tx.delete(memoryIndex).where(
        and(
          eq(memoryIndex.sourceType, 'memory'),
          inArray(
            memoryIndex.sourceId,
            written.map((m) => m.id),
          ),
        ),
      );
    return { count: said.length + written.length };
  },
};

/**
 * The business memories a person wrote (no kind when there are none). Vectors are derived from
 * them and not exported.
 */
export const ExportMemory: ExportContributor = {
  name: 'memory',
  async export({ subject, tenantId, db }): Promise<Record<string, readonly unknown[]>> {
    if (subject.kind !== 'user') return {};
    const rows = await db
      .select({
        id: memories.id,
        tenantId: memories.tenantId,
        text: memories.text,
        createdBy: memories.createdBy,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, subject.userId),
          tenantId ? eq(memories.tenantId, tenantId) : undefined,
        ),
      );
    return rows.length ? { memories: rows } : {};
  },
};
