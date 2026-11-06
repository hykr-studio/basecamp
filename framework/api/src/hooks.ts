// The server's extension points: types and empty registries. Features and application modules
// fill them through `contributes` (defineServer), installed once when the process starts
// (setRuntime). Nothing reads them yet: each consumer wires its own read where it applies.
import type { InboundMessage } from '@hykr/channels';
import type { Channel, Principal, Subject } from '@hykr/contracts';
import { createHookRegistry } from '@hykr/contracts';
import type { Conn, Tx } from '@hykr/core';
import type { Lang } from '@hykr/i18n';
import type { NotificationDef, Reader, Row } from '@hykr/notifications';
import type { BetterAuthPlugin } from 'better-auth';

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
    erasureContributors: readonly ErasureContributor[];
    exportContributors: readonly ExportContributor[];
    authPlugins: readonly AuthPlugin[];
  }
}

const byName = (x: { name: string }) => x.name;

/* ── Delivery channels ─────────────────────────────────────────────────────── */

/** One notification to one recipient, as notify() resolved it. */
export interface DeliveryRequest {
  tenantId: string;
  // biome-ignore lint/suspicious/noExplicitAny: any notification's row
  notification: NotificationDef<any>;
  /** Whom to reach: a person, a contact, or both when the number is linked. */
  to: { userId?: string; contactId?: string };
  reader: Reader;
  row: Row;
}

export type DeliveryOutcome =
  | { status: 'sent'; ref?: string }
  /** It cannot reach them here (no token, no address): the next channel is tried now. */
  | { status: 'unavailable'; reason: string }
  /** It tried and failed. `final`: no retry on this channel, the next one is tried. */
  | { status: 'failed'; reason: string; final: boolean };

/** A way to reach a person (push, in-app, WhatsApp, email), named in `channels`. */
export interface DeliveryChannel {
  /** Unique: 'push'. */
  name: string;
  deliver(req: DeliveryRequest): Promise<DeliveryOutcome>;
}

/** Delivery channels, by name. */
export const deliveryChannels = createHookRegistry<DeliveryChannel>('delivery channel', byName, {
  collects: 'deliveryChannels',
});

/* ── Turn hooks ────────────────────────────────────────────────────────────── */

/** One assistant turn, whatever the channel. */
export interface TurnInfo {
  principal: Principal;
  runId: string;
  threadId: string;
  message: string;
  channel: Channel;
  lang?: Lang;
}

/** Refuse the turn (a credit cap reached), or give the model more context (recalled memory). */
export type TurnGate =
  | { refuse: { rule: string; reason: string } }
  | { context: readonly string[] };

/** What a finished turn did and used. */
export interface TurnOutcome {
  text: string;
  /** The tools it called, by id, in order. */
  toolCalls: readonly string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** The reply failed or was cut off. */
  interrupted: boolean;
}

/** Something every assistant turn passes through: caps and metering, memory recall. */
export interface TurnHook {
  /** Unique: 'credits'. */
  name: string;
  /** Before the model runs. null: no opinion. */
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

/** Something every inbound message passes through before its turn (store a photo's media). */
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

/** A queue a feature or module runs jobs on, in the worker. */
export interface QueueDef {
  /** Prefixed by its owner, so names never collide: 'credits.alerts'. */
  name: string;
  /** Jobs at once per worker. Default 1. */
  concurrency?: number;
  /** Tries before a job fails for good. */
  attempts?: number;
  /** The first retry's delay in milliseconds; it doubles each time. */
  backoffMs?: number;
}

/** Queues, by name. */
export const queues = createHookRegistry<QueueDef>('queue', byName, { collects: 'queues' });

/** A job added on a schedule. Give exactly one of `every` and `cron`. */
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
