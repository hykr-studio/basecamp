// The call log's writes: logging a call, dialling through the business's provider, changing a
// logged call, and a provider's own updates (for a B10 connector handler, as the system).

import type { TelephonyProvider } from '@hykr/connectors';
import {
  type CallInfo,
  CallsCapabilities,
  DialCallSpec,
  FrameworkCapabilities,
  LogCallSpec,
  PhoneNumber,
  type Principal,
  storableDateTime,
  UpdateCallSpec,
} from '@hykr/contracts';
import {
  allow,
  type Conn,
  defineCommand,
  deny,
  entityDef,
  type NamedEvent,
  needsApproval,
  projectRead,
  registerOp,
  type WriteOp,
} from '@hykr/core';
import { callLogs, integrationConnections } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { telephonyProviders } from './registry.js';

export type CallRow = typeof callLogs.$inferSelect;

/** A stored event about a call: its ids and status only. */
export class CallEvent implements NamedEvent {
  readonly resourceType = 'call';
  constructor(
    readonly eventName: string,
    readonly row: {
      id: string;
      tenantId: string;
      status: string;
      entity: string | null;
      recordId: string | null;
    },
  ) {}
}

const eventOf = (name: string, r: CallRow) =>
  new CallEvent(name, {
    id: r.id,
    tenantId: r.tenantId,
    status: r.status,
    entity: r.resourceType,
    recordId: r.resourceId,
  });

export const callInfoOf = (r: CallRow): CallInfo => ({
  id: r.id,
  direction: r.direction as CallInfo['direction'],
  status: r.status as CallInfo['status'],
  from: r.fromNumber,
  to: r.toNumber,
  userId: r.userId,
  about: r.resourceType && r.resourceId ? { entity: r.resourceType, id: r.resourceId } : null,
  provider: r.provider,
  startedAt: r.startedAt?.toISOString() ?? null,
  endedAt: r.endedAt?.toISOString() ?? null,
  durationS: r.durationS,
  notes: r.notes,
  error: r.error,
  createdBy: r.createdBy as CallInfo['createdBy'],
  createdAt: r.createdAt.toISOString(),
});

/** A call as it leaves for this reader: the read projectors may hide more (type `call`). */
export const presentCall = (r: CallRow, p: Principal) =>
  projectRead('call', callInfoOf(r) as unknown as Record<string, unknown>, p);

