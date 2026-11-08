// The data principal service (B18): carries out a privacy request (an export archive, or an
// erasure in one transaction), marks requests past their deadline, runs the retention rules and
// answers the register. Every change it makes is a write through runWrite as the system
// principal, audited, with its events stored. docs/decisions/B18.md.
import { randomUUID } from 'node:crypto';
import {
  OPEN_PRIVACY_STATUSES,
  PRIVACY_REQUEST,
  type Principal,
  PrivacyManageCapability,
  type PrivacyManifest,
  type PrivacyRegister,
  type Subject,
} from '@hykr/contracts';
import {
  allow,
  auditCtx,
  CORE_OPTIONS,
  type CoreOptions,
  eventQueues,
  runWrite,
  settingsIn,
  systemPrincipal,
  type Tx,
  tenantOf,
  type WriteOp,
} from '@hykr/core';
import {
  contacts,
  type Database,
  files,
  memberships,
  privacyRequests,
  tenants,
  user,
  writeAudit,
} from '@hykr/db';
import { type Lang, pick } from '@hykr/i18n';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ErasedContact, PrivacyIntake } from '../../channels/maintenance/erasure.js';
import type { Jobs, ServerContext } from '../../hooks.js';
import {
  type ContributorsErasure,
  eraseWithContributors,
  exportPersonalData,
} from '../../privacy/contributors.js';
import { JOBS } from '../../queues/define.js';
import { runtime } from '../../runtime.js';
import { jsonOf } from '../export/csv.js';
import { ZipWriter } from '../export/zip.js';
import { FilesService } from '../files/files.service.js';
import { eraseFilesOn } from '../files/privacy.js';
import { grievanceContactOf } from './contact.js';
import { deleteContacts, eraseFramework, exportFramework, forgetAccount } from './framework.js';
import { eraseMastra, exportMastra, runsOf } from './mastra.js';
import {
  eraseRecords,
  exportRecords,
  personalEntities,
  personalEntityProblems,
  recordTargets,
} from './records.js';
import { type FiledAbout, redactCopies, redactFilings } from './redact.js';
import {
  personalDataParts,
  privacyPolicy,
  processors,
  type RetentionTarget,
  registryProblems,
  retentionPeriods,
  retentionTargets,
} from './registry.js';
import {
  dueFrom,
  effectivePolicy,
  eventRow,
  PrivacyEvent,
  type RequestRow,
  requestOut,
} from './requests.js';
import { type Identities, identitiesOf, subjectOfRow } from './subject.js';

const log = new Logger('Privacy');
type Values = Record<string, unknown>;

/** The field an export archive is kept in, on its request. */
export const ARCHIVE_FIELD = 'archive';

/** The run found the request no longer in progress (another run finished it): nothing to do. */
class NotRunning extends Error {}
/** A retention target had nothing due: the run is rolled back, so nothing is audited. */
class NothingDue extends Error {}

/** What running a request did. */
export interface RunOutcome {
  status: RequestRow['status'] | 'missing';
  /** This run carried it out (not another one before it). */
  performed: boolean;
  /** A WhatsApp contact that was forgotten: tell them it is done. */
  confirm?: ErasedContact;
}

/** The email and numbers a person's privacy filings may name them by, before they go. */
async function filedAbout(tx: Tx, ids: Identities): Promise<Omit<FiledAbout, 'requestIds'>> {
  const account = ids.userId
    ? await tx.select({ email: user.email }).from(user).where(eq(user.id, ids.userId))
    : [];
  const theirs = ids.contactIds.length
    ? await tx
        .select({ id: contacts.id, address: contacts.address })
        .from(contacts)
        .where(inArray(contacts.id, ids.contactIds))
    : [];
  return {
    userId: ids.userId,
    emails: account.map((a) => a.email.trim().toLowerCase()),
    contacts: theirs.map((c) => ({ id: c.id, address: c.address.replace(/^\+/, '') })),
  };
}

/** Every subject a person's data is filed under here: the account, then each contact. */
const subjectsOf = (ids: Identities): Subject[] => [
  ...(ids.userId ? [{ kind: 'user' as const, userId: ids.userId }] : []),
  ...ids.contactIds.map((contactId) => ({ kind: 'contact' as const, contactId })),
];

