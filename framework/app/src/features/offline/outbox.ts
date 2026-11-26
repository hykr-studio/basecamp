// The outbox (B12): writes kept on the device and sent in order, each with the idempotency key it
// was given when it was queued. Pure, so it is tested without React Native: the store, the sender
// and the clock are passed in. docs/decisions/B12.md.
import { ApiError, isNetworkError } from '@hykr/api-client';
import type { WriteResult } from '@hykr/contracts';
import type {
  PendingError,
  PendingWrite,
  QueuedWrite,
  WriteDraft,
  WriteQueue,
} from '../../framework/write-queue';

/** Where the outbox keeps its items: SQLite on a phone, IndexedDB in a browser, memory in tests. */
export interface OutboxStore {
  /** One person's items, oldest first. */
  load(userId: string): Promise<PendingWrite[]>;
  put(item: PendingWrite): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * What became of a write the outbox sent. `attached`: the screen that made it was still waiting
 * for its answer (it shows it itself).
 */
export type Settled =
  | {
      item: PendingWrite;
      outcome: 'done' | 'parked';
      result: WriteResult<unknown>;
      attached: boolean;
    }
  | { item: PendingWrite; outcome: 'failed'; error: PendingError; attached: false };

export interface OutboxDeps {
  store: OutboxStore;
  /** Send one item to the API with its key, business and If-Match: its answer, or a throw. */
  send(item: PendingWrite): Promise<WriteResult<unknown>>;
  /**
   * A create answered `id_taken`: the record, when this person can read it (an earlier try made
   * it and its reply was forgotten), else undefined.
   */
  read?(item: PendingWrite): Promise<unknown | undefined>;
  /** Is the device online, as far as it knows? Default: yes. */
  online?(): boolean;
  /** The business writes are captured in now (null: the person's default). */
  business?(): string | null;
  now?(): number;
  newId?(): string;
  /** A timer for the next try; returns its cancel. */
  later?(fn: () => void, ms: number): () => void;
}

/** Tries a write gets after a server error or 429 before it is left for the person. */
export const MAX_ATTEMPTS = 5;

/** The wait before the next try: 2 s, 4 s, 8 s … up to 5 minutes. */
export const backoffMs = (attempt: number) =>
  Math.min(2000 * 2 ** Math.max(0, attempt - 1), 300_000);

/** What a failed send means for the item. */
export type Disposition = 'offline' | 'signed-out' | 'later' | 'refused';

/** Why a send failed, as the outbox acts on it. */
export function dispositionOf(e: unknown): Disposition {
  if (isNetworkError(e)) return 'offline';
  if (!(e instanceof ApiError)) return 'refused';
  if (e.status === 401) return 'signed-out';
  if (e.status === 408 || e.status === 429 || e.status >= 500) return 'later';
  return 'refused';
}

/** The server's refusal as the item keeps it. */
export function errorOf(e: unknown): PendingError {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as {
      error?: unknown;
      rule?: unknown;
      reason?: unknown;
      message?: unknown;
      errors?: { message?: string }[];
    };
    const message =
      body.errors?.[0]?.message ??
      (typeof body.reason === 'string' ? body.reason : undefined) ??
      (typeof body.message === 'string' ? body.message : undefined) ??
      e.message;
    const code =
      typeof body.error === 'string'
        ? body.error === 'forbidden' && typeof body.rule === 'string'
          ? body.rule
          : body.error
        : undefined;
    return { status: e.status, ...(code ? { code } : {}), message };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

const isStale = (e: PendingError | undefined) => e?.status === 409 && e.code === 'stale';

/** What a refused write that a caller waits for rejects with. */
export class Refused extends Error {
  constructor(
    readonly item: PendingWrite,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Refused');
  }
}

type Waiter = {
  resolve: (r: WriteResult<unknown> | QueuedWrite) => void;
  reject: (e: unknown) => void;
};

export interface Outbox extends WriteQueue {
  /** Load this person's items and start sending them. */
  start(userId: string): Promise<void>;
  /** Stop sending (sign-out, another person); the items stay on the device. */
  stop(): void;
  /** Send what can be sent now, in order. Resolves when the run stops. */
  flush(): Promise<void>;
  /** A failed item again, as it was; `overwrite` (after a conflict): on the current version. */
  retry(id: string, opts?: { overwrite?: boolean }): Promise<void>;
  /** Forget an item. */
  discard(id: string): Promise<void>;
  /** The signed-in person's items, oldest first (a new array on every change). */
  items(): readonly PendingWrite[];
  /** Sending now. */
  syncing(): boolean;
  /** Waiting for the person to sign in again (a 401). */
  paused(): boolean;
  subscribe(listener: () => void): () => void;
  onSettled(listener: (s: Settled) => void): () => void;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const online = deps.online ?? (() => true);
  const later =
    deps.later ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  let userId: string | null = null;
  let list: readonly PendingWrite[] = [];
  /** The signed-in person's items are loaded: writes wait for it. */
  let ready: Promise<void> = Promise.resolve();
  let running: Promise<void> | undefined;
  let again = false;
  let isPaused = false;
  /** Network failures in a row: the wait before the next try grows with them. */
  let unreachable = 0;
  /** The last item's time, so items queued in one millisecond keep their order. */
  let lastAt = 0;
  let cancelTimer: (() => void) | undefined;
  const waiters = new Map<string, Waiter>();
  const listeners = new Set<() => void>();
  const settledListeners = new Set<(s: Settled) => void>();

  const changed = () => {
    for (const l of listeners) l();
  };
  const settle = (s: Settled) => {
    for (const l of settledListeners) l(s);
  };
  const replace = (item: PendingWrite) => {
    list = list.map((i) => (i.id === item.id ? item : i));
    changed();
  };
  const save = async (item: PendingWrite) => {
    replace(item);
    await deps.store.put(item);
  };
  const drop = async (id: string) => {
    list = list.filter((i) => i.id !== id);
    changed();
    await deps.store.remove(id);
  };
  /** Every caller still waiting hears that its write is kept for later. */
  const releaseWaiters = () => {
    for (const [id, w] of waiters) {
      const item = list.find((i) => i.id === id);
      if (item) w.resolve({ status: 'queued', item });
    }
    waiters.clear();
  };
  const wakeAt = (at: number) => {
    cancelTimer?.();
    cancelTimer = later(
      () => {
        cancelTimer = undefined;
        void flush();
      },
      Math.max(0, at - now()),
    );
  };

  /**
   * The version a new change to this record is based on: after a write to it still waiting, the
   * version that write will make (a create makes 1, an update one more than it expects); else
   * the version the person saw.
   */
  function baseVersion(draft: WriteDraft): number | undefined {
    if (!draft.versioned || draft.op.kind !== 'entity' || !draft.op.recordId) return undefined;
    const { entity, recordId } = draft.op;
    const before = [...list]
      .reverse()
      .find(
        (i) =>
          i.state !== 'failed' &&
          i.op.kind === 'entity' &&
          i.op.entity === entity &&
          i.op.recordId === recordId,
      );
    if (before?.op.kind !== 'entity') return draft.baseVersion;
    if (before.op.action === 'create') return 1;
    if (before.op.action === 'update' && before.ifMatch !== undefined) return before.ifMatch + 1;
    return undefined;
  }

  /** The server took it: done, or parked for approval. */
  const answered = (item: PendingWrite, result: WriteResult<unknown>) => {
    const waiter = waiters.get(item.id);
    waiters.delete(item.id);
    const outcome = result.status === 'needs_approval' ? 'parked' : 'done';
    settle({ item, outcome, result, attached: waiter !== undefined });
    waiter?.resolve(result);
  };

  /** One item to the server; true when the run goes on to the next. */
  async function sendOne(item: PendingWrite): Promise<boolean> {
    const sending: PendingWrite = { ...item, state: 'sending' };
    await save(sending);
    let result: WriteResult<unknown>;
    try {
      result = await deps.send(sending);
    } catch (e) {
      return failed(sending, e);
    }
    unreachable = 0;
    await drop(item.id);
    answered(sending, result);
    return true;
  }

  async function failed(item: PendingWrite, e: unknown): Promise<boolean> {
    const how = dispositionOf(e);
    const error = errorOf(e);
    if (how === 'offline') {
      unreachable++;
      await save({ ...item, state: 'queued', error });
      wakeAt(now() + backoffMs(unreachable));
      return false;
    }
    if (how === 'signed-out') {
      isPaused = true;
      await save({ ...item, state: 'queued', error });
      return false;
    }
    if (how === 'later') {
      const attempts = item.attempts + 1;
      if (attempts < MAX_ATTEMPTS) {
        const nextAt = now() + backoffMs(attempts);
        await save({ ...item, state: 'queued', attempts, error, nextAt });
        wakeAt(nextAt);
        return false;
      }
      const kept: PendingWrite = { ...item, state: 'failed', attempts, error };
      await save(kept);
      settle({ item: kept, outcome: 'failed', error, attached: false });
      return true;
    }
    // Refused. A create whose id is taken may be our own earlier try, its reply forgotten.
    if (
      error.code === 'id_taken' &&
      item.op.kind === 'entity' &&
      item.op.action === 'create' &&
      deps.read
    ) {
      const record = await deps.read(item).catch(() => undefined);
      if (record !== undefined) {
        await drop(item.id);
        answered(item, { status: 'done', value: record });
        return true;
      }
    }
    // A caller waiting for it hears the refusal, as a direct call would: nothing is kept.
    const waiter = waiters.get(item.id);
    if (waiter) {
      waiters.delete(item.id);
      await drop(item.id);
      waiter.reject(e);
      return true;
    }
    const kept: PendingWrite = { ...item, state: 'failed', error };
    await save(kept);
    settle({ item: kept, outcome: 'failed', error, attached: false });
    return true;
  }

  async function run(): Promise<void> {
    await ready;
    for (;;) {
      if (!userId || isPaused) break;
      if (!online()) break;
      const t = now();
      const next = list.find((i) => i.state === 'queued');
      if (!next) break;
      // First in, first out: a write waiting for its back-off holds the ones after it.
      if (next.nextAt !== undefined && next.nextAt > t) {
        wakeAt(next.nextAt);
        break;
      }
      const goOn = await sendOne(next);
      if (!goOn) break;
    }
    releaseWaiters();
  }

  function flush(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = undefined;
        changed();
      }
    })();
    changed();
    return running;
  }

  return {
    async start(id) {
      cancelTimer?.();
      userId = id;
      isPaused = false;
      unreachable = 0;
      list = [];
      ready = (async () => {
        const loaded = await deps.store.load(id);
        if (userId !== id) return;
        // A write the app was closed in the middle of is sent again, with its key.
        list = loaded.map((i) => (i.state === 'sending' ? { ...i, state: 'queued' as const } : i));
        changed();
      })();
      await ready;
      await flush();
    },
    stop() {
      cancelTimer?.();
      cancelTimer = undefined;
      userId = null;
      list = [];
      releaseWaiters();
      changed();
    },
    flush,
    async submit(draft) {
      await ready;
      if (!userId) throw new Error('Nobody is signed in to queue a write for');
      const ifMatch = baseVersion(draft);
      lastAt = Math.max(now(), lastAt + 1);
      const item: PendingWrite = {
        id: newId(),
        key: newId(),
        userId,
        tenantId: deps.business?.() ?? null,
        op: draft.op,
        input: draft.input,
        ...(ifMatch !== undefined ? { ifMatch } : {}),
        ...(draft.title ? { title: draft.title } : {}),
        createdAt: new Date(lastAt).toISOString(),
        attempts: 0,
        state: 'queued',
      };
      await deps.store.put(item);
      list = [...list, item];
      changed();
      const answer = new Promise<WriteResult<unknown> | QueuedWrite>((resolve, reject) =>
        waiters.set(item.id, { resolve, reject }),
      );
      void flush();
      return answer;
    },
    async retry(id, opts = {}) {
      const item = list.find((i) => i.id === id);
      if (item?.state !== 'failed') return;
      const { error: _error, nextAt: _nextAt, ifMatch, ...rest } = item;
      // Applied over the change it conflicted with: a new request, on the current version.
      const overwrite = opts.overwrite === true && isStale(item.error);
      const fresh: PendingWrite = overwrite
        ? { ...rest, key: newId(), attempts: 0, state: 'queued' }
        : {
            ...rest,
            ...(ifMatch !== undefined ? { ifMatch } : {}),
            attempts: 0,
            state: 'queued',
          };
      await save(fresh);
      isPaused = false;
      await flush();
    },
    async discard(id) {
      const item = list.find((i) => i.id === id);
      const waiter = waiters.get(id);
      waiters.delete(id);
      await drop(id);
      if (waiter && item) waiter.resolve({ status: 'queued', item });
    },
    items: () => list,
    syncing: () => running !== undefined,
    paused: () => isPaused,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSettled(listener) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
}

/** An outbox store in memory: tests, and a browser that keeps nothing (private windows). */
export function memoryStore(): OutboxStore & { all(): PendingWrite[] } {
  const items = new Map<string, PendingWrite>();
  return {
    async load(userId) {
      return [...items.values()]
        .filter((i) => i.userId === userId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async put(item) {
      items.set(item.id, structuredClone(item));
    },
    async remove(id) {
      items.delete(id);
    },
    all: () => [...items.values()],
  };
}
