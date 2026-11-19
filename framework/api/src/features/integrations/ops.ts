// Every change to the integration bus's own records goes through runWrite as one of these ops:
// authorized by `integrations.manage` (a refusal is audited), tightened by write hooks, parked
// when a hook asks, audited before and after with secrets left out, and replayable after an
// approval. Inputs carry secrets only sealed, so a parked op stores nothing in the clear.
import { checkUrl } from '@hykr/connectors';
import { capabilities, type Principal } from '@hykr/contracts';
import { allow, deny, type NamedEvent, registerOp, type Tx, type WriteOp } from '@hykr/core';
import {
  integrationAccounts,
  integrationConnections,
  integrationDeliveries,
  integrationEndpoints,
} from '@hykr/db';
import { can, userIdOf } from '@hykr/policy';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { IntegrationsCapability } from './capability.js';
import { connectors } from './registry.js';
import { outboundPolicy } from './settings.js';

export type EndpointRow = typeof integrationEndpoints.$inferSelect;
export type ConnectionRow = typeof integrationConnections.$inferSelect;
export type DeliveryRow = typeof integrationDeliveries.$inferSelect;

/* ── What leaves the API (and the audit trail): never a sealed value ─────────── */

export const endpointView = (r: EndpointRow) => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  capabilities: r.capabilities,
  status: r.status as 'active' | 'paused',
  /** Until then the previous secret signs too (after a rotation). */
  previousSecretUntil:
    r.previousExpiresAt && r.previousExpiresAt > new Date()
      ? r.previousExpiresAt.toISOString()
      : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** A stored event of the integration bus's own records (connections): ids and names only. */
export class IntegrationEvent implements NamedEvent {
  constructor(
    readonly eventName: string,
    readonly row: Record<string, unknown>,
    readonly resourceType = 'integration_connection',
  ) {}
  get resourceId() {
    return typeof this.row.id === 'string' ? this.row.id : null;
  }
}

/** Where a connection's sender posts: its own URL, or the provider's one URL (a shared one). */
function inboundPathOf(r: ConnectionRow) {
  const inbound = connectors.get(r.connector)?.inbound;
  if (inbound && !inbound.verify && inbound.shared) return `/webhooks/${r.connector}`;
  return `/webhooks/${r.connector}/${r.id}`;
}

