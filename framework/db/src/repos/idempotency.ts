import { and, eq } from 'drizzle-orm';
import type { Database } from '../database.js';
import { idempotencyKeys } from '../schema/app.js';

export type IdempotencySave = {
  key: string;
  principalId: string;
  requestHash: string;
  response: unknown;
};

export function idempotencyRepo(db: Database) {
  return {
    async find(key: string, principalId: string) {
      const [row] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.principalId, principalId)));
      return row;
    },

    async save(input: IdempotencySave) {
      const [row] = await db
        .insert(idempotencyKeys)
        .values({
          key: input.key,
          principalId: input.principalId,
          requestHash: input.requestHash,
          response: input.response,
        })
        .onConflictDoNothing({ target: [idempotencyKeys.key, idempotencyKeys.principalId] })
        .returning();
      return row;
    },
  };
}
