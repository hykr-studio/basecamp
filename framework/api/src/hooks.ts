// The server's extension points: types and registries. Features and application modules fill
// them through `contributes` (defineServer, defineFeature), installed once when the process
// starts. Each is read where it applies: queues and schedules by QueuesModule, subscribers and
// event feeds by the event relay, turn hooks by ChatService, delivery channels by the dispatcher,
// inbound hooks by the WhatsApp inbound processor, erasure and export contributors by the
// personal-data runners.
import type { InboundMessage } from '@hykr/channels';
import type { Channel, DomainEventEnvelope, Principal, Subject, Surface } from '@hykr/contracts';
import { createHookRegistry } from '@hykr/contracts';
import type { Conn, Tx } from '@hykr/core';
import type { Database } from '@hykr/db';
import type { Labels, Lang } from '@hykr/i18n';
import type { NotificationDef, Reader, Recipient, Row } from '@hykr/notifications';
import type { Type } from '@nestjs/common';
import type { BetterAuthPlugin } from 'better-auth';
import type { Job, JobsOptions, Queue } from 'bullmq';

// The core's registries, so every contribution key has its collector once this module loads.
export {
  type AgentIdentity,
  type AgentIdentityProvider,
  type EntityPlugin,
  entityPlugins,
  identityProviders,
  projectRead,
  type ReadProjector,
  readProjectors,
  type WriteHook,
  writeHooks,
} from '@hykr/core';
export { type ToolContribution, toolContributions } from '@hykr/core/tools';

declare module '@hykr/contracts' {
  interface Contributions {
    deliveryChannels: readonly DeliveryChannel[];
    turnHooks: readonly TurnHook[];
    inboundHooks: readonly InboundHook[];
    queues: readonly QueueDef[];
    schedules: readonly ScheduleDef[];
    subscribers: readonly Subscriber[];
    eventFeeds: readonly EventFeed[];
    erasureContributors: readonly ErasureContributor[];
    exportContributors: readonly ExportContributor[];
    authPlugins: readonly AuthPlugin[];
  }
}

const byName = (x: { name: string }) => x.name;

/* ── Delivery channels ─────────────────────────────────────────────────────── */

/**
 * What a notification needs to move on to its next channel later: kept with what a channel sent
 * (the WhatsApp message, a push ticket), and handed to `NotifyService.fallback` when that fails.
 */
export interface NotificationMeta {
  key: string;
  dedupe: string;
  row: Row;
  recipient: Recipient;
  /** The channels still to try, in order. */
  next: string[];
}

/** One notification to one recipient, as notify() resolved it. */
export interface DeliveryRequest {
  tenantId: string;
  // biome-ignore lint/suspicious/noExplicitAny: any notification's row
  notification: NotificationDef<any>;
  /** Whom to reach: a person, a contact, or both when the number is linked. */
  to: { userId?: string; contactId?: string };
  reader: Reader;
  row: Row;
  /** One per notification and record: a channel can refuse a second send with it. */
  dedupe: string;
  /** Keep it with the send: a failure found out later moves on with `NotifyService.fallback`. */
  meta: NotificationMeta;
}

export type DeliveryOutcome =
  | { status: 'sent'; ref?: string }
  /** It cannot reach them here (no token, no address): the next channel is tried now. */
  | { status: 'unavailable'; reason: string }
  /** It tried and failed. `final`: no retry on this channel, the next one is tried. */
  | { status: 'failed'; reason: string; final: boolean };

/**
 * A way to reach a person (push, in-app), named in a notification's `channels`. WhatsApp and email
 * are built in, so those two names are taken. Add the name to `NotificationChannels`
 * (@hykr/notifications) by declaration merging so notifications can list it. Every channel a
 * notification lists must be registered when the process starts, or it stops.
 */
export interface DeliveryChannel {
  /** Unique: 'push'. */
  name: string;
  deliver(req: DeliveryRequest): Promise<DeliveryOutcome>;
}

/** Delivery channels, by name. The dispatcher tries them in a notification's fallback order. */
export const deliveryChannels = createHookRegistry<DeliveryChannel>('delivery channel', byName, {
  collects: 'deliveryChannels',
});

/* ── Turn hooks ────────────────────────────────────────────────────────────── */

/** One assistant turn, whatever the channel. A back-office draft is a turn too, with no thread. */
export interface TurnInfo {
  /** 'draft': a reply for staff to edit (no tools, nothing saved). */
  kind: 'chat' | 'draft';
  principal: Principal;
  runId: string;
  /** The thread it continues; none for a draft. */
  threadId?: string;
  message: string;
  channel: Channel;
  surfaces: readonly Surface[];
  lang?: Lang;
}