export const connectionView = (r: ConnectionRow) => ({
  id: r.id,
  connector: r.connector,
  label: r.label,
  status: r.status as 'active' | 'disabled' | 'needs_reauth',
  /** 'credentials' (given) or 'oauth' (signed in). */
  auth: r.auth as 'credentials' | 'oauth',
  public: r.public as Record<string, unknown>,
  /** What a signed-in connection's grant allows. */
  scopes: r.scopes,
  /** When its access token ends, if it does. */
  tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
  /** Why it needs signing in again. */
  lastError: r.lastError,
  /** Where the sender posts: this server's address, then this path. */
  inboundPath: inboundPathOf(r),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export type AccountRow = typeof integrationAccounts.$inferSelect;

/** An account a signed-in connection reaches: its id and name, never its token. */
export const accountView = (a: AccountRow) => ({ id: a.accountId, name: a.name, held: a.held });

export const deliveryView = (r: DeliveryRow) => ({
  id: r.id,
  endpointId: r.endpointId,
  eventId: r.eventId,
  eventName: r.eventName,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
  lastStatus: r.lastStatus,
  lastError: r.lastError,
  deliveredAt: r.deliveredAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/* ── Inputs ──────────────────────────────────────────────────────────────── */

/** 'task.created', 'task.*' or '*', as subscribers take them. */
const PATTERN = /^(?:\*|[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*(?:\.\*)?)$/;

const Url = z
  .string()
  .max(2000)
  .superRefine((url, ctx) => {
    const checked = checkUrl(url, outboundPolicy());
    if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.reason });
  });

const Events = z
  .array(z.string().regex(PATTERN, 'not an event name or "<prefix>.*"'))
  .min(1)
  .max(50);

const Capabilities = z
  .array(z.string())
  .max(50)
  .superRefine((names, ctx) => {
    for (const name of names)
      if (!capabilities.has(name))
        ctx.addIssue({ code: 'custom', message: `unknown capability ${name}` });
  })
  .transform((names) => [...new Set(names)].sort());

/** POST /api/integrations/endpoints. */
export const EndpointCreate = z.strictObject({
  url: Url,
  description: z.string().max(500).optional(),
  events: Events,
  capabilities: Capabilities.default([]),
});

/** PATCH /api/integrations/endpoints/:id. */
export const EndpointUpdate = z.strictObject({
  url: Url.optional(),
  description: z.string().max(500).nullable().optional(),
  events: Events.optional(),
  capabilities: Capabilities.optional(),
  status: z.enum(['active', 'paused']).optional(),
});

/** POST /api/integrations/connections. Credentials are checked against the connector's schema. */
export const ConnectionCreate = z.strictObject({
  connector: z.string().max(40),
  label: z.string().max(200).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

/** PATCH /api/integrations/connections/:id. */
export const ConnectionUpdate = z.strictObject({
  label: z.string().max(200).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

const Sealed = z.string().min(1).max(20_000);

const EndpointCreateOp = EndpointCreate.extend({ id: z.uuid(), sealed: Sealed });
const EndpointUpdateOp = EndpointUpdate;
const RotateOp = z.strictObject({ sealed: Sealed });
const ConnectionCreateOp = z.strictObject({
  id: z.uuid(),
  connector: z.string().max(40),
  label: z.string().max(200).optional(),
  sealed: Sealed,
  public: z.record(z.string(), z.unknown()),
});
const ConnectionUpdateOp = z.strictObject({
  label: z.string().max(200).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  sealed: Sealed.optional(),
  public: z.record(z.string(), z.unknown()).optional(),
});
const Nothing = z.strictObject({});

/** POST /api/integrations/connections/oauth/start. */
export const OAuthStart = z.strictObject({
  connector: z.string().max(40),
  returnTo: z.enum(['web', 'app']).default('web'),
  label: z.string().max(200).optional(),
  /** Sign an existing connection in again (it needs it, or more scopes). */
  connectionId: z.uuid().optional(),
});

/** POST /api/integrations/connections/oauth/complete: what the provider sent the browser back with. */
export const OAuthComplete = z.strictObject({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(200),
});

/** POST /api/integrations/connections/:id/oauth/pick. */
export const OAuthPick = z.strictObject({
  accountIds: z.array(z.string().min(1).max(200)).max(200),
});

const AccountInput = z.strictObject({
  accountId: z.string().min(1).max(200),
  name: z.string().max(500),
  tokenSealed: Sealed.optional(),
  held: z.boolean(),
});

const OAuthConnectOp = z.strictObject({
  id: z.uuid(),
  connector: z.string().max(40),
  label: z.string().max(200).nullable().optional(),
  /** Signing `id` in again: it exists. */
  reconnect: z.boolean(),
  sealed: Sealed,
  scopes: z.array(z.string().max(200)).max(100),
  tokenExpiresAt: z.iso.datetime().nullable(),
  public: z.record(z.string(), z.string().max(500)),
  accounts: z.array(AccountInput).max(200),
});

const OAuthPickOp = OAuthPick;

/* ── Authorization ─────────────────────────────────────────────────────────── */

const manage = (p: Principal) =>
  can(p, IntegrationsCapability)
    ? allow('integrations_manage', "Manages the business's integrations")
    : deny('integrations_manage_needed', 'Only people who manage integrations can change them');

/**
 * An endpoint reads with its capabilities, so whoever points it somewhere must hold them: a
 * person can give an endpoint, or send an endpoint's reads to a new URL, only with what they
 * may read themselves. A capability no longer registered grants nothing, so it is not asked for.
 */
function holds(
  p: Principal,
  names: Iterable<string>,
  reason = 'You can give an endpoint only what you may read yourself',
) {
  const held = new Set(p.capabilities ?? []);
  const missing = [...new Set(names)].filter((n) => capabilities.has(n) && !held.has(n)).sort();
  return missing.length
    ? deny('capability_not_held', `${reason} (not ${missing.join(', ')})`)
    : null;
}

/**
 * May this person be shown a secret again (a repeated create or rotate)? What the write itself
 * asks: managing integrations and, for an endpoint, every capability it reads with. The stored
 * answer is the caller's, but their roles may have changed since.
 */
export function mayShowSecret(p: Principal, endpointCapabilities: readonly string[] = []) {
  const allowed = manage(p);
  return allowed.decision === 'allow'
    ? (holds(p, endpointCapabilities, 'Only someone who holds what it reads may see its secret') ??
        allowed)
    : allowed;
}

/* ── Ops ───────────────────────────────────────────────────────────────────── */

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const ENDPOINT = 'integration_endpoint';
const CONNECTION = 'integration_connection';
const DELIVERY = 'integration_delivery';

type Id = { id?: string } | null;
const idOf = (args: Id) => {
  if (!args?.id) throw new Error('The operation needs the record id');
  return args.id;
};

export function createEndpointOp(): WriteOp<
  z.infer<typeof EndpointCreateOp>,
  undefined,
  EndpointRow
> {
  return {
    name: 'integrations.endpoint.create',
    kind: 'command',
    resourceType: ENDPOINT,
    resourceId: (input) => input.id,
    input: EndpointCreateOp,
    authorize: (p, _loaded, input) => {
      const allowed = manage(p);
      return allowed.decision === 'allow' ? (holds(p, input.capabilities) ?? allowed) : allowed;
    },
    summarize: (input) => `Send ${input.events.join(', ')} to ${hostOf(input.url)}`,
    run: async ({ tx, principal, input }) => {
      const [row] = await tx
        .insert(integrationEndpoints)
        .values({
          id: input.id,
          tenantId: principal.tenantId as string,
          url: input.url,
          description: input.description ?? null,
          events: input.events,
          capabilities: input.capabilities,
          secretSealed: input.sealed,
          createdBy: userIdOf(principal) ?? null,
          // The app's clock, as an event's occurredAt: it gets only events from now on.
          createdAt: new Date(),
        })
        .returning();
      return {
        value: row,
        touched: [{ type: ENDPOINT, id: row.id, change: 'created', after: endpointView(row) }],
      };
    },
    present: (row) => endpointView(row),
  };
}

const loadEndpoint = (id: string) => async (tx: Tx, p: Principal) => {
  const [row] = await tx
    .select()
    .from(integrationEndpoints)
    .where(
      and(eq(integrationEndpoints.id, id), eq(integrationEndpoints.tenantId, p.tenantId ?? '')),
    );
  if (!row) throw notFound('endpoint');
  return row;
};

export function updateEndpointOp(
  args: Id,
): WriteOp<z.infer<typeof EndpointUpdateOp>, EndpointRow, EndpointRow> {
  const id = idOf(args);
  return {
    name: 'integrations.endpoint.update',
    kind: 'command',
    resourceType: ENDPOINT,
    resourceId: () => id,
    input: EndpointUpdateOp,
    args: { id },
    load: loadEndpoint(id),
    authorize: (p, row, input) => {
      const allowed = manage(p);
      if (allowed.decision !== 'allow') return allowed;
      // Pausing or describing it sends nothing new anywhere. A new URL or a new set of
      // capabilities needs every capability the endpoint has and will have: otherwise someone
      // could empty a set they do not hold, then point the endpoint (and its log) elsewhere.
      const redirects = input.url !== undefined || input.capabilities !== undefined;
      const affected = [...row.capabilities, ...(input.capabilities ?? [])];
      return (redirects && holds(p, affected)) || allowed;
    },
    summarize: (input, row) =>
      input.status === 'paused'
        ? `Pause the webhook to ${hostOf(row.url)}`
        : `Change the webhook to ${hostOf(input.url ?? row.url)}`,
    run: async ({ tx, input, loaded }) => {
      const [row] = await tx
        .update(integrationEndpoints)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(integrationEndpoints.id, loaded.id))
        .returning();
      return {
        value: row,
        touched: [
          {
            type: ENDPOINT,
            id: row.id,
            change: 'updated',
            before: endpointView(loaded),
            after: endpointView(row),
          },
        ],
      };
    },
    present: (row) => endpointView(row),
  };
}

export function deleteEndpointOp(args: Id): WriteOp<Record<string, never>, EndpointRow, null> {
  const id = idOf(args);
  return {
    name: 'integrations.endpoint.delete',
    kind: 'command',
    resourceType: ENDPOINT,
    resourceId: () => id,
    input: Nothing,
    args: { id },
    load: loadEndpoint(id),
    authorize: (p) => manage(p),
    summarize: (_input, row) => `Delete the webhook to ${hostOf(row.url)}`,
    run: async ({ tx, loaded }) => {
      await tx.delete(integrationEndpoints).where(eq(integrationEndpoints.id, loaded.id));
      return {
        value: null,
        touched: [
          { type: ENDPOINT, id: loaded.id, change: 'deleted', before: endpointView(loaded) },
        ],
      };
    },
    present: () => null,
  };
}

export function rotateEndpointOp(
  args: Id,
  keepMs = 0,
): WriteOp<z.infer<typeof RotateOp>, EndpointRow, EndpointRow> {
  const id = idOf(args);
  return {
    name: 'integrations.endpoint.rotate',
    kind: 'command',
    resourceType: ENDPOINT,
    resourceId: () => id,
    input: RotateOp,
    args: { id, keepMs },
    load: loadEndpoint(id),
    authorize: (p, row) => {
      const allowed = manage(p);
      return allowed.decision === 'allow' ? (holds(p, row.capabilities) ?? allowed) : allowed;
    },
    summarize: (_input, row) => `New signing secret for the webhook to ${hostOf(row.url)}`,
    run: async ({ tx, input, loaded }) => {
      const [row] = await tx
        .update(integrationEndpoints)
        .set({
          secretSealed: input.sealed,
          previousSecretSealed: keepMs > 0 ? loaded.secretSealed : null,
          previousExpiresAt: keepMs > 0 ? new Date(Date.now() + keepMs) : null,
          updatedAt: new Date(),
        })
        .where(eq(integrationEndpoints.id, loaded.id))
        .returning();
      return {
        value: row,
        touched: [
          {
            type: ENDPOINT,
            id: row.id,
            change: 'updated',
            before: endpointView(loaded),
            after: { ...endpointView(row), secret: 'rotated' },
          },
        ],
      };
    },
    present: (row) => endpointView(row),
  };
}

export function createConnectionOp(): WriteOp<
  z.infer<typeof ConnectionCreateOp>,
  undefined,
  ConnectionRow
> {
  return {
    name: 'integrations.connection.create',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: (input) => input.id,
    input: ConnectionCreateOp,
    authorize: (p) => manage(p),
    summarize: (input) => `Connect ${input.label ?? input.connector}`,
    run: async ({ tx, principal, input }) => {
      const [row] = await tx
        .insert(integrationConnections)
        .values({
          id: input.id,
          tenantId: principal.tenantId as string,
          connector: input.connector,
          label: input.label ?? null,
          credentialsSealed: input.sealed,
          public: input.public,
          createdBy: userIdOf(principal) ?? null,
        })
        .returning();
      return {
        value: row,
        touched: [{ type: CONNECTION, id: row.id, change: 'created', after: connectionView(row) }],
      };
    },
    present: (row) => connectionView(row),
  };
}

const loadConnection = (id: string) => async (tx: Tx, p: Principal) => {
  const [row] = await tx
    .select()
    .from(integrationConnections)
    .where(
      and(eq(integrationConnections.id, id), eq(integrationConnections.tenantId, p.tenantId ?? '')),
    );
  if (!row) throw notFound('connection');
  return row;
};

export function updateConnectionOp(
  args: Id,
): WriteOp<z.infer<typeof ConnectionUpdateOp>, ConnectionRow, ConnectionRow> {
  const id = idOf(args);
  return {
    name: 'integrations.connection.update',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: () => id,
    input: ConnectionUpdateOp,
    args: { id },
    load: loadConnection(id),
    authorize: (p, loaded, input) =>
      loaded.status === 'needs_reauth' && input.status === 'active'
        ? deny('oauth_sign_in_needed', 'Sign this connection in again to turn it back on')
        : manage(p),
    summarize: (input, row) =>
      input.sealed
        ? `New credentials for ${row.label ?? row.connector}`
        : `Change ${row.label ?? row.connector}`,
    run: async ({ tx, input, loaded }) => {
      const { sealed, ...rest } = input;
      const [row] = await tx
        .update(integrationConnections)
        .set({ ...rest, ...(sealed ? { credentialsSealed: sealed } : {}), updatedAt: new Date() })
        .where(eq(integrationConnections.id, loaded.id))
        .returning();
      return {
        value: row,
        touched: [
          {
            type: CONNECTION,
            id: row.id,
            change: 'updated',
            before: connectionView(loaded),
            after: { ...connectionView(row), ...(sealed ? { credentials: 'replaced' } : {}) },
          },
        ],
      };
    },
    present: (row) => connectionView(row),
  };
}

export function deleteConnectionOp(args: Id): WriteOp<Record<string, never>, ConnectionRow, null> {
  const id = idOf(args);
  return {
    name: 'integrations.connection.delete',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: () => id,
    input: Nothing,
    args: { id },
    load: loadConnection(id),
    authorize: (p) => manage(p),
    summarize: (_input, row) => `Disconnect ${row.label ?? row.connector}`,
    run: async ({ tx, loaded }) => {
      await tx.delete(integrationConnections).where(eq(integrationConnections.id, loaded.id));
      return {
        value: null,
        touched: [
          { type: CONNECTION, id: loaded.id, change: 'deleted', before: connectionView(loaded) },
        ],
      };
    },
    present: () => null,
  };
}

/** A delivery, with the capabilities its endpoint reads with now. */
type DeliveryToRetry = DeliveryRow & { endpointCapabilities: string[] };

/** One more try of a delivery, now (its job is added once the write commits). */
export function retryDeliveryOp(
  args: Id,
): WriteOp<Record<string, never>, DeliveryToRetry, DeliveryRow> {
  const id = idOf(args);
  return {
    name: 'integrations.delivery.retry',
    kind: 'command',
    resourceType: DELIVERY,
    resourceId: () => id,
    input: Nothing,
    args: { id },
    load: async (tx, p) => {
      const [found] = await tx
        .select({
          delivery: integrationDeliveries,
          capabilities: integrationEndpoints.capabilities,
        })
        .from(integrationDeliveries)
        .innerJoin(
          integrationEndpoints,
          and(
            eq(integrationEndpoints.id, integrationDeliveries.endpointId),
            eq(integrationEndpoints.tenantId, integrationDeliveries.tenantId),
          ),
        )
        .where(
          and(
            eq(integrationDeliveries.id, id),
            eq(integrationDeliveries.tenantId, p.tenantId ?? ''),
          ),
        );
      if (!found) throw notFound('delivery');
      return { ...found.delivery, endpointCapabilities: found.capabilities };
    },
    authorize: (p, row) => {
      const allowed = manage(p);
      if (allowed.decision !== 'allow') return allowed;
      // A redelivery sends what the endpoint reads: only someone who may read it sends it.
      const refused = holds(
        p,
        row.endpointCapabilities,
        'You can send an endpoint again only what you may read yourself',
      );
      if (refused) return refused;
      return row.status === 'sending'
        ? deny('delivery_in_flight', 'This delivery is being sent right now')
        : allowed;
    },
    summarize: (_input, row) => `Send ${row.eventName} again`,
    run: async ({ tx, loaded }) => {
      const [row] = await tx
        .update(integrationDeliveries)
        .set({
          status: 'retrying',
          nextAttemptAt: sql`now()`,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationDeliveries.id, loaded.id))
        .returning();
      return {
        value: row,
        touched: [
          {
            type: DELIVERY,
            id: row.id,
            change: 'updated',
            before: deliveryView(loaded),
            after: deliveryView(row),
          },
        ],
      };
    },
    present: (row) => deliveryView(row),
  };
}

/* ── Signed-in connections (decisions B24) ──────────────────────────────────── */

/**
 * An account held elsewhere (by another connection, in any business) refuses the write: a
 * provider's shared URL routes each account's events to one connection only.
 */
async function heldElsewhere(tx: Tx, connector: string, connectionId: string, ids: string[]) {
  if (!ids.length) return;
  const taken = await tx
    .select({ accountId: integrationAccounts.accountId })
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.connector, connector),
        eq(integrationAccounts.held, true),
        inArray(integrationAccounts.accountId, ids),
        ne(integrationAccounts.connectionId, connectionId),
      ),
    );
  if (taken.length)
    throw new ConflictException({
      error: 'conflict',
      rule: 'account_connected_elsewhere',
      reason: `Connected elsewhere already: ${taken.map((t) => t.accountId).join(', ')}. Disconnect it there first.`,
      accounts: taken.map((t) => t.accountId),
    });
}

/** The postgres error of a unique index: a concurrent hold took the account first. */
const isUniqueViolation = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } })?.code === '23505' ||
  (e as { cause?: { code?: string } })?.cause?.code === '23505';

