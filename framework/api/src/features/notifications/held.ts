// Sends written to the outbox by a write that can be undone wait for its undo window, and
// undoing the write withdraws them (decisions H1), as its stored events are.
import type { WriteHook } from '@hykr/core';
import { schema } from '@hykr/db';
import { ConflictException } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

const { outbox } = schema;

/** The transaction running now, as `app.outbox.xact` records it (savepoints included). */
const thisTransaction = sql`(pg_current_xact_id()::text)::bigint`;

/** The framework's own operation that undoes a write (`UndoService`). */
const UNDO = 'write.undo';

/**
 * After the work, in the write's transaction. A write that opened an undo window: the outbox rows
 * its transaction wrote wait until the window closes, named by it. An undo: the window's held rows
 * are withdrawn, or the undo is refused (409 `too_late`) when one was passed on already.
 */
export const HeldSends: WriteHook = {
  name: 'notify.held-sends',
  async afterRun({ op, loaded, tx, result }) {
    if (op.name === UNDO && op.system) {
      const id = (loaded as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') return;
      // Waits for a relay moving them now; then they count as passed on.
      await tx
        .update(outbox)
        .set({ cancelledAt: sql`now()` })
        .where(and(eq(outbox.undoId, id), isNull(outbox.relayedAt), isNull(outbox.cancelledAt)));
      const [passed] = await tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(eq(outbox.undoId, id), isNotNull(outbox.relayedAt)))
        .limit(1);
      if (passed)
        throw new ConflictException({
          error: 'too_late',
          reason: 'It was already passed on, so it cannot be undone',
        });
      return;
    }
    if (result.status !== 'done' || !result.undo) return;
    await tx
      .update(outbox)
      .set({ availableAt: new Date(result.undo.until), undoId: result.undo.id })
      .where(
        and(eq(outbox.xact, thisTransaction), isNull(outbox.relayedAt), isNull(outbox.undoId)),
      );
  },
};
