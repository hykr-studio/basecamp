// Sending a notification from inside a write. Nothing here reads the configuration or loads
// Nest: safe to export from @hykr/api.
import { eventQueues } from '@hykr/core';
import { type DbOrTx, schema } from '@hykr/db';
import type { NotificationDef, Row } from '@hykr/notifications';

/** Dates as ISO strings: what a job and the notification functions see. */
export const plain = (row: unknown): Row => JSON.parse(JSON.stringify(row)) as Row;

/**
 * Write a notification about this record to the outbox, in the write's transaction: a rollback
 * sends nothing, a crash after commit still sends it, and a write that can be undone holds it
 * until its window closes (undoing the write withdraws it). `type` is the record's type, so each
 * recipient's words read it as they may (decisions H1). For a command's `run`, which has no
 * services:
 *
 *   run: async ({ tx, loaded }) => {
 *     await queueNotification(tx, OrderShipped, loaded, { type: 'order' });
 *     …
 *   }
 */
export async function queueNotification(
  tx: DbOrTx,
  // biome-ignore lint/suspicious/noExplicitAny: any notification's row
  def: NotificationDef<any>,
  row: unknown,
  opts: { type: string },
): Promise<void> {
  const r = plain(row);
  await tx.insert(schema.outbox).values({
    tenantId: r.tenantId,
    key: def.key,
    payload: { row: r, dedupe: def.dedupe(r), queues: eventQueues(), resourceType: opts.type },
  });
}