const takenRace = () =>
  new ConflictException({
    error: 'conflict',
    rule: 'account_connected_elsewhere',
    reason: 'An account was connected elsewhere at the same moment. Disconnect it there first.',
  });

const accountsOf = (tx: Tx, connectionId: string) =>
  tx.select().from(integrationAccounts).where(eq(integrationAccounts.connectionId, connectionId));

/**
 * A connection signed in: created, or (signing it in again) its grant replaced. The tokens come
 * sealed; the accounts are the provider's own answer (`describe`), held at once or offered for a
 * pick. Audited without a token; `connection.oauth_connected` names who, what and the scopes.
 */
export function oauthConnectOp(): WriteOp<
  z.infer<typeof OAuthConnectOp>,
  ConnectionRow | undefined,
  ConnectionRow
> {
  return {
    name: 'integrations.connection.oauth_connect',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: (input) => input.id,
    input: OAuthConnectOp,
    load: async (tx, p, input) => {
      if (!input.reconnect) return undefined;
      const row = await loadConnection(input.id)(tx, p);
      if (row.connector !== input.connector) throw notFound('connection');
      return row;
    },
    authorize: (p) => manage(p),
    summarize: (input) =>
      input.reconnect
        ? `Sign ${input.connector} in again`
        : `Connect ${input.label ?? input.connector}`,
    run: async ({ tx, principal, input, loaded }) => {
      const tenantId = principal.tenantId as string;
      const id = loaded?.id ?? input.id;
      const before = loaded ? await accountsOf(tx, id) : [];
      const wasHeld = new Set(before.filter((a) => a.held).map((a) => a.accountId));
      // Signing in again keeps what was picked, of the accounts the grant still reaches.
      const accounts = input.accounts.map((a) => ({
        ...a,
        held: a.held || wasHeld.has(a.accountId),
      }));
      await heldElsewhere(
        tx,
        input.connector,
        id,
        accounts.filter((a) => a.held).map((a) => a.accountId),
      );
      const values = {
        credentialsSealed: input.sealed,
        scopes: input.scopes,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        expiryNoticeAt: null,
        public: input.public,
        status: 'active',
        lastError: null,
        updatedAt: new Date(),
      };
      const [row] = loaded
        ? await tx
            .update(integrationConnections)
            .set({ ...values, ...(input.label ? { label: input.label } : {}) })
            .where(eq(integrationConnections.id, loaded.id))
            .returning()
        : await tx
            .insert(integrationConnections)
            .values({
              id,
              tenantId,
              connector: input.connector,
              label: input.label ?? null,
              auth: 'oauth',
              owner: 'business',
              createdBy: userIdOf(principal) ?? null,
              ...values,
            })
            .returning();
      try {
        await tx.delete(integrationAccounts).where(eq(integrationAccounts.connectionId, id));
        if (accounts.length)
          await tx.insert(integrationAccounts).values(
            accounts.map((a) => ({
              tenantId,
              connectionId: id,
              connector: input.connector,
              accountId: a.accountId,
              name: a.name,
              tokenSealed: a.tokenSealed ?? null,
              held: a.held,
            })),
          );
      } catch (e) {
        if (isUniqueViolation(e)) throw takenRace();
        throw e;
      }
      const names = (held: boolean) =>
        accounts.filter((a) => a.held === held).map((a) => ({ id: a.accountId, name: a.name }));
      return {
        value: row,
        touched: [
          {
            type: CONNECTION,
            id: row.id,
            change: loaded ? ('updated' as const) : ('created' as const),
            ...(loaded ? { before: connectionView(loaded) } : {}),
            after: {
              ...connectionView(row),
              credentials: loaded ? 'replaced' : 'signed in',
              accounts: { held: names(true), offered: names(false) },
            },
          },
        ],
        events: [
          new IntegrationEvent('connection.oauth_connected', {
            id: row.id,
            tenantId,
            connector: row.connector,
            label: row.label ?? row.connector,
            userId: userIdOf(principal) ?? null,
            scopes: row.scopes,
            public: row.public,
            accounts: names(true),
            reconnect: !!loaded,
          }),
        ],
      };
    },
    present: (row) => connectionView(row),
  };
}

