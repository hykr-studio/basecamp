// Filing, processing and refusing privacy requests, and the business's own privacy settings:
// writes like any other (validated, idempotent, authorized, audited, and open to the
// application's level rules), people only.
import { randomUUID } from 'node:crypto';
import {
  ConfigurePrivacySpec,
  drivenByAgent,
  FilePrivacyRequestSpec,
  OPEN_PRIVACY_STATUSES,
  PRIVACY_REQUEST,
  type PrivacyConfiguration,
  type PrivacyFor,
  PrivacyManageCapability,
  PrivacySettings,
  ProcessPrivacyRequestSpec,
  RefusePrivacyRequestSpec,
  type Subject,
  type TenantConfig,
  TenantSettings,
} from '@hykr/contracts';
import {
  allow,
  defineCommand,
  deny,
  eventQueues,
  settingsIn,
  type Tx,
  tenantOf,
  type WriteHook,
} from '@hykr/core';
import { approvals, privacyRequests, tenants } from '@hykr/db';
import { can, subjectOf } from '@hykr/policy';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { SettingsChanged } from '../settings/commands.js';
import { recordTargets } from './records.js';
import { retentionTargets } from './registry.js';
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

/**
 * A filing that waits for an approval names its person there by id, never by the email or the
 * WhatsApp number it was filed with: the approval keeps the filing to replay it, and the
 * approval's audit rows keep copies of it. The replay finds the same person by id.
 */
export const PrivacyFilingHook: WriteHook = {
  name: 'privacy.filing',
  async afterRun({ op, input, loaded, tx, result }) {
    if (op.name !== FilePrivacyRequestSpec.name || result.status !== 'needs_approval') return;
    const who = (input as { for?: PrivacyFor }).for;
    const subject = (loaded as Filing | undefined)?.subject;
    if (!who || !subject || 'userId' in who || 'contactId' in who) return;
    const byId =
      subject.kind === 'user' ? { userId: subject.userId } : { contactId: subject.contactId };
    await tx
      .update(approvals)
      .set({
        payload: sql`jsonb_set(${approvals.payload}, '{input,for}', ${JSON.stringify(byId)}::jsonb)`,
      })
      .where(eq(approvals.id, result.approval.id));
  },
};

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

/* ── The business's own privacy settings ─────────────────────────────────── */

type Values = Record<string, unknown>;
/** What `privacy.configure` loads: the business and its stored settings (locked). */
type Configuring = { tenantId: string; settings: Values };

/** The business's privacy setup as its team edits it, from its settings. */
export function configurationOf(
  settings: Pick<TenantConfig, 'privacy' | 'grievanceContact' | 'privacyUrl'>,
): PrivacyConfiguration {
  return {
    respondWithinDays: settings.privacy.respondWithinDays ?? null,
    review: [...settings.privacy.review],
    retention: { ...settings.privacy.retention },
    processors: [...settings.privacy.processors],
    grievanceContact: settings.grievanceContact,
    privacyUrl: settings.privacyUrl ?? null,
  };
}

/** The fiduciary's contact details, top-level settings keys: unset stays unset. */
const FIDUCIARY = ['grievanceContact', 'privacyUrl'] as const;

/**
 * What is wrong with a business's own periods and processors: a name no retention rule or
 * target has, one the business may not change (the deployment's), a processor listed twice.
 */
function settingsProblems(next: PrivacySettings): string[] {
  const problems: string[] = [];
  const scopes = new Map(
    [...retentionTargets.all(), ...recordTargets()].map((t) => [t.name, t.scope] as const),
  );
  for (const name of Object.keys(next.retention)) {
    const scope = scopes.get(name);
    if (!scope) problems.push(`"${name}" is not a retention rule or target`);
    else if (scope !== 'tenant')
      problems.push(`"${name}" is kept for the whole deployment: a business cannot change it`);
  }
  const seen = new Set<string>();
  for (const p of next.processors) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) problems.push(`The processor "${p.name}" is listed twice`);
    seen.add(key);
  }
  return problems;
}

/**
 * PATCH /api/privacy/settings: the business's deadline, the requests it reviews, its own
 * retention periods and processors, and its contact as the fiduciary. The business's row is
 * locked, only these keys change, the before and after are audited, and `settings.changed`
 * drops every cached copy.
 */
export const ConfigurePrivacy = defineCommand(ConfigurePrivacySpec, {
  resource: { type: 'tenant', id: (_input, loaded: Configuring) => loaded.tenantId },
  load: async (tx, p): Promise<Configuring> => {
    const tenantId = tenantOf(p);
    const [row] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('update');
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No business' });
    return { tenantId, settings: (row.settings as Values | null) ?? {} };
  },
  authorize: (p) => {
    if (p.actor.kind !== 'user' || drivenByAgent(p))
      return deny('people_only', 'A person changes the privacy settings');
    return can(p, PrivacyManageCapability) ? allow('privacy_manager') : MAY_MANAGE();
  },
  summarize: () => 'Change the privacy settings',
  run: async ({ tx, input, loaded: { tenantId, settings } }) => {
    // A section stored badly (by hand) is replaced, not kept: this is how it is mended.
    const stored = PrivacySettings.safeParse(settings.privacy);
    const before = stored.success ? stored.data : PrivacySettings.parse(undefined);
    const next: PrivacySettings = { ...before };
    if (input.respondWithinDays === null) delete next.respondWithinDays;
    else if (input.respondWithinDays !== undefined)
      next.respondWithinDays = input.respondWithinDays;
    if (input.review) next.review = [...new Set(input.review)].sort();
    if (input.retention) next.retention = input.retention;
    if (input.processors) next.processors = input.processors;
    const after = PrivacySettings.parse(next);
    const problems = settingsProblems(after);
    if (problems.length)
      throw new BadRequestException({
        error: 'privacy_settings_invalid',
        message: problems.join('; '),
        problems,
      });

    const fiduciaryBefore: Values = Object.fromEntries(
      FIDUCIARY.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]),
    );
    const fiduciaryAfter: Values = { ...fiduciaryBefore };
    const removed: string[] = [];
    for (const k of FIDUCIARY) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null) {
        delete fiduciaryAfter[k];
        removed.push(k);
      } else fiduciaryAfter[k] = v;
    }
    // Only these keys: every other section stays as it is.
    let value: SQL = sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{privacy}', ${JSON.stringify(after)}::jsonb)`;
    value = sql`(${value}) || ${JSON.stringify(fiduciaryAfter)}::jsonb`;
    for (const k of removed) value = sql`(${value}) - ${k}::text`;
    await tx.update(tenants).set({ settings: value }).where(eq(tenants.id, tenantId));

    const fiduciary = TenantSettings.pick({ grievanceContact: true, privacyUrl: true }).parse(
      fiduciaryAfter,
    );
    return {
      value: configurationOf({ privacy: after, ...fiduciary }),
      touched: [
        {
          type: 'tenant',
          id: tenantId,
          change: 'updated' as const,
          before: { privacy: before, ...fiduciaryBefore },
          after: { privacy: after, ...fiduciaryAfter },
        },
      ],
      events: [new SettingsChanged(tenantId, 'privacy')],
    };
  },
});

/** Every privacy command. */
export const privacyCommands = [
  FilePrivacyRequest,
  ProcessPrivacyRequest,
  RefusePrivacyRequest,
  ConfigurePrivacy,
];