/** Why a turn does not run. */
export interface TurnRefusal {
  /** A stable code: 'credits_exhausted'. */
  rule: string;
  /** A plain sentence, for the caller and the logs. */
  reason: string;
  /** The HTTP status the caller gets. Default 403. */
  status?: number;
  /** What the person is told on WhatsApp, in their language. Default: "something went wrong". */
  say?: Labels;
}

/**
 * A hook's say on a turn before the model runs: refuse it (a credit cap reached), or shape it.
 * `context`: lines the model reads as data for this turn (recalled memory). `model`: the model id
 * to use (the first hook that names one wins). `withoutTools`: tool ids this turn may not use (a
 * feature switched off); a hook can take tools away, never add one.
 */
export type TurnGate =
  | { refuse: TurnRefusal }
  | { context?: readonly string[]; model?: string; withoutTools?: readonly string[] };

/** What a finished turn did and used. */
export interface TurnOutcome {
  text: string;
  /** The tools it called, by id, in order. */
  toolCalls: readonly string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** The reply failed or was cut off. */
  interrupted: boolean;
}

/**
 * Something every assistant turn passes through: caps and metering, memory recall, model policy.
 * ChatService runs the framework's own hook (the model key check) first, then these in order.
 */
export interface TurnHook {
  /** Unique: 'credits'. */
  name: string;
  /** Before the model runs. null: no opinion. Throwing fails the turn. */
  before?(turn: TurnInfo): Promise<TurnGate | null>;
  /** After the reply is saved. A failure is logged, never shown to the person. */
  after?(turn: TurnInfo, outcome: TurnOutcome): Promise<void>;
}

/** Turn hooks, in the order they run. */
export const turnHooks = createHookRegistry<TurnHook>('turn hook', byName, {
  collects: 'turnHooks',
});

/* ── Inbound hooks ─────────────────────────────────────────────────────────── */

/** One stored inbound message, with the business and the sender it belongs to. */
export interface InboundInfo {
  tenantId: string;
  contactId: string;
  /** The linked person, when the number is linked to an account. */
  userId?: string;
  message: InboundMessage;
}

/** Take the message (the hook answered it, no turn runs), or add words the turn reads with it. */
export type InboundDecision = { handled: true } | { context: readonly string[] };

/**
 * Something every inbound message passes through before its turn (store a photo's media). It
 * sees each message the code did not answer itself (approval buttons, keywords), also while staff
 * have the conversation. `handled`: the message is left out of the turn. A hook that throws is
 * logged and skipped, so do slow or flaky work on your own queue.
 */
export interface InboundHook {
  /** Unique: 'files'. */
  name: string;
  /** null: no opinion. */
  onMessage(msg: InboundInfo): Promise<InboundDecision | null>;
}

/** Inbound hooks, in the order they run. */
export const inboundHooks = createHookRegistry<InboundHook>('inbound hook', byName, {
  collects: 'inboundHooks',
});

/* ── Queues and schedules ──────────────────────────────────────────────────── */

/** Adds jobs to any registered queue (QueuesModule's `JobsService`). */
export interface Jobs {
  add<D>(
    queue: QueueDef<D> | string,
    data: D,
    opts?: JobsOptions & { name?: string },
  ): Promise<Job<D>>;
  queue<D = unknown>(name: string): Queue<D>;
}

/** What a job or an event handler may use: any loaded provider, the database, the queues. */
export interface ServerContext {
  /** A provider from any loaded module (Nest's `ModuleRef.get`, not strict). */
  get<T>(token: Type<T> | string | symbol): T;
  db: Database;
  jobs: Jobs;
}

/**
 * A queue a feature or module runs jobs on, in the worker. Contribute it (`queues`), or register
 * it at import with `registerQueue` (framework code). QueuesModule registers every queue in the
 * registry under the process's queue prefix (BULL_PREFIX), so tests and worktrees sharing Redis
 * never take each other's jobs.
 */
// biome-ignore lint/suspicious/noExplicitAny: a queue's job data is its own
export interface QueueDef<D = any, R = unknown> {
  /** Prefixed by its owner, so names never collide: 'credits.alerts'. No ':'. */
  name: string;
  /** Jobs at once per worker. Default 1. */
  concurrency?: number;
  /** Tries before a job fails for good. Default 1. */
  attempts?: number;
  /** The first retry's delay in milliseconds; it doubles each time. */
  backoffMs?: number;
  /**
   * Runs one job, in the worker (and in the API with WORKER_INLINE=1). Without it, a Nest
   * `@Processor(name)` class its owner provides runs the queue.
   */
  process?(job: Job<D>, ctx: ServerContext): Promise<R>;
}

/** Queues, by name: the framework's own and every contributed one. */
export const queues = createHookRegistry<QueueDef>('queue', byName, { collects: 'queues' });

