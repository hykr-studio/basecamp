// Filing, processing and refusing privacy requests: writes like any other (validated,
// idempotent, authorized, audited, and open to the application's level rules), people only.
import { randomUUID } from 'node:crypto';
import {
  FilePrivacyRequestSpec,
  OPEN_PRIVACY_STATUSES,
  PRIVACY_REQUEST,
  PrivacyManageCapability,
  ProcessPrivacyRequestSpec,
  RefusePrivacyRequestSpec,
  type Subject,
} from '@hykr/contracts';
import { allow, defineCommand, deny, eventQueues, settingsIn, type Tx, tenantOf } from '@hykr/core';
import { privacyRequests, tenants } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  dueFrom,
  effectivePolicy,
  eventRow,
  PrivacyEvent,
  type RequestRow,
  reachesRequest,
  requestOut,
} from './requests.js';
import { identitiesOf, sameSubject, subjectFor } from './subject.js';

const notFound = () =>
  new NotFoundException({ error: 'not_found', message: 'No such privacy request' });

const noSuchPerson = () =>
  new NotFoundException({ error: 'no_such_person', message: 'The business does not know them' });

/** Is this person the business's default owner (who cannot be erased while they are)? */
async function isDefaultOwner(tx: Tx, tenantId: string, subject: Subject): Promise<boolean> {
  if (subject.kind !== 'user') return false;
  const [t] = await tx
    .select({ owner: tenants.defaultOwnerId })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return t?.owner === subject.userId;
}

/** The request of this business, locked, or 404 for anyone who does not reach it. */
async function loadRequest(
  tx: Tx,
  p: Parameters<typeof reachesRequest>[0],
  id: string,
): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(privacyRequests)
    .where(and(eq(privacyRequests.id, id), eq(privacyRequests.tenantId, tenantOf(p))))
    .for('update');
  if (!row || !reachesRequest(p, row)) throw notFound();
  return row;
}

const MAY_MANAGE = () =>
  deny('needs_privacy_manage', 'Only someone who handles privacy requests can do this');

interface Filing {
  id: string;
  tenantId: string;
  /** Asked for someone else without privacy.manage: refused before anything is looked up. */
  forOthers: boolean;
  subject?: Subject;
  self?: boolean;
  defaultOwner?: boolean;
}

/**
 * POST /api/privacy/requests: a person asks about their own data, or the privacy team files a
 * request they received for someone the business knows. A person's own request runs at once
 * unless the business reviews its kind; the team's runs at once.
 */
export const FilePrivacyRequest = defineCommand(FilePrivacyRequestSpec, {
  resource: { type: PRIVACY_REQUEST, id: (_input, loaded: Filing) => loaded.id },
  load: async (tx, p, input): Promise<Filing> => {
    const tenantId = tenantOf(p);
    const id = randomUUID();
    if (input.for && !can(p, PrivacyManageCapability)) return { id, tenantId, forOthers: true };
    const self = subjectOf(p);
    const subject = input.for ? await subjectFor(tx, tenantId, input.for) : self;
    if (!subject) throw noSuchPerson();
    if (!(await identitiesOf(tx, tenantId, subject))) throw noSuchPerson();
    const [open] = await tx
      .select({ id: privacyRequests.id })
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.tenantId, tenantId),
          eq(privacyRequests.kind, input.kind),
          eq(privacyRequests.subjectKind, subject.kind),
          eq(
            privacyRequests.subjectId,
            subject.kind === 'user' ? subject.userId : subject.contactId,
          ),
          inArray(privacyRequests.status, [...OPEN_PRIVACY_STATUSES]),
        ),
      )
      .limit(1);
    if (open)
      throw new ConflictException({
        error: 'request_open',
        message: 'A request of this kind for this person is still open',
        requestId: open.id,
      });
    return {
      id,
      tenantId,
      forOthers: false,
      subject,
      self: sameSubject(subject, self),
      defaultOwner: input.kind === 'erase' && (await isDefaultOwner(tx, tenantId, subject)),
    };
  },
  authorize: (p, loaded) => {
    if (p.actor.kind !== 'user') return deny('people_only', 'A person files privacy requests');
    if (loaded.forOthers) return MAY_MANAGE();
    if (loaded.defaultOwner)
      return deny(
        'default_owner',
        "The business's default owner cannot be erased: hand the business to someone else first",
      );
    return allow(loaded.self ? 'privacy_own_request' : 'privacy_manager');
  },
  summarize: (input) =>
    input.kind === 'erase' ? "Erase a person's personal data" : "Export a person's personal data",
  run: async ({ tx, principal: p, input, loaded }) => {
    const subject = loaded.subject as Subject;
    const policy = effectivePolicy(await settingsIn(tx, loaded.tenantId));
    // A person's own request may wait for review; the team's request is their review.
    const waits = !!loaded.self && policy.review.includes(input.kind);
    const now = new Date();
    const [row] = await tx
      .insert(privacyRequests)
      .values({
        id: loaded.id,
        tenantId: loaded.tenantId,
        kind: input.kind,
        status: waits ? 'received' : 'in_progress',
        subjectKind: subject.kind,
        subjectId: subject.kind === 'user' ? subject.userId : subject.contactId,
        intake: input.intake ?? (loaded.self ? 'app' : 'other'),
        requestedByKind: p.actor.kind,
        requestedById: p.actor.id,
        note: input.note ?? null,
        receivedAt: now,
        dueAt: dueFrom(now, policy.respondWithinDays),
        startedAt: waits ? null : now,
        queues: eventQueues(),
      })
      .returning();
    return {
      value: row,
      touched: [],
      events: [
        new PrivacyEvent(
          waits ? 'privacy.request.received' : 'privacy.request.started',
          eventRow(row),
        ),
      ],
    };
  },
  present: (row: RequestRow) => requestOut(row),
});