@Injectable()
export class PrivacyService implements PrivacyIntake, OnApplicationBootstrap {
  private readonly db: Database;
  constructor(
    @Inject(CORE_OPTIONS) options: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly ref: ModuleRef,
  ) {
    this.db = options.db;
  }

  /** A trait, a target or a period that does not hold together stops the start. */
  onApplicationBootstrap() {
    const problems = [...registryProblems(), ...personalEntityProblems()];
    const names = new Set(retentionTargets.all().map((t) => t.name));
    for (const t of recordTargets())
      if (names.has(t.name))
        problems.push(`The retention rule "${t.name}" is also a retention target's name`);
    if (problems.length) throw new Error(`Personal data:\n- ${problems.join('\n- ')}`);
  }

  private files(): FilesService {
    return this.ref.get(FilesService, { strict: false });
  }

  /**
   * One write of the privacy feature's own, as the system principal of the business: audited
   * (the operation's row, plus what `run` writes), its events stored and then published.
   */
  private async systemWrite<V>(a: {
    tenantId: string;
    name: string;
    resourceType: string;
    resourceId: string;
    summary: string;
    run: (tx: Tx, p: Principal) => Promise<{ value: V; events?: object[] }>;
  }): Promise<V> {
    const principal = systemPrincipal({
      tenantId: a.tenantId,
      job: a.name,
      capabilities: [PrivacyManageCapability],
    });
    let value: V | undefined;
    const op: WriteOp<Record<string, never>, undefined, V> = {
      name: a.name,
      kind: 'command',
      resourceType: a.resourceType,
      resourceId: () => a.resourceId,
      input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
      authorize: () => allow('privacy_system', 'The privacy feature carries out its own work'),
      summarize: () => a.summary,
      system: true,
      run: async ({ tx, principal: p }) => {
        const out = await a.run(tx, p);
        value = out.value;
        return { value: out.value, touched: [], events: out.events ?? [] };
      },
      present: () => null,
    };
    const { events } = await runWrite(
      this.db,
      { principal, requestId: `${a.name}:${randomUUID()}` },
      op,
      {},
    );
    for (const e of events) this.events.publish(e);
    return value as V;
  }

  /* ── Requests ──────────────────────────────────────────────────────────── */

