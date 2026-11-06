// The core's extension points: types and empty registries. Features and application modules
// fill them through `contributes` (installed when the process starts) or by registering
// directly. Nothing in the write or read path reads them yet: each consumer wires its own read.
import type { AuthorizeResult, Channel, EntitySpec, Principal, WriteAction } from '@hykr/contracts';
import { createHookRegistry } from '@hykr/contracts';
import type { SQL, Table } from 'drizzle-orm';
import type { EntityRule } from './entity/define-entity.js';
import type { Tx } from './tokens.js';
import type { Touched, WriteCtx, WriteOp } from './write/pipeline.js';

type Values = Record<string, unknown>;

declare module '@hykr/contracts' {
  interface Contributions {
    entityPlugins: readonly EntityPlugin[];
    writeHooks: readonly WriteHook[];
    readProjectors: readonly ReadProjector[];
    identityProviders: readonly AgentIdentityProvider[];
  }
}

/** What a plugin sees of the entity it serves. */
export interface EntityPluginTarget {
  spec: EntitySpec;
  table: Table;
}

/**
 * Behaviour several entities share (versions, field policy, a parent's scope), written once
 * and switched on per entity, usually by a trait on its spec. Every hook is optional.
 */
export interface EntityPlugin {
  /** Unique: 'versioned', 'field-policy'. */
  name: string;
  /** Whether it serves this entity, usually because the spec has its trait. Omitted: all. */
  appliesTo?(spec: EntitySpec): boolean;
  /** More refusals, like the entity's own rules: they deny or have no opinion. */
  rules?: readonly EntityRule<Table>[];
  /** A decision before the spec's approval rule: refuse, or park with a tier. null: none. */
  decide?(
    p: Principal,
    action: WriteAction,
    row: Values | null,
    input: Values | null,
    target: EntityPluginTarget,
  ): AuthorizeResult | null;
  /** More conditions on the rows this principal reaches, for reading or for writing. */
  scope?(p: Principal, op: 'read' | 'write', target: EntityPluginTarget): SQL | undefined;
  /** The column values an insert or update writes: add or change some (a version bump). */
  toValues?(
    values: Values,
    write: { p: Principal; action: 'create' | 'update'; row: Values | null; input: Values },
    target: EntityPluginTarget,
  ): Values;
  /** A stored row as JSON, before the read schema parses it (a money column as a number). */
  toJson?(row: Values, target: EntityPluginTarget): Values;
  /** More conditions on the row an update or delete targets. No match answers 409 (stale). */
  updateWhere?(row: Values, input: Values | null, target: EntityPluginTarget): SQL | undefined;
  /** The record as this principal may see it: fields removed, never added. */
  project?(read: Values, p: Principal, target: EntityPluginTarget): Values;
}

/** Entity plugins, in the order they run. */
export const entityPlugins = createHookRegistry<EntityPlugin>('entity plugin', (x) => x.name, {
  collects: 'entityPlugins',
});

/** One write as a hook sees it. */
export interface WriteHookArgs {
  ctx: WriteCtx;
  // biome-ignore lint/suspicious/noExplicitAny: any operation, entity or command
  op: WriteOp<any, any, any>;
  input: unknown;
  loaded: unknown;
}

/** Something every write passes through (metering, a conflict check), whatever it writes. */
export interface WriteHook {
  /** Unique: 'credits', 'if-match'. */
  name: string;
  /** After the operation's own decision: tighten it (refuse, or park), never loosen it. */
  decide?(a: WriteHookArgs & { decision: AuthorizeResult }): AuthorizeResult | null;
  /** In the write's transaction, after the work and its audit rows. Throwing rolls it back. */
  afterRun?(
    a: WriteHookArgs & { tx: Tx; value: unknown; touched: readonly Touched[] },
  ): Promise<void> | void;
}

/** Write hooks, in the order they run. */
export const writeHooks = createHookRegistry<WriteHook>('write hook', (x) => x.name, {
  collects: 'writeHooks',
});

/**
 * How a record looks to one principal wherever it leaves the server: API, tools, history,
 * approvals, events, files and webhooks. Field policy hides cost from a role this way.
 */
export interface ReadProjector {
  /** Unique: 'field-policy'. */
  name: string;
  /** A record of this type ('task', 'approval') for p. Remove fields; never add any. */
  project(resourceType: string, value: Values, p: Principal): Values;
}

/** Read projectors, in the order they run. */
export const readProjectors = createHookRegistry<ReadProjector>('read projector', (x) => x.name, {
  collects: 'readProjectors',
});

/** A record through every read projector, in order. With none registered, it is unchanged. */
export function projectRead(resourceType: string, value: Values, p: Principal): Values {
  return readProjectors.all().reduce((v, x) => x.project(resourceType, v, p), value);
}

/** A request as an identity provider sees it. */
export interface IdentityRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** An agent caller a provider recognised: who it is, and whom it acts for. */
export interface AgentIdentity {
  /** The agent, as audited (the actor's id). */
  agentId: string;
  /** Whom it acts for: a person, or a contact without an account. */
  actingFor: { userId?: string; contactId?: string };
  /** The business, when the credential fixes it (a run token, an MCP grant). */
  tenantId?: string;
  channel?: Channel;
  runId?: string;
  agentVersion?: string;
  /** What the credential is limited to. It never adds to what the person may do. */
  scopes?: readonly string[];
  /** May start a chat turn for the person it acts for (POST /api/chat). */
  relay?: boolean;
}

/**
 * One way an agent proves who it is: the agent key today; later an MCP bearer token or an
 * agent run's token. Providers are asked in order.
 */
export interface AgentIdentityProvider {
  /** Unique: 'mcp-bearer'. */
  name: string;
  /**
   * null: not this provider's credential, so the next one is asked. A credential that is this
   * provider's but fails throws (401): it never falls through to a weaker check.
   */
  identify(req: IdentityRequest): Promise<AgentIdentity | null>;
}

/** Agent identity providers, in the order they are asked. */
export const identityProviders = createHookRegistry<AgentIdentityProvider>(
  'agent identity provider',
  (x) => x.name,
  { collects: 'identityProviders' },
);
