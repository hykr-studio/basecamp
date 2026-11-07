// The integration bus's registries: connectors (kinds of outside systems) and connector handlers
// (what an inbound event does in the application). Nothing here reads the configuration or
// loads Nest: safe to import from an application module at load time.
import type { Connector } from '@hykr/connectors';
import {
  createHookRegistry,
  type Principal,
  reserveRoutes,
  type WriteResult,
} from '@hykr/contracts';
import type { WriteOp } from '@hykr/core';
import type { ServerContext } from '../../hooks.js';
import { matchesEvent } from '../events/subscriber.js';

declare module '@hykr/contracts' {
  interface Contributions {
    // biome-ignore lint/suspicious/noExplicitAny: each connector has its own credentials
    connectors: readonly Connector<any>[];
    connectorHandlers: readonly ConnectorHandler[];
  }
}

// The feature's routes: /api/integrations/*. No module may claim them.
reserveRoutes('integrations');

/** `/webhooks/whatsapp` is the WhatsApp channel's own webhook. */
const RESERVED_CONNECTORS = new Set(['whatsapp']);

/**
 * Kinds of outside systems, by name. The feature registers `standard-webhooks`; an application
 * adds its own (`hmacConnector(...)` or a `defineConnector`) as the `connectors` contribution.
 */
// biome-ignore lint/suspicious/noExplicitAny: each connector has its own credentials
export const connectors = createHookRegistry<Connector<any>>(
  'connector',
  (c) => {
    if (RESERVED_CONNECTORS.has(c.name))
      throw new Error(`The connector name "${c.name}" is taken by a channel`);
    return c.name;
  },
  { collects: 'connectors' },
);

/** One stored inbound event, as a handler receives it. */
export interface InboundEventRecord {
  /** The stored row's id: the run id its writes are audited with. */
  id: string;
  tenantId: string;
  connectionId: string;
  connector: string;
  /** The sender's id for it. */
  externalId: string;
  type: string;
  data: unknown;
  receivedAt: string;
}

/** What a handler works with: the business's system principal and an audited write. */
export interface ConnectorHandlerContext extends ServerContext {
  /** `systemPrincipal({ tenantId, job: 'integrations.<connector>', runId: <event id> })`. */
  principal: Principal;
  connection: {
    id: string;
    connector: string;
    label: string | null;
    /** The connector's public fields. */
    public: Record<string, unknown>;
  };
  /**
   * One write through `runWrite`, as the principal, with an idempotency key per event, handler
   * and call: a retried event repeats nothing that already committed. A refusal throws.
   */
  // biome-ignore lint/suspicious/noExplicitAny: any operation
  write(op: WriteOp<any, any, any>, input: unknown): Promise<WriteResult>;
  /** The connection's credentials, opened: to call the sender back. */
  credentials<C = unknown>(): Promise<C>;
}

/**
 * What an inbound event does: contributed as `connectorHandlers` by a module or the
 * application, run in the worker for each stored event of its connector whose type matches.
 * A handler that finished is not run again. An error with a 4xx status (403, 404, 409) is
 * final; any other error retries the event.
 */
export interface ConnectorHandler {
  /** Unique, prefixed by its owner: 'tasks.complete-from-sender'. */
  name: string;
  /** The connector it takes events from. */
  connector: string;
  /** Event types ('record.paid'), prefixes ('record.*') or '*'. */
  on: readonly string[];
  /** What its principal may do besides reaching the business's rows. Default: nothing. */
  capabilities?: readonly string[];
  handle(event: InboundEventRecord, ctx: ConnectorHandlerContext): Promise<void>;
}

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** A connector handler, checked: its name and its patterns. */
export function defineConnectorHandler(def: ConnectorHandler): ConnectorHandler {
  if (!NAME.test(def.name))
    throw new Error(`The handler name "${def.name}" must be lower case words joined by "." or "-"`);
  if (!def.on.length) throw new Error(`Handler ${def.name}: name at least one event type in on`);
  const bad = def.on.find((p) => !p || p.length > 200 || /\s/.test(p));
  if (bad !== undefined) throw new Error(`Handler ${def.name}: "${bad}" is not an event type`);
  return def;
}

/** Connector handlers, in registration order. */
export const connectorHandlers = createHookRegistry<ConnectorHandler>(
  'connector handler',
  (h) => defineConnectorHandler(h).name,
  { collects: 'connectorHandlers' },
);

/** The handlers that take this event, in order. */
export const handlersFor = (connector: string, type: string) =>
  connectorHandlers
    .all()
    .filter((h) => h.connector === connector && h.on.some((p) => matchesEvent(p, type)));
