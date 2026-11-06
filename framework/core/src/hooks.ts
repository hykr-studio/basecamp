// The core's extension points. Features and application modules fill them through
// `contributes` (installed when the process starts) or by registering directly. The write and
// read path reads entity plugins (defineEntity), write hooks (runWrite) and read projectors
// (every record that leaves: toRead, command results, approvals, history, eventFor) per call.
import type {
  AuthorizeResult,
  Channel,
  EntitySpec,
  Principal,
  WriteAction,
  WriteResult,
} from '@hykr/contracts';
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
 * and switched on per entity, usually by a trait on its spec. Every hook is optional. Plugins
 * run in registration order, after the entity's own config: `rules` wherever its rules run,
 * `decide` on CRUD writes only (a command's `authorize` decides the command), `scope`,
 * `toValues` and `updateWhere` in every repository call, `toJson` and `project` in `toRead`.
 */
export interface EntityPlugin {
  /** Unique: 'versioned', 'field-policy'. */
  name: string;
  /** Whether it serves this entity, usually because the spec has its trait. Omitted: all. */
  appliesTo?(spec: EntitySpec): boolean;
  /** More rules, run after the entity's own: a refusal refuses, a park parks a CRUD write. */
  rules?: readonly EntityRule<Table>[];
  /**
   * A CRUD write's decision, after the rules and before the spec's approval rule: refuse, park
   * at an approval level with an approver, or allow with a level or an undo window. null: no
   * opinion. The strictest decision wins (`strongerDecision`).
   */
  decide?(
    p: Principal,
    action: WriteAction,
    row: Values | null,
    input: Values | null,
    target: EntityPluginTarget,
  ): AuthorizeResult | null;
  /** More conditions on the rows this principal reaches, for reading or for writing. */
  scope?(p: Principal, op: 'read' | 'write', target: EntityPluginTarget): SQL | undefined;
  /**
   * The column values an insert or update writes: add or change some (a version bump). Keys
   * that are not columns are dropped, and the business, owner, customer and `createdBy` are
   * always the framework's.
   */
  toValues?(
    values: Values,
    write: { p: Principal; action: 'create' | 'update'; row: Values | null; input: Values },
    target: EntityPluginTarget,
  ): Values;
  /** A stored row as JSON, before the read schema parses it (a money column as a number). */
  toJson?(row: Values, target: EntityPluginTarget): Values;
  /**
   * More conditions on the row an update or delete targets (its version is still the one read).
   * When they fail but the row is still there, the write answers 409 `{ error: 'stale' }`.
   */
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

/**
 * Something every write passes through (metering, a conflict check), whatever it writes: entity
 * CRUD, commands and approved replays alike. Not called for an idempotent repeat.
 */
export interface WriteHook {
  /** Unique: 'credits', 'if-match'. */
  name: string;
  /**
   * After the operation's own decision: tighten it (refuse, or park), never loosen it. Its
   * answer is combined with `strongerDecision`, so an `allow` can only add an undo window. It
   * runs before an approved replay turns a park into an allow: a refusal still refuses then.
   */
  decide?(a: WriteHookArgs & { decision: AuthorizeResult }): AuthorizeResult | null;
  /**
   * In the write's transaction, after the work, its audit rows and its stored events, for a
   * write that ran or parked (`result` says which; a parked one has no value and touched
   * nothing). Throwing rolls the whole write back.
   */
  afterRun?(
    a: WriteHookArgs & {
      tx: Tx;
      value: unknown;
      touched: readonly Touched[];
      result: WriteResult;
    },
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