/** The accounts a signed-in connection holds: the ones picked, of those it was offered. */
export function oauthPickOp(
  args: Id,
): WriteOp<z.infer<typeof OAuthPickOp>, ConnectionRow, ConnectionRow> {
  const id = idOf(args);
  return {
    name: 'integrations.connection.oauth_pick',
    kind: 'command',
    resourceType: CONNECTION,
    resourceId: () => id,
    input: OAuthPickOp,
    args: { id },
    load: loadConnection(id),
    authorize: (p) => manage(p),
    summarize: (input, row) =>
      `Receive ${input.accountIds.length} account(s) on ${row.label ?? row.connector}`,
    run: async ({ tx, input, loaded }) => {
      const offered = await accountsOf(tx, loaded.id);
      const known = new Set(offered.map((a) => a.accountId));
      const unknown = input.accountIds.filter((a) => !known.has(a));
      if (unknown.length)
        throw new BadRequestException({
          error: 'invalid',
          rule: 'account_not_offered',
          message: `Not offered by this sign-in: ${unknown.join(', ')}`,
        });
      const picked = [...new Set(input.accountIds)];
      await heldElsewhere(tx, loaded.connector, loaded.id, picked);
      try {
        const now = new Date();
        await tx
          .update(integrationAccounts)
          .set({ held: false, updatedAt: now })
          .where(eq(integrationAccounts.connectionId, loaded.id));
        if (picked.length)
          await tx
            .update(integrationAccounts)
            .set({ held: true, updatedAt: now })
            .where(
              and(
                eq(integrationAccounts.connectionId, loaded.id),
                inArray(integrationAccounts.accountId, picked),
              ),
            );
      } catch (e) {
        if (isUniqueViolation(e)) throw takenRace();
        throw e;
      }
      const [row] = await tx
        .update(integrationConnections)
        .set({ updatedAt: new Date() })
        .where(eq(integrationConnections.id, loaded.id))
        .returning();
      const heldBefore = offered.filter((a) => a.held).map((a) => a.accountId);
      return {
        value: row,
        touched: [
          {
            type: CONNECTION,
            id: row.id,
            change: 'updated',
            before: { ...connectionView(loaded), held: heldBefore },
            after: { ...connectionView(row), held: picked },
          },
        ],
      };
    },
    present: (row) => connectionView(row),
  };
}