const notFound = (what: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${what}` });

/** The record a call is about, reached as the person: an entity's name and id, or 404. */
export async function aboutOf(
  conn: Conn,
  p: Principal,
  entity: string | undefined,
  id: string | undefined,
): Promise<{ entity: string; id: string } | null> {
  if (!entity && !id) return null;
  const def = entity ? entityDef(entity) : undefined;
  if (!def || !id) throw notFound('record');
  if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') throw notFound(def.spec.label);
  if (!(await def.repo.find(conn, p, id))) throw notFound(def.spec.label);
  return { entity: def.name, id };
}

/**
 * Whether this reader reaches the call: through its record, when it has one; otherwise its
 * own (logged by them or with them on it) or every one with `calls.read_all`.
 */
export async function reaches(conn: Conn, p: Principal, r: CallRow): Promise<boolean> {
  if (r.tenantId !== p.tenantId) return false;
  if (r.resourceType && r.resourceId) {
    const def = entityDef(r.resourceType);
    if (!def) return false;
    if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') return false;
    return !!(await def.repo.find(conn, p, r.resourceId));
  }
  const s = subjectOf(p);
  const mine = s?.kind === 'user' && (r.loggedBy === s.userId || r.userId === s.userId);
  return mine || can(p, CallsCapabilities.readAll);
}

/** The call, if this reader reaches it; else 404. */
export async function reachableCall(conn: Conn, p: Principal, id: string): Promise<CallRow> {
  const [row] = await conn
    .select()
    .from(callLogs)
    .where(and(eq(callLogs.id, id), eq(callLogs.tenantId, p.tenantId ?? '')));
  if (!row || !(await reaches(conn, p, row))) throw notFound('call');
  return row;
}

const memberOf = (p: Principal) => {
  const s = subjectOf(p);
  return s?.kind === 'user' ? s.userId : null;
};

const dateOrNull = (v: string | undefined) => (v ? new Date(v) : null);

/* ── call.log ─────────────────────────────────────────────────────────────── */

export const LogCall = defineCommand(LogCallSpec, {
  resource: { type: 'call', id: () => null },
  load: async (tx, p, input) => ({ about: await aboutOf(tx, p, input.entity, input.id) }),
  authorize: (p) =>
    memberOf(p)
      ? allow('log_call', 'Members log their calls')
      : deny('members_log_calls', 'Only members of the business log calls'),
  summarize: (input) => `Log a call (${input.direction}, ${input.status})`,
  run: async ({ tx, principal: p, input, loaded }) => {
    const userId = memberOf(p);
    const [row] = await tx
      .insert(callLogs)
      .values({
        tenantId: p.tenantId as string,
        direction: input.direction,
        status: input.status,
        fromNumber: input.from ?? null,
        toNumber: input.to ?? null,
        userId,
        resourceType: loaded.about?.entity ?? null,
        resourceId: loaded.about?.id ?? null,
        startedAt: dateOrNull(input.startedAt),
        endedAt: dateOrNull(input.endedAt),
        durationS: input.durationS ?? null,
        notes: input.notes ?? null,
        createdBy: p.actor.kind === 'agent' ? 'assistant' : 'person',
        loggedBy: userId,
      })
      .returning();
    return {
      value: row,
      touched: [{ type: 'call', id: row.id, change: 'created', after: callInfoOf(row) }],
      events: [eventOf('call.logged', row)],
    };
  },
  present: (row: CallRow, p) => presentCall(row, p),
});

/* ── call.dial ────────────────────────────────────────────────────────────── */

/** The first provider this business can use: one without credentials, or with a connection. */
export async function providerFor(
  conn: Conn,
  tenantId: string,
  // biome-ignore lint/suspicious/noExplicitAny: each provider has its own credentials
): Promise<{ provider: TelephonyProvider<any>; connectionId: string | null } | null> {
  for (const provider of telephonyProviders.all()) {
    if (!provider.connector) return { provider, connectionId: null };
    const [c] = await conn
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.tenantId, tenantId),
          eq(integrationConnections.connector, provider.connector),
          eq(integrationConnections.status, 'active'),
        ),
      )
      .limit(1);
    if (c) return { provider, connectionId: c.id };
  }
  return null;
}

export const DialCall = defineCommand(DialCallSpec, {
  resource: { type: 'call', id: () => null },
  load: async (tx, p, input) => ({
    about: await aboutOf(tx, p, input.entity, input.id),
    provider: await providerFor(tx, p.tenantId ?? ''),
  }),
  authorize: (p, { provider }) => {
    if (!memberOf(p)) return deny('members_call', 'Only members of the business make calls');
    if (!provider)
      return deny(
        'no_telephony_provider',
        'This business has no telephony provider to call through',
      );
    if (!can(p, FrameworkCapabilities.messageCustomers))
      return deny('cannot_call', 'Only the business calls people');
    if (p.actor.kind === 'agent')
      return needsApproval('agent_dials', 'Calls the assistant makes need approval');
    return allow('person_calls', 'The business calls through its provider');
  },
  summarize: (input) => `Call ${input.to}`,
  run: async ({ tx, principal: p, input, loaded }) => {
    const userId = memberOf(p);
    const [row] = await tx
      .insert(callLogs)
      .values({
        tenantId: p.tenantId as string,
        direction: 'outbound',
        status: 'requested',
        fromNumber: input.from ?? null,
        toNumber: input.to,
        userId,
        resourceType: loaded.about?.entity ?? null,
        resourceId: loaded.about?.id ?? null,
        provider: loaded.provider?.provider.name ?? null,
        createdBy: p.actor.kind === 'agent' ? 'assistant' : 'person',
        loggedBy: userId,
      })
      .returning();
    return {
      value: row,
      touched: [{ type: 'call', id: row.id, change: 'created', after: callInfoOf(row) }],
      // The worker asks the provider (calls.dial), once this write has committed.
      events: [eventOf('call.requested', row)],
    };
  },
  present: (row: CallRow, p) => presentCall(row, p),
});

/* ── call.update ──────────────────────────────────────────────────────────── */

export const UpdateCall = defineCommand(UpdateCallSpec, {
  resource: { type: 'call', id: (input) => input.callId },
  load: async (tx, p, input) => ({ call: await reachableCall(tx, p, input.callId) }),
  authorize: (p, { call }) => {
    const me = memberOf(p);
    return me && (call.loggedBy === me || call.userId === me)
      ? allow('own_call', 'Whoever logged a call, or was on it, may change it')
      : deny('not_your_call', 'Only whoever logged this call, or was on it, may change it');
  },
  summarize: (_input, { call }) => `Change the call ${call.id}`,
  run: async ({ tx, input, loaded }) => {
    const [row] = await tx
      .update(callLogs)
      .set({
        ...(input.status ? { status: input.status } : {}),
        ...(input.endedAt ? { endedAt: new Date(input.endedAt) } : {}),
        ...(input.durationS !== undefined ? { durationS: input.durationS } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(callLogs.id, loaded.call.id))
      .returning();
    return {
      value: row,
      touched: [
        {
          type: 'call',
          id: row.id,
          change: 'updated',
          before: callInfoOf(loaded.call),
          after: callInfoOf(row),
        },
      ],
      events: [eventOf('call.updated', row)],
    };
  },
  present: (row: CallRow, p) => presentCall(row, p),
});

/* ── A provider's updates ─────────────────────────────────────────────────── */

const Status = z.enum([
  'requested',
  'ringing',
  'in_progress',
  'completed',
  'missed',
  'failed',
  'cancelled',
]);
// A provider's time Postgres can store, as the calls' own inputs take (V10).
const at = storableDateTime({ offset: true });

export const ProviderUpdateInput = z.strictObject({
  provider: z.string().min(1).max(40),
  /** The provider's id for the call. */
  externalId: z.string().min(1).max(200),
  /** The call log's id, when the provider sends back what `dial` gave it. */
  callId: z.uuid().optional(),
  status: Status.optional(),
  /** For a call the business did not start (someone called in): a new log. */
  direction: z.enum(['inbound', 'outbound']).optional(),
  from: PhoneNumber.optional(),
  to: PhoneNumber.optional(),
  startedAt: at.optional(),
  endedAt: at.optional(),
  durationS: z.number().int().min(0).max(86_400).optional(),
});
export type ProviderUpdate = z.infer<typeof ProviderUpdateInput>;

/**
 * call.provider_update: what a telephony provider reports, written by a connector handler as the
 * business's system principal (`ctx.write(callProviderUpdate(), { provider, externalId, … })`).
 * The call is found by the provider's id (or the call log's id it was given); a call it reports
 * that nobody started is logged new when it says its `direction`.
 */
export function callProviderUpdate(): WriteOp<ProviderUpdate, CallRow | undefined, CallRow> {
  return {
    name: 'call.provider_update',
    kind: 'command',
    resourceType: 'call',
    resourceId: (_input, loaded) => loaded?.id ?? null,
    input: ProviderUpdateInput,
    load: async (tx, p, input) => {
      const tenantId = p.tenantId ?? '';
      const [byExternal] = await tx
        .select()
        .from(callLogs)
        .where(
          and(
            eq(callLogs.tenantId, tenantId),
            eq(callLogs.provider, input.provider),
            eq(callLogs.externalId, input.externalId),
          ),
        );
      if (byExternal || !input.callId) return byExternal;
      const [byId] = await tx
        .select()
        .from(callLogs)
        .where(
          and(
            eq(callLogs.tenantId, tenantId),
            eq(callLogs.id, input.callId),
            eq(callLogs.provider, input.provider),
          ),
        );
      return byId;
    },
    authorize: (p, loaded, input) => {
      if (p.actor.kind !== 'system')
        return deny(
          'provider_only',
          "Only a provider's updates, handled by the server, write this",
        );
      if (!loaded && !input.direction)
        return deny('unknown_call', 'The provider names a call nobody started');
      return allow('provider_reports', 'A telephony provider reports its calls');
    },
    summarize: (input) =>
      `${input.provider} reports call ${input.externalId}: ${input.status ?? 'update'}`,
    run: async ({ tx, principal: p, input, loaded }) => {
      const set = {
        externalId: input.externalId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.from ? { fromNumber: input.from } : {}),
        ...(input.to ? { toNumber: input.to } : {}),
        ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
        ...(input.endedAt ? { endedAt: new Date(input.endedAt) } : {}),
        ...(input.durationS !== undefined ? { durationS: input.durationS } : {}),
        updatedAt: new Date(),
      };
      const [row] = loaded
        ? await tx.update(callLogs).set(set).where(eq(callLogs.id, loaded.id)).returning()
        : await tx
            .insert(callLogs)
            .values({
              tenantId: p.tenantId as string,
              direction: input.direction as string,
              status: input.status ?? 'ringing',
              provider: input.provider,
              createdBy: 'system',
              ...set,
            })
            .returning();
      return {
        value: row,
        touched: [
          {
            type: 'call',
            id: row.id,
            change: loaded ? 'updated' : 'created',
            ...(loaded ? { before: callInfoOf(loaded) } : {}),
            after: callInfoOf(row),
          },
        ],
        events: [eventOf(loaded ? 'call.updated' : 'call.logged', row)],
      };
    },
    present: (row) => callInfoOf(row),
  };
}

/* ── A dial's outcome ─────────────────────────────────────────────────────── */

export const DialOutcomeInput = z.strictObject({
  callId: z.uuid(),
  /**
   * started: the worker takes a requested call to dial it (once); placed: the provider took
   * it; failed: it could not be placed.
   */
  step: z.enum(['started', 'placed', 'failed']),
  /** placed: the provider's id for the call, and where it is now. */
  externalId: z.string().min(1).max(200).optional(),
  status: Status.optional(),
  /** failed: why. */
  error: z.string().min(1).max(500).optional(),
});
export type DialOutcome = z.infer<typeof DialOutcomeInput>;

const OPEN = ['requested', 'ringing'];

/**
 * call.dial_outcome: what became of a dial, written by the worker as the business's system
 * principal, so the call's history shows it was placed (or why not) and `call.updated` is
 * stored with it. `started` takes a requested call once: any other status is refused, so a call
 * is never dialled twice. A provider's update that came first is never undone.
 */
export function callDialOutcome(): WriteOp<DialOutcome, CallRow, CallRow> {
  return {
    name: 'call.dial_outcome',
    kind: 'command',
    // The framework's own bookkeeping of a dial the person asked for: no level parks it.
    system: true,
    resourceType: 'call',
    resourceId: (input) => input.callId,
    input: DialOutcomeInput,
    load: async (tx, p, input) => {
      const [row] = await tx
        .select()
        .from(callLogs)
        .where(and(eq(callLogs.id, input.callId), eq(callLogs.tenantId, p.tenantId ?? '')))
        .for('update');
      if (!row) throw notFound('call');
      return row;
    },
    authorize: (p, call, input) => {
      if (p.actor.kind !== 'system')
        return deny('dialler_only', 'Only the server records how a dial went');
      if (input.step === 'started' && call.status !== 'requested')
        return deny('not_requested', 'This call is not waiting to be dialled');
      return allow('dial_outcome', 'The server records how the dial it was asked for went');
    },
    summarize: (input) => `Dial ${input.step}: call ${input.callId}`,
    run: async ({ tx, input, loaded: call }) => {
      const set =
        input.step === 'started'
          ? { status: 'ringing' }
          : input.step === 'placed'
            ? {
                ...(input.externalId ? { externalId: input.externalId } : {}),
                startedAt: call.startedAt ?? new Date(),
                ...(call.status === 'ringing' ? { status: input.status ?? 'ringing' } : {}),
              }
            : {
                error: input.error ?? 'The call could not be placed',
                ...(OPEN.includes(call.status) ? { status: 'failed' } : {}),
              };
      const [row] = await tx
        .update(callLogs)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(callLogs.id, call.id))
        .returning();
      return {
        value: row,
        touched: [
          {
            type: 'call',
            id: row.id,
            change: 'updated',
            before: callInfoOf(call),
            after: callInfoOf(row),
          },
        ],
        events: [eventOf('call.updated', row)],
      };
    },
    present: (row) => callInfoOf(row),
  };
}

const CALL_OPS = {};

/** Registered once, so a parked provider update (a write hook may park one) replays. */
export function registerCallOps() {
  registerOp('call.provider_update', () => callProviderUpdate(), CALL_OPS);
  registerOp('call.dial_outcome', () => callDialOutcome(), CALL_OPS);
}