/** The request as `privacy.process` and `privacy.refuse` load it. */
interface Loaded {
  row: RequestRow;
  kind: RequestRow['kind'];
  defaultOwner: boolean;
}

const waiting = (row: RequestRow) => row.status === 'received' || row.status === 'failed';

/** POST /api/privacy/requests/:requestId/process: carry out a request that waits, or failed. */
export const ProcessPrivacyRequest = defineCommand(ProcessPrivacyRequestSpec, {
  resource: { type: PRIVACY_REQUEST, id: (input) => input.requestId },
  load: async (tx, p, input): Promise<Loaded> => {
    const row = await loadRequest(tx, p, input.requestId);
    const subject: Subject =
      row.subjectKind === 'user'
        ? { kind: 'user', userId: row.subjectId }
        : { kind: 'contact', contactId: row.subjectId };
    return {
      row,
      kind: row.kind,
      defaultOwner: row.kind === 'erase' && (await isDefaultOwner(tx, row.tenantId, subject)),
    };
  },
  authorize: (p, loaded) => {
    if (!can(p, PrivacyManageCapability)) return MAY_MANAGE();
    if (loaded.defaultOwner)
      return deny(
        'default_owner',
        "The business's default owner cannot be erased: hand the business to someone else first",
      );
    return allow('privacy_manager');
  },
  summarize: (_input, loaded) =>
    loaded.kind === 'erase'
      ? `Erase a person's personal data (request ${loaded.row.id.slice(0, 8)})`
      : `Export a person's personal data (request ${loaded.row.id.slice(0, 8)})`,
  run: async ({ tx, input }) => {
    // Loaded again: an approval's replay runs later, and the request may have moved on.
    const [now] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, input.requestId))
      .for('update');
    if (!now || !waiting(now))
      throw new ConflictException({
        error: 'not_waiting',
        message: 'This request is not waiting to be processed',
      });
    const [row] = await tx
      .update(privacyRequests)
      .set({ status: 'in_progress', startedAt: new Date(), reason: null, queues: eventQueues() })
      .where(eq(privacyRequests.id, now.id))
      .returning();
    return {
      value: row,
      touched: [],
      events: [new PrivacyEvent('privacy.request.started', eventRow(row))],
    };
  },
  present: (row: RequestRow) => requestOut(row),
});

/** POST /api/privacy/requests/:requestId/refuse: refuse a request that waits, saying why. */
export const RefusePrivacyRequest = defineCommand(RefusePrivacyRequestSpec, {
  resource: { type: PRIVACY_REQUEST, id: (input) => input.requestId },
  load: async (tx, p, input): Promise<Loaded> => {
    const row = await loadRequest(tx, p, input.requestId);
    return { row, kind: row.kind, defaultOwner: false };
  },
  authorize: (p) => (can(p, PrivacyManageCapability) ? allow('privacy_manager') : MAY_MANAGE()),
  summarize: (_input, loaded) => `Refuse privacy request ${loaded.row.id.slice(0, 8)}`,
  run: async ({ tx, input }) => {
    const [now] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, input.requestId))
      .for('update');
    if (!now || !waiting(now))
      throw new ConflictException({
        error: 'not_waiting',
        message: 'Only a request that waits, or failed, can be refused',
      });
    const [row] = await tx
      .update(privacyRequests)
      .set({ status: 'refused', reason: input.reason, completedAt: new Date() })
      .where(eq(privacyRequests.id, now.id))
      .returning();
    return {
      value: row,
      touched: [],
      events: [new PrivacyEvent('privacy.request.refused', eventRow(row))],
    };
  },
  present: (row: RequestRow) => requestOut(row),
});

/** Every privacy command. */
export const privacyCommands = [FilePrivacyRequest, ProcessPrivacyRequest, RefusePrivacyRequest];