const OWNER = {};
const asArgs = (args: Record<string, unknown> | null) => args as Id;

/** Each op once per process, so a parked one replays after its approval. */
export function registerIntegrationOps() {
  registerOp('integrations.endpoint.create', () => createEndpointOp(), OWNER);
  registerOp('integrations.endpoint.update', (a) => updateEndpointOp(asArgs(a)), OWNER);
  registerOp('integrations.endpoint.delete', (a) => deleteEndpointOp(asArgs(a)), OWNER);
  registerOp(
    'integrations.endpoint.rotate',
    (a) => rotateEndpointOp(asArgs(a), Number((a as { keepMs?: number } | null)?.keepMs ?? 0)),
    OWNER,
  );
  registerOp('integrations.connection.create', () => createConnectionOp(), OWNER);
  registerOp('integrations.connection.update', (a) => updateConnectionOp(asArgs(a)), OWNER);
  registerOp('integrations.connection.delete', (a) => deleteConnectionOp(asArgs(a)), OWNER);
  registerOp('integrations.connection.oauth_connect', () => oauthConnectOp(), OWNER);
  registerOp('integrations.connection.oauth_pick', (a) => oauthPickOp(asArgs(a)), OWNER);
  registerOp('integrations.delivery.retry', (a) => retryDeliveryOp(asArgs(a)), OWNER);
}
