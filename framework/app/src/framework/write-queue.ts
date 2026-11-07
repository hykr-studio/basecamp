// Where the app's writes meet the offline outbox (B12). The hooks (`useEntityMutation`,
// `useCommand`, a view's `act`) hand a write on an offline-capable spec to the queue the offline
// plugin installs; without the plugin they call the API directly. Types only and a slot: the
// queue itself is `features/offline`. docs/decisions/B12.md.
import type { WriteAction, WriteResult } from '@hykr/contracts';

/** What a queued write does: one entity write (by the entity's plural) or one command. */
export type PendingOp =
  | {
      kind: 'entity';
      /** The entity's plural: 'todos'. */
      entity: string;
      action: WriteAction;
      /** The record it writes: an update's or delete's, or the id a create chose. */
      recordId?: string;
    }
  | { kind: 'command'; command: string };

/** Where a queued write stands: waiting, on its way, or refused (kept for the person). */
export type PendingState = 'queued' | 'sending' | 'failed';

/** What the server said when it refused a queued write, or why it is waiting. */
export type PendingError = {
  /** The HTTP status; none when the network failed. */
  status?: number;
  /** The server's code: 'stale', 'id_taken', 'forbidden', … */
  code?: string;
  message: string;
};

/** One write in the outbox, as it is kept on the device. */
export type PendingWrite = {
  /** The item's own id on the device. */
  id: string;
  /** Its idempotency key, fixed when it was queued: every try sends the same. */
  key: string;
  /** Who queued it: only they send it. */
  userId: string;
  /** The business it was captured in (sent as `x-tenant-id`); null: the person's default. */
  tenantId: string | null;
  op: PendingOp;
  /** The body: a create's or command's input, an update's patch, nothing for a delete. */
  input: Record<string, unknown>;
  /** The record version the change was based on (`If-Match`), for a versioned entity. */
  ifMatch?: number;
  /** What to call it in a list: the record's title, when it has one. */
  title?: string;
  /** When it was queued (ISO). */
  createdAt: string;
  /** Tries that reached the server and failed for a reason that may pass (5xx, 429). */
  attempts: number;
  state: PendingState;
  /** The last refusal or failure. */
  error?: PendingError;
  /** Not before (ms since the epoch): a back-off after a server error. */
  nextAt?: number;
};

/** A write kept on the device to send later: the network was not there. */
export type QueuedWrite = { status: 'queued'; item: PendingWrite };

/** What the hooks hand to the queue. */
export type WriteDraft = {
  op: PendingOp;
  input: Record<string, unknown>;
  title?: string;
  /** The entity has versions: the queue works out the version the change is based on. */
  versioned?: boolean;
  /** The version of the record as the person saw it (from the app's cache), if known. */
  baseVersion?: number;
};

export interface WriteQueue {
  /**
   * Keep the write on the device, then send it when it can. The server's answer when it was
   * sent; `queued` when it could not be (offline, the server unreachable, signed out); a refusal
   * (400, 403, 404, 409) rejects, as a direct call would, and the write is not kept.
   */
  submit(draft: WriteDraft): Promise<WriteResult<unknown> | QueuedWrite>;
}

let queue: WriteQueue | undefined;

/** Install (or remove) the queue: the offline plugin does, while someone is signed in. */
export function setWriteQueue(q: WriteQueue | undefined) {
  queue = q;
}

/** The installed queue, if any. */
export const writeQueue = (): WriteQueue | undefined => queue;

/** Did this write wait on the device instead of reaching the server? */
export const isQueued = (r: unknown): r is QueuedWrite =>
  typeof r === 'object' && r !== null && (r as { status?: unknown }).status === 'queued';
