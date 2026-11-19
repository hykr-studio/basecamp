// Is this code running inside a write's transaction? runWrite marks its transaction here, so work
// that must never hold one open (a model call: slow, on the network) can refuse at once instead
// of stalling every other write waiting on the rows it locked.
import { AsyncLocalStorage } from 'node:async_hooks';

const open = new AsyncLocalStorage<{ op: string }>();

/** Run `work` marked as inside the transaction of the write `op`. */
export const inWriteTransaction = <T>(op: string, work: () => Promise<T>): Promise<T> =>
  open.run({ op }, work);

/** The write whose transaction this code runs in, if any. */
export const openWrite = (): string | undefined => open.getStore()?.op;

/** Called inside a write's transaction where that is never allowed: a bug in the caller. */
export class InWriteTransaction extends Error {
  constructor(
    readonly what: string,
    readonly op: string,
  ) {
    super(
      `${what} must not run inside a write's transaction (it is inside ${op}): call it before the write, in a job's submit or in a subscriber`,
    );
    this.name = 'InWriteTransaction';
  }
}

/** Throw at once when called inside a write's transaction. */
export function assertNoWriteTransaction(what: string) {
  const op = openWrite();
  if (op) throw new InWriteTransaction(what, op);
}