/**
 * A job added on a schedule (`defineSchedule` checks it). Give exactly one of `every` and `cron`.
 * The worker keeps one BullMQ job scheduler per schedule, keyed by its name; the job's name is the
 * schedule's name too.
 */
export interface ScheduleDef {
  /** Unique, prefixed by its owner: 'credits.alert-80'. */
  name: string;
  /** The queue its job goes to. */
  queue: string;
  /** Every this many milliseconds. */
  every?: number;
  /** A cron pattern, in UTC. */
  cron?: string;
  data?: unknown;
}

/** Schedules, by name. */
export const schedules = createHookRegistry<ScheduleDef>('schedule', byName, {
  collects: 'schedules',
});

/* ── Events: subscribers and feeds ─────────────────────────────────────────── */

/**
 * Something that reacts to committed events, in the worker (`defineSubscriber` checks it). The
 * relay adds one job per event and subscriber, with the id `<subscriber>--<event id>`, so an
 * event relayed twice runs once. The envelope carries the stored row unfiltered: anything that
 * sends it outside (webhooks, live updates) must pass it through `projectRead` first.
 */
export interface Subscriber {
  /** Unique, prefixed by its owner: 'resume.approvals'. */
  name: string;
  /** Event names ('approval.decided'), or prefixes ('task.*'), or '*' for every event. */
  on: readonly string[];
  /** Only events this holds for. Runs in the relay: keep it cheap and pure. */
  when?(event: DomainEventEnvelope): boolean;
  /** Runs the event on the shared `events` queue. Give this or `queue`. */
  handle?(event: DomainEventEnvelope, ctx: ServerContext): Promise<void>;
  /** Adds the envelope to this registered queue instead; its processor runs it. */
  queue?: string;
  /** Tries before the job fails for good. Default 3. */
  attempts?: number;
  /** The first retry's delay; it doubles each time. Default 2000. */
  backoffMs?: number;
}

/** Subscribers, in registration order. */
export const subscribers = createHookRegistry<Subscriber>('subscriber', byName, {
  collects: 'subscribers',
});

/**
 * Where committed events come from: a durable store written in the write's transaction (the
 * event outbox). The worker polls every feed each second. While no feed is registered, the
 * in-process event bus is relayed instead, after commit.
 */
export interface EventFeed {
  /** Unique: 'outbox'. */
  name: string;
  /**
   * Up to `limit` events, oldest first, that are committed, due (`availableAt` passed, an undone
   * write's never) and not yet relayed for this queue prefix. Processes with another prefix share
   * the database: never return their events.
   */
  pending(a: { limit: number; prefix: string }): Promise<readonly DomainEventEnvelope[]>;
  /** These are on their subscribers' queues: don't return them again. */
  relayed(ids: readonly string[], a: { prefix: string }): Promise<void>;
}

/** Event feeds, polled in registration order. */
export const eventFeeds = createHookRegistry<EventFeed>('event feed', byName, {
  collects: 'eventFeeds',
});

/* ── Erasure and export of personal data ───────────────────────────────────── */

/** Whose data: a person or a contact, in one business, or in every business when omitted. */
export interface DataSubject {
  subject: Subject;
  tenantId?: string;
}

/** What one feature erases or anonymises when a person asks to be forgotten. */
export interface ErasureContributor {
  /** Unique: 'files'. */
  name: string;
  /** In the erasure's transaction. Returns how many records it touched, for the evidence. */
  erase(a: DataSubject & { tx: Tx }): Promise<{ count: number }>;
}

/** Erasure contributors, in the order they run. */
export const erasureContributors = createHookRegistry<ErasureContributor>(
  'erasure contributor',
  byName,
  { collects: 'erasureContributors' },
);

/** What one feature holds about a person, for their data export. */
export interface ExportContributor {
  /** Unique: 'files'. */
  name: string;
  /** JSON-ready records by kind: { files: [...] }. */
  export(a: DataSubject & { db: Conn }): Promise<Record<string, readonly unknown[]>>;
}

/** Export contributors, in the order they run. */
export const exportContributors = createHookRegistry<ExportContributor>(
  'export contributor',
  byName,
  { collects: 'exportContributors' },
);

/* ── Sign-in ───────────────────────────────────────────────────────────────── */

/** What a feature adds to sign-in: a Better Auth plugin, and origins it trusts. */
export interface AuthPlugin {
  /** Unique: 'oauth-provider'. */
  name: string;
  plugin?: BetterAuthPlugin;
  /** More origins that may call the API with cookies. */
  trustedOrigins?: readonly string[];
}

/** Auth plugins, in registration order. Nothing adds them to Better Auth yet. */
export const authPlugins = createHookRegistry<AuthPlugin>('auth plugin', byName, {
  collects: 'authPlugins',
});