  /** "Delete my data" on WhatsApp: file the contact's erasure, and carry it out unless reviewed. */
  async eraseContact(a: {
    tenantId: string;
    contactId: string;
  }): Promise<{ status: 'completed' | 'waiting' | 'gone' }> {
    const subject: Subject = { kind: 'contact', contactId: a.contactId };
    if (!(await identitiesOf(this.db, a.tenantId, subject))) return { status: 'gone' };
    const [open] = await this.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.tenantId, a.tenantId),
          eq(privacyRequests.kind, 'erase'),
          eq(privacyRequests.subjectKind, 'contact'),
          eq(privacyRequests.subjectId, a.contactId),
          inArray(privacyRequests.status, [...OPEN_PRIVACY_STATUSES]),
        ),
      )
      .limit(1);
    const id = randomUUID();
    const row =
      open ??
      (await this.systemWrite<RequestRow>({
        tenantId: a.tenantId,
        name: 'privacy.request',
        resourceType: PRIVACY_REQUEST,
        resourceId: id,
        summary: "Erase a person's personal data",
        run: async (tx, p) => {
          const policy = effectivePolicy(await settingsIn(tx, a.tenantId));
          const waits = policy.review.includes('erase');
          const now = new Date();
          const [created] = await tx
            .insert(privacyRequests)
            .values({
              id,
              tenantId: a.tenantId,
              kind: 'erase',
              status: waits ? 'received' : 'in_progress',
              subjectKind: 'contact',
              subjectId: a.contactId,
              intake: 'whatsapp',
              requestedByKind: 'contact',
              requestedById: a.contactId,
              receivedAt: now,
              dueAt: dueFrom(now, policy.respondWithinDays),
              startedAt: waits ? null : now,
              queues: eventQueues(),
            })
            .returning();
          await writeAudit(tx, {
            ...auditCtx(
              p,
              { rule: 'privacy_own_request', reason: 'The person asked on WhatsApp' },
              { principal: p, requestId: '' },
            ),
            requestId: null,
            actorKind: 'contact',
            actorId: a.contactId,
            channel: 'whatsapp',
            action: 'privacy.request',
            resourceType: PRIVACY_REQUEST,
            resourceId: created.id,
            after: { kind: 'erase', intake: 'whatsapp', status: created.status },
          });
          // Carried out right here, not on the queue: the channel confirms it when it is done.
          return {
            value: created,
            events: waits ? [new PrivacyEvent('privacy.request.received', eventRow(created))] : [],
          };
        },
      }));
    if (row.status === 'received') return { status: 'waiting' };
    const out = await this.run(row.id);
    return { status: out.status === 'completed' ? 'completed' : 'waiting' };
  }

  /**
   * Carry out a request in progress. A request another run finished, or that is not in
   * progress, is left as it is. `final`: the last try; a failure marks the request failed.
   */
  async run(requestId: string, opts: { final?: boolean } = {}): Promise<RunOutcome> {
    const [row] = await this.db
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId));
    if (!row) return { status: 'missing', performed: false };
    if (row.status !== 'in_progress') return { status: row.status, performed: false };
    try {
      return row.kind === 'export' ? await this.runExport(row) : await this.runErase(row);
    } catch (e) {
      if (e instanceof NotRunning) {
        const [now] = await this.db
          .select()
          .from(privacyRequests)
          .where(eq(privacyRequests.id, requestId));
        return { status: now?.status ?? 'missing', performed: false };
      }
      if (!opts.final) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      log.error(`privacy request ${requestId} failed: ${reason}`);
      await this.finish(row, 'failed', { reason: reason.slice(0, 500) });
      return { status: 'failed', performed: false };
    }
  }

  /** Lock the request and check it is still in progress, in the write's transaction. */
  private async lock(tx: Tx, id: string): Promise<RequestRow> {
    const [cur] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, id))
      .for('update');
    if (cur?.status !== 'in_progress') throw new NotRunning();
    return cur;
  }

  /** End a request in progress as failed (or anything else), audited, with its event. */
  private async finish(row: RequestRow, status: 'failed', a: { reason: string }) {
    await this.systemWrite({
      tenantId: row.tenantId,
      name: 'privacy.fail',
      resourceType: PRIVACY_REQUEST,
      resourceId: row.id,
      summary: 'A privacy request failed',
      run: async (tx) => {
        await this.lock(tx, row.id);
        const [done] = await tx
          .update(privacyRequests)
          .set({ status, reason: a.reason })
          .where(eq(privacyRequests.id, row.id))
          .returning();
        return {
          value: done,
          events: [new PrivacyEvent(`privacy.request.${status}`, eventRow(done))],
        };
      },
    }).catch((e) => {
      if (!(e instanceof NotRunning)) throw e;
    });
  }

  /** Everything the business holds about the person, by part, for their archive. */
  async collect(ids: Identities): Promise<Record<string, readonly unknown[]>> {
    const out: Record<string, readonly unknown[]> = {};
    for (const [name, rows] of Object.entries(await exportFramework(this.db, ids)))
      out[name] = rows;
    out['assistant-runs'] = await exportMastra(this.db, ids, await runsOf(this.db, ids));
    for (const [plural, rows] of Object.entries(await exportRecords(this.db, ids)))
      out[`records/${plural}`] = rows;
    for (const subject of subjectsOf(ids))
      for (const [kind, rows] of Object.entries(
        await exportPersonalData({ subject, tenantId: ids.tenantId, db: this.db }),
      )) {
        const key = `features/${kind}`;
        out[key] = [...(out[key] ?? []), ...rows];
      }
    const asked = await this.db
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.tenantId, ids.tenantId),
          eq(privacyRequests.subjectKind, ids.subject.kind),
          eq(privacyRequests.subjectId, subjectOfRowId(ids.subject)),
        ),
      )
      .orderBy(asc(privacyRequests.receivedAt));
    out['privacy-requests'] = asked.map((r) => {
      const { note: _note, files: _files, ...rest } = requestOut(r);
      return rest;
    });
    return out;
  }

  /** The archive of what the business holds about the person, kept on the request. */
  private async runExport(row: RequestRow): Promise<RunOutcome> {
    const ids = await identitiesOf(this.db, row.tenantId, subjectOfRow(row));
    if (!ids) {
      await this.finish(row, 'failed', { reason: 'The business no longer knows this person' });
      return { status: 'failed', performed: false };
    }
    const at = new Date();
    const parts = await this.collect(ids);
    const zip = new ZipWriter(at);
    const manifest: PrivacyManifest = {
      version: 1,
      tenantId: row.tenantId,
      subject: { kind: row.subjectKind, id: row.subjectId },
      exportedAt: at.toISOString(),
      parts: Object.entries(parts).map(([name, rows]) => ({ name, rows: rows.length })),
    };
    for (const [name, rows] of Object.entries(parts))
      zip.add(`${name}.json`, jsonOf(rows as Values[]));
    zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    let fileId: string;
    try {
      fileId = (
        await this.files().storeBytes({
          tenantId: row.tenantId,
          uploader: { kind: 'server' },
          source: 'server',
          name: `privacy-${at.toISOString().slice(0, 10)}.zip`,
          mime: 'application/zip',
          bytes: zip.finish(),
          audit: { actorKind: 'system', actorId: 'privacy.export', channel: 'background' },
        })
      ).id;
    } catch (e) {
      if (e instanceof HttpException && [413, 422].includes(e.getStatus())) {
        await this.finish(row, 'failed', {
          reason: 'The copy is larger than one file may be here',
        });
        return { status: 'failed', performed: false };
      }
      throw e;
    }
    try {
      await this.systemWrite({
        tenantId: row.tenantId,
        name: 'privacy.export',
        resourceType: PRIVACY_REQUEST,
        resourceId: row.id,
        summary: "Export a person's personal data",
        run: async (tx, p) => {
          await this.lock(tx, row.id);
          await tx
            .update(files)
            .set({
              resourceType: PRIVACY_REQUEST,
              resourceId: row.id,
              field: ARCHIVE_FIELD,
              attachedAt: at,
            })
            .where(
              and(eq(files.id, fileId), eq(files.tenantId, row.tenantId), isNull(files.resourceId)),
            );
          const [done] = await tx
            .update(privacyRequests)
            .set({
              status: 'completed',
              files: [fileId],
              outcome: { parts: Object.fromEntries(manifest.parts.map((x) => [x.name, x.rows])) },
              completedAt: new Date(),
            })
            .where(eq(privacyRequests.id, row.id))
            .returning();
          await writeAudit(tx, {
            ...auditCtx(
              p,
              { rule: 'privacy_system', reason: 'Exported' },
              { principal: p, requestId: '' },
            ),
            requestId: null,
            action: 'privacy.exported',
            resourceType: PRIVACY_REQUEST,
            resourceId: row.id,
            after: { parts: manifest.parts },
          });
          return {
            value: done,
            events: [new PrivacyEvent('privacy.request.completed', eventRow(done))],
          };
        },
      });
    } catch (e) {
      // Another run finished it: its archive is the one kept; this one goes.
      await this.db.transaction((tx) =>
        tx.update(files).set({ status: 'erased', name: 'erased' }).where(eq(files.id, fileId)),
      );
      throw e;
    }
    return { status: 'completed', performed: true };
  }

  /** Forget the person in this business, in one transaction. */
  private async runErase(row: RequestRow): Promise<RunOutcome> {
    let confirm: ErasedContact | undefined;
    // What contributors do outside the database, once the erasure has committed.
    const afterCommit: ContributorsErasure['afterCommit'] = [];
    await this.systemWrite({
      tenantId: row.tenantId,
      name: 'privacy.erase',
      resourceType: PRIVACY_REQUEST,
      resourceId: row.id,
      summary: "Erase a person's personal data",
      run: async (tx, p) => {
        await this.lock(tx, row.id);
        const tenantId = row.tenantId;
        const ids = await identitiesOf(tx, tenantId, subjectOfRow(row));
        let outcome: Values = { unknown: true };
        if (ids) {
          // A contact is told it is done (when they asked on WhatsApp): read before it goes.
          if (row.subjectKind === 'contact') {
            const [c] = await tx.select().from(contacts).where(eq(contacts.id, row.subjectId));
            if (c) confirm = { tenantId, address: c.address, locale: c.locale };
          }
          // The email and numbers filings may name them by: read before they go.
          const about = await filedAbout(tx, ids);
          const runs = await runsOf(tx, ids);
          const records = await eraseRecords(tx, ids);
          const features: Record<string, number> = {};
          const erased = [...records.erased];
          const kept: Record<string, { kept: number; keepReason: string }> = {};
          for (const subject of subjectsOf(ids)) {
            const done = await eraseWithContributors({ subject, tenantId, tx });
            for (const [name, n] of Object.entries(done.counts))
              features[name] = (features[name] ?? 0) + n;
            erased.push(...done.erased);
            for (const k of done.kept)
              kept[k.name] = {
                kept: (kept[k.name]?.kept ?? 0) + k.count,
                keepReason: k.keepReason,
              };
            afterCommit.push(...done.afterCommit);
          }
          const framework = await eraseFramework(tx, ids);
          framework.contacts = await deleteContacts(tx, ids);
          for (const contactId of ids.contactIds)
            await writeAudit(tx, {
              ...auditCtx(
                p,
                { rule: 'privacy_system', reason: 'The person asked to delete their data' },
                { principal: p, requestId: '' },
              ),
              requestId: null,
              action: 'channel.contact.erased',
              resourceType: 'contact',
              resourceId: contactId,
              after: { contributors: features },
            });
          // Mastra's memory is keyed across businesses: a person's goes only with their login.
          const elsewhere = ids.userId
            ? await tx
                .select({ t: memberships.tenantId })
                .from(memberships)
                .where(and(eq(memberships.userId, ids.userId), ne(memberships.tenantId, tenantId)))
                .limit(1)
            : [];
          const assistant = await eraseMastra(tx, ids, runs, elsewhere.length === 0);
          const redacted = await redactCopies(tx, tenantId, erased);
          // Their requests (as a person and as each contact) stay as the business's evidence,
          // without notes or archives.
          const earlier = await tx
            .update(privacyRequests)
            .set({ note: null, files: [] })
            .where(
              and(
                eq(privacyRequests.tenantId, tenantId),
                or(
                  ...subjectsOf(ids).map((s) =>
                    and(
                      eq(privacyRequests.subjectKind, s.kind),
                      eq(privacyRequests.subjectId, subjectOfRowId(s)),
                    ),
                  ),
                ),
              ),
            )
            .returning({ id: privacyRequests.id });
          await eraseFilesOn(tx, {
            tenantId,
            resourceType: PRIVACY_REQUEST,
            ids: earlier.map((r) => r.id),
          });
          // The filings about them: the approvals that held one, their audit rows, the replies.
          const filings = await redactFilings(tx, tenantId, {
            ...about,
            requestIds: [...new Set([row.id, ...earlier.map((r) => r.id)])],
          });
          redacted.approvals += filings.approvals;
          redacted.audit += filings.audit;
          redacted.replies += filings.replies;
          const account = ids.userId ? await forgetAccount(tx, ids.userId) : false;
          outcome = {
            records: records.outcome,
            features,
            kept,
            framework,
            assistant: { rows: assistant, runs: runs.length },
            redacted,
            account,
          };
        }
        const [done] = await tx
          .update(privacyRequests)
          .set({ status: 'completed', outcome, note: null, completedAt: new Date() })
          .where(eq(privacyRequests.id, row.id))
          .returning();
        await writeAudit(tx, {
          ...auditCtx(
            p,
            { rule: 'privacy_system', reason: 'Erased' },
            { principal: p, requestId: '' },
          ),
          requestId: null,
          action: 'privacy.erased',
          resourceType: PRIVACY_REQUEST,
          resourceId: row.id,
          after: outcome,
        });
        return {
          value: done,
          events: [new PrivacyEvent('privacy.request.completed', eventRow(done))],
        };
      },
    });
    // Looked up as used (not jobs.service.ts at import: it would read the configuration early).
    const ref = this.ref;
    const ctx: ServerContext = {
      get: (token) => ref.get(token, { strict: false }),
      db: this.db,
      get jobs() {
        return ref.get<Jobs>(JOBS, { strict: false });
      },
    };
    for (const after of afterCommit)
      await after(ctx).catch((e: unknown) =>
        log.warn(
          `after erasing for request ${row.id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    return { status: 'completed', performed: true, ...(confirm ? { confirm } : {}) };
  }

  /** After a queued run: a WhatsApp contact forgotten for a request they made there is told. */
  async afterRun(row: { intake: string }, out: RunOutcome) {
    if (!out.performed || !out.confirm || row.intake !== 'whatsapp') return;
    // Loaded here, not at import: the channel's module reads the configuration when it loads.
    const { ErasureService } = await import('../../channels/maintenance/erasure.service.js');
    const erasure = (() => {
      try {
        return this.ref.get(ErasureService, { strict: false });
      } catch {
        return undefined;
      }
    })();
    await erasure?.confirm(out.confirm);
  }

  /** Run a request from the queue (the `privacy.request.started` event). */
  async runQueued(requestId: string, final: boolean): Promise<RunOutcome> {
    const out = await this.run(requestId, { final });
    const [row] = await this.db
      .select({ intake: privacyRequests.intake })
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId));
    if (row) await this.afterRun(row, out);
    return out;
  }

  /* ── Deadlines ─────────────────────────────────────────────────────────── */

  /** Mark open requests past their deadline, once each: audited, `privacy.request.overdue`. */
  async sweepOverdue(now = new Date()): Promise<{ overdue: number }> {
    const due = await this.db
      .select({ id: privacyRequests.id, tenantId: privacyRequests.tenantId })
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.queues, eventQueues()),
          inArray(privacyRequests.status, [...OPEN_PRIVACY_STATUSES]),
          isNull(privacyRequests.overdueAt),
          lte(privacyRequests.dueAt, now),
        ),
      )
      .orderBy(asc(privacyRequests.dueAt))
      .limit(100);
    let overdue = 0;
    for (const { id, tenantId } of due) {
      const marked = await this.systemWrite<boolean>({
        tenantId,
        name: 'privacy.overdue',
        resourceType: PRIVACY_REQUEST,
        resourceId: id,
        summary: 'A privacy request is past its deadline',
        run: async (tx) => {
          const [row] = await tx
            .update(privacyRequests)
            .set({ overdueAt: now })
            .where(and(eq(privacyRequests.id, id), isNull(privacyRequests.overdueAt)))
            .returning();
          return row
            ? { value: true, events: [new PrivacyEvent('privacy.request.overdue', eventRow(row))] }
            : { value: false };
        },
      });
      if (marked) overdue++;
    }
    return { overdue };
  }

  /* ── Retention ─────────────────────────────────────────────────────────── */

  /** Every retention target: the framework's, the application's, and the entities' rules. */
  targets(): RetentionTarget[] {
    return [...retentionTargets.all(), ...recordTargets()];
  }

  /** A target's period as the application gives it. */
  private appDays(t: RetentionTarget): number | null {
    return retentionPeriods.get(t.name)?.days ?? t.days ?? null;
  }

  /** A target's period in a business: its settings, else the application's. */
  private daysIn(t: RetentionTarget, retention: Record<string, number | null>): number | null {
    if (t.scope === 'tenant' && Object.hasOwn(retention, t.name)) return retention[t.name] ?? null;
    return this.appDays(t);
  }

  /**
   * Apply every retention target with a period: deployment targets once (unless one business is
   * named), then each business's. Returns how many rows each target changed.
   */
  async runRetention(
    opts: { now?: Date; tenantId?: string } = {},
  ): Promise<Record<string, number>> {
    const now = opts.now ?? new Date();
    const done: Record<string, number> = {};
    const add = (name: string, n: number) => {
      if (n) done[name] = (done[name] ?? 0) + n;
    };
    const targets = this.targets();
    if (!opts.tenantId)
      for (const t of targets.filter((x) => x.scope === 'deployment')) {
        const days = this.appDays(t);
        if (!days) continue;
        const before = new Date(now.getTime() - days * 86_400_000);
        const n = await this.db.transaction(async (tx) => {
          const r = await t.apply({ before, tx });
          if (r.count)
            await writeAudit(tx, {
              action: 'privacy.retention',
              resourceType: 'deployment',
              resourceId: null,
              actorKind: 'system',
              actorId: 'privacy.retention',
              channel: 'background',
              tenantId: null,
              after: { target: t.name, days, before: before.toISOString(), count: r.count },
            });
          return r.count;
        });
        add(t.name, n);
      }
    const ids = opts.tenantId
      ? [opts.tenantId]
      : (await this.db.select({ id: tenants.id }).from(tenants)).map((r) => r.id);
    for (const tenantId of ids) {
      const settings = await settingsIn(this.db, tenantId);
      for (const t of targets.filter((x) => x.scope === 'tenant')) {
        const days = this.daysIn(t, settings.privacy.retention);
        if (!days) continue;
        const before = new Date(now.getTime() - days * 86_400_000);
        try {
          const n = await this.systemWrite<number>({
            tenantId,
            name: 'privacy.retention',
            resourceType: 'tenant',
            resourceId: tenantId,
            summary: `Apply the retention rule ${t.name}`,
            run: async (tx, p) => {
              const r = await t.apply({ tenantId, before, tx });
              if (!r.count) throw new NothingDue();
              const redacted = r.erased?.length ? await redactCopies(tx, tenantId, r.erased) : null;
              const after = {
                target: t.name,
                days,
                before: before.toISOString(),
                count: r.count,
                redacted,
              };
              await writeAudit(tx, {
                ...auditCtx(
                  p,
                  { rule: 'privacy_retention', reason: `Kept ${days} days` },
                  { principal: p, requestId: '' },
                ),
                requestId: null,
                action: 'privacy.retention.applied',
                resourceType: 'tenant',
                resourceId: tenantId,
                after,
              });
              return {
                value: r.count,
                events: [new RetentionApplied({ id: randomUUID(), tenantId, ...after })],
              };
            },
          });
          add(t.name, n);
        } catch (e) {
          if (!(e instanceof NothingDue)) throw e;
        }
      }
    }
    return done;
  }

  /* ── The register ──────────────────────────────────────────────────────── */

  /** Who holds personal data in p's business, what, for how long, and how requests are answered. */
  async register(p: Principal, lang: Lang): Promise<PrivacyRegister> {
    const tenantId = tenantOf(p);
    const settings = await settingsIn(this.db, tenantId);
    const [t] = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const policy = effectivePolicy(settings);
    const { catalog } = runtime();
    const words = privacyPolicy()?.keepReasons ?? {};
    const basisOf = (reason: string | null | undefined) =>
      reason && words[reason] ? pick(words[reason], lang) : null;
    return {
      fiduciary: {
        tenantId,
        name: t?.name ?? '',
        grievanceContact: grievanceContactOf(settings),
        privacyUrl: settings.privacyUrl ?? null,
      },
      requests: { respondWithinDays: policy.respondWithinDays, review: policy.review },
      processors: [
        ...processors.all().map((x) => ({
          name: x.name,
          purpose: pick(x.purpose, lang),
          data: [...(x.data ?? [])],
          location: x.location ?? null,
          url: x.url ?? null,
          source: 'application' as const,
        })),
        ...settings.privacy.processors.map((x) => ({
          name: x.name,
          purpose: x.purpose,
          data: x.data,
          location: x.location ?? null,
          url: x.url ?? null,
          source: 'business' as const,
        })),
      ],
      records: personalEntities().map(({ def, trait }) => ({
        entity: def.name,
        label: def.spec.label,
        module: catalog.moduleOf(def.name) ?? null,
        purpose: trait.purpose ? pick(trait.purpose, lang) : null,
        fields: trait.fields.map((f) => {
          const label = (
            def.spec.fieldLabels as Record<string, Parameters<typeof pick>[0]> | undefined
          )?.[f];
          return { name: f, label: label ? pick(label, lang) : f };
        }),
        erase: trait.erase,
        keepReason: trait.keepReason ?? null,
        keepBasis: basisOf(trait.keepReason),
        retention: trait.retention?.name ?? null,
      })),
      parts: personalDataParts.all().map((x) => ({
        name: x.name,
        label: pick(x.label, lang),
        fields: [...x.fields],
        erase: x.erase,
        keepReason: x.keepReason ?? null,
        keepBasis: basisOf(x.keepReason),
      })),
      retention: this.targets().map((x) => ({
        name: x.name,
        label: pick(x.label, lang),
        scope: x.scope,
        days: this.daysIn(x, settings.privacy.retention),
        defaultDays: this.appDays(x),
        action: x.action,
      })),
    };
  }
}

/** A subject's id, as a request stores it. */
const subjectOfRowId = (s: Subject) => (s.kind === 'user' ? s.userId : s.contactId);

/** privacy.retention.applied: a retention target ran in a business (counts, never data). */
class RetentionApplied {
  readonly eventName = 'privacy.retention.applied';
  readonly resourceType = 'tenant';
  constructor(readonly row: Record<string, unknown> & { tenantId: string }) {}
  get resourceId(): string {
    return this.row.tenantId;
  }
}
