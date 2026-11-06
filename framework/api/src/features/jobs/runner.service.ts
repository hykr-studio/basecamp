import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  isJobFinished,
  type JobError,
  type JobInfo,
  JobUpdate,
  ListJobsQuery,
  type Principal,
} from '@hykr/contracts';
import {
  auditCtx,
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  recordEvents,
  runWrite,
  systemPrincipal,
  type Tx,
  toJson,
} from '@hykr/core';
import { type Database, files, jobs, jobUpdates, writeAudit } from '@hykr/db';
import { subjectKeyOf } from '@hykr/policy';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventBus } from '@nestjs/cqrs';
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Jobs } from '../../hooks.js';
import { JOBS } from '../../queues/define.js';
import { FilesService } from '../files/files.service.js';
import { assertJobsConfig, callbackSecret, callbackUrl, jobsConfig } from './config.js';
import {
  type CompleteContext,
  type JobContext,
  type JobDef,
  jobDefs,
  type SubmitContext,
  type SubmitResult,
} from './define.js';
import { fetchResult, ResultRefused } from './fetch.js';
import {
  infoOf,
  JOB,
  JobEvent,
  type JobRow,
  presentJob,
  RESULTS_FIELD,
  reachesJob,
  recordOf,
} from './info.js';
import { JOB_SIGNATURE_HEADER, verifyJobCallback } from './signature.js';
import { setJobsRuntime } from './start.js';

const log = new Logger('Jobs');

export const SUBMIT_QUEUE = 'jobs.submit';
export const APPLY_QUEUE = 'jobs.apply';
export const CANCEL_QUEUE = 'jobs.cancel';

/** A job's submission number n gets the BullMQ job id `submit--<job>--<n>`: added once. */
export const submitJobId = (jobId: string, attempt: number) => `submit--${jobId}--${attempt}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMIT_TIMEOUT_MS = 60_000;
const SUBMIT_ATTEMPTS = 3;
const SUBMIT_BACKOFF_MS = 5_000;
const POLL_EVERY_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_FILES = 20;
/** `complete` runs at most this many times. */
export const COMPLETE_ATTEMPTS = 5;

/** An error as one line, short enough for a job's error and the logs. */
const brief = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such job' });

const pollEvery = (def: JobDef | undefined) => def?.pollEveryMs ?? POLL_EVERY_MS;
const later = (ms: number) => new Date(Date.now() + ms);

/** A stored update without inline file data, once applied: the bytes are in the files now. */
function withoutData(body: unknown): unknown {
  const update = body as { files?: { data?: string }[] };
  if (!Array.isArray(update?.files)) return body;
  return {
    ...update,
    files: update.files.map(({ data, ...rest }) => (data === undefined ? rest : { ...rest })),
  };
}

/** What a callback answers: its status and body. */
export interface CallbackAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Long-running jobs, after `startJob`: submitting them, receiving and applying what their work
 * reports (callbacks, polls), deadlines, cancelling, writing results back (`complete`), and who
 * may read them. Every change of state is audited and stored as an event, in its transaction.
 */
@Injectable()
export class JobRunner implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  /** Read when used: the public address may be set after the process starts (tests). */
  get config() {
    return jobsConfig();
  }

  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(JOBS) private readonly queues: Jobs,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {
    assertJobsConfig(this.config);
    this.db = core.db;
  }

  onModuleInit() {
    setJobsRuntime({ filesReachable: (p, ids) => this.filesReachable(p, ids) });
  }

  onModuleDestroy() {
    setJobsRuntime(undefined);
  }

  /** Every kind's record is served, and nothing else is named `job`: a mistake stops the start. */
  onApplicationBootstrap() {
    const problems: string[] = [];
    if (entityDef(JOB))
      problems.push(`An entity is named "${JOB}", which is the jobs feature's resource type`);
    for (const def of jobDefs.all())
      if (def.about && !entityDef(def.about.entity))
        problems.push(`Job ${def.name} is about "${def.about.entity}", which no module serves`);
    if (problems.length) throw new Error(`Jobs are declared wrong:\n- ${problems.join('\n- ')}`);
  }

  private files(): FilesService {
    return this.ref.get(FilesService, { strict: false });
  }

  /** The server's own work on this job: actor `system`, the kind as its id, the job as its run. */
  private system(row: JobRow): Principal {
    return systemPrincipal({ tenantId: row.tenantId, job: row.kind, runId: row.id });
  }

  private audit(
    tx: Tx,
    p: Principal,
    action: string,
    row: JobRow,
    after: Record<string, unknown> = {},
    requestId?: string,
  ) {
    return writeAudit(tx, {
      ...auditCtx(
        p,
        { rule: 'jobs', reason: action },
        { principal: p, requestId: requestId ?? '' },
      ),
      requestId: requestId ?? null,
      action,
      resourceType: JOB,
      resourceId: row.id,
      after: { kind: row.kind, status: row.status, ...after },
    });
  }

  /** May p use every one of these files (startJob's input files)? */
  private async filesReachable(p: Principal, ids: readonly string[]): Promise<boolean> {
    const found = await this.files().getMany(p, ids);
    return ids.every((id) => found.some((f) => f.id === id));
  }

  /* ── Reading ─────────────────────────────────────────────────────────────── */

  /** A job p reaches, or 404. */
  async reachable(p: Principal, id: string): Promise<JobRow> {
    if (!UUID.test(id) || !p.tenantId) throw notFound();
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, p.tenantId)));
    if (!row || !(await reachesJob(this.db, p, row))) throw notFound();
    return row;
  }

  async get(p: Principal, id: string): Promise<JobInfo> {
    return presentJob(infoOf(await this.reachable(p, id)), p);
  }

  /**
   * A record's jobs (`entity` and `id`: p must reach the record), or else the jobs started for
   * p, that p still reaches. Newest first.
   */
  async list(p: Principal, raw: unknown): Promise<JobInfo[]> {
    const parsed = ListJobsQuery.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException({ error: 'bad_query', issues: parsed.error.issues });
    const q = parsed.data;
    if (!p.tenantId) return [];
    const where: SQL[] = [eq(jobs.tenantId, p.tenantId)];
    if (q.kind) where.push(eq(jobs.kind, q.kind));
    if (q.status) where.push(eq(jobs.status, q.status));
    const limit = q.limit ?? 50;
    if (q.entity !== undefined || q.id !== undefined) {
      if (!q.entity || !q.id)
        throw new BadRequestException({ error: 'bad_query', message: 'Give both entity and id' });
      const def = entityDef(q.entity);
      if (!def || (p.actor.kind === 'agent' && def.spec.expose.get !== 'all')) return [];
      if (!(await def.repo.find(this.db, p, q.id))) return [];
      where.push(eq(jobs.aboutType, def.name), eq(jobs.aboutId, q.id));
      const rows = await this.db
        .select()
        .from(jobs)
        .where(and(...where))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
      return rows.map((r) => presentJob(infoOf(r), p));
    }
    if (p.actor.kind !== 'system') {
      const key = subjectKeyOf(p);
      if (!key) return [];
      where.push(eq(jobs.startedFor, key));
    }
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.createdAt))
      .limit(limit);
    const out: JobInfo[] = [];
    for (const row of rows)
      if (await reachesJob(this.db, p, row)) out.push(presentJob(infoOf(row), p));
    return out;
  }

  /* ── Finishing ───────────────────────────────────────────────────────────── */

  /**
   * Fail or cancel an unfinished job, audited and with its event, in one transaction. Undefined
   * when it had finished already (the first finish wins).
   */
  private finish(
    id: string,
    status: 'failed' | 'cancelled',
    error: JobError,
    by: { action: string; principal?: Principal; requestId?: string },
  ): Promise<JobRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!current || isJobFinished(current.status)) return undefined;
      const [row] = await tx
        .update(jobs)
        .set({ status, error, finishedAt: new Date(), leaseUntil: null, nextPollAt: null })
        .where(eq(jobs.id, id))
        .returning();
      const p = by.principal ?? this.system(row);
      await this.audit(tx, p, by.action, row, { error }, by.requestId);
      await recordEvents(tx, {
        principal: p,
        requestId: by.requestId,
        events: [new JobEvent(status === 'failed' ? 'job.failed' : 'job.cancelled', infoOf(row))],
      });
      return row;
    });
  }

  /** Ask the service to stop this job, on the cancel queue (best effort, retried). */
  private async askToStop(row: JobRow) {
    if (!jobDefs.get(row.kind)?.cancel) return;
    await this.queues
      .add(CANCEL_QUEUE, { jobId: row.id }, { jobId: `cancel--${row.id}` })
      .catch((e) => log.warn(`could not ask to stop ${row.id}: ${brief(e)}`));
  }

  /**
   * People cancel a job they reach when it was started for them, or when they may change the
   * record it is about. A finished job: 409. The service is then asked to stop.
   */
  async cancel(p: Principal, id: string, requestId: string): Promise<JobInfo> {
    const row = await this.reachable(p, id);
    let may = row.startedFor !== null && row.startedFor === subjectKeyOf(p);
    if (!may && row.aboutType && row.aboutId) {
      const def = entityDef(row.aboutType);
      const record = def ? await def.repo.find(this.db, p, row.aboutId) : undefined;
      may = !!def && !!record && def.decide(p, 'update', record, {}).decision !== 'deny';
    }
    if (!may)
      throw new HttpException(
        {
          error: 'forbidden',
          rule: 'job_not_yours',
          reason: 'Only whoever it was started for, or who may change its record, can cancel it',
        },
        403,
      );
    const done = await this.finish(
      row.id,
      'cancelled',
      { code: 'cancelled', message: 'Cancelled before it finished' },
      { action: 'job.cancel', principal: p, requestId },
    );
    if (!done)
      throw new ConflictException({ error: 'already_finished', message: 'The job has finished' });
    await this.askToStop(done);
    return presentJob(infoOf(done), p);
  }

  /* ── The kind's functions ────────────────────────────────────────────────── */

  /** What a kind's function gets: the job, a time limit, its input files, providers. */
  private context<I>(
    row: JobRow,
    def: JobDef<I>,
    timeoutMs: number,
    o: { byDeadline: boolean } = { byDeadline: true },
  ): JobContext<I> {
    const left = row.deadlineAt.getTime() - Date.now();
    const ms = o.byDeadline ? Math.min(timeoutMs, left) : timeoutMs;
    const signal = AbortSignal.timeout(Math.max(1, ms));
    const allowed = new Set(def.inputFiles?.(row.input as I) ?? []);
    const inputFile = async (id: string) => {
      if (!allowed.has(id)) throw new Error(`${id} is not an input file of this job`);
      const [file] = await this.db
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.tenantId, row.tenantId), eq(files.status, 'ready')));
      if (!file) throw new Error(`The input file ${id} is gone`);
      return file;
    };
    return {
      job: recordOf<I>(row),
      signal,
      fileUrl: async (id) => this.files().urlFor(await inputFile(id)),
      fileBytes: async (id) => this.files().bytesOf(await inputFile(id)),
      get: (token) => this.ref.get(token, { strict: false }),
    };
  }

  /* ── Submitting ──────────────────────────────────────────────────────────── */

  /**
   * Hand a queued job to its service: leased (no two workers submit it), then `submit` outside
   * any transaction. A throw is retried with backoff, then fails the job (`submit_failed`).
   */
  async submit(jobId: string): Promise<string> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (row?.status !== 'queued' || row.submittedAt) return 'not queued';
    const def = jobDefs.get(row.kind);
    if (!def) {
      await this.finish(
        row.id,
        'failed',
        { code: 'unknown_kind', message: `This server has no job kind ${row.kind}` },
        { action: 'job.failed' },
      );
      return 'unknown kind';
    }
    const timeoutMs = Math.min(
      def.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS,
      row.deadlineAt.getTime() - Date.now(),
    );
    if (timeoutMs <= 0) return 'past its deadline';
    const [claimed] = await this.db
      .update(jobs)
      .set({ leaseUntil: later(timeoutMs + 5_000), attempts: sql`${jobs.attempts} + 1` })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'queued'),
          isNull(jobs.submittedAt),
          or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, sql`now()`)),
        ),
      )
      .returning();
    if (!claimed) return 'leased';

    const ctx: SubmitContext = {
      ...this.context(claimed, def, timeoutMs),
      callback:
        def.callback === false
          ? null
          : {
              url: callbackUrl(this.config.publicUrl, claimed.id),
              secret: callbackSecret(this.config.secret, claimed.id),
              header: JOB_SIGNATURE_HEADER,
            },
      progress: async (percent, message) => {
        await this.progress(claimed.id, percent, message);
      },
    };
    let result: SubmitResult | undefined;
    try {
      result = (await def.submit(ctx)) ?? undefined;
    } catch (e) {
      log.warn(`submit ${claimed.id} (${claimed.kind}) #${claimed.attempts}: ${brief(e)}`);
      if (claimed.attempts < (def.submitAttempts ?? SUBMIT_ATTEMPTS)) {
        await this.db.update(jobs).set({ leaseUntil: null }).where(eq(jobs.id, jobId));
        await this.queues.add(
          SUBMIT_QUEUE,
          { jobId },
          {
            jobId: submitJobId(jobId, claimed.attempts),
            delay: (def.submitBackoffMs ?? SUBMIT_BACKOFF_MS) * 2 ** (claimed.attempts - 1),
          },
        );
        return 'retrying';
      }
      await this.finish(
        jobId,
        'failed',
        { code: 'submit_failed', message: brief(e) },
        { action: 'job.failed' },
      );
      return 'failed';
    }

    const after = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
      if (!current) return undefined;
      const open = !isJobFinished(current.status);
      const first = open && !current.submittedAt;
      const [row] = await tx
        .update(jobs)
        .set({
          leaseUntil: null,
          externalId: result?.externalId ?? current.externalId,
          ...(first
            ? {
                status: 'running' as const,
                submittedAt: new Date(),
                nextPollAt: def.poll ? later(pollEvery(def)) : null,
              }
            : {}),
        })
        .where(eq(jobs.id, jobId))
        .returning();
      if (first) {
        const p = this.system(row);
        await this.audit(tx, p, 'job.submit', row, { attempt: row.attempts });
        // Progress reported while submitting has said it is running already.
        if (current.status === 'queued')
          await recordEvents(tx, {
            principal: p,
            events: [new JobEvent('job.running', infoOf(row))],
          });
      }
      return { row, open };
    });
    if (!after) return 'gone';
    // Cancelled or timed out while it was being handed over: the service is asked to stop.
    if (!after.open) {
      await this.askToStop(after.row);
      return 'finished meanwhile';
    }
    if (result?.update) {
      const update = JobUpdate.safeParse(result.update);
      if (!update.success) {
        await this.finish(
          jobId,
          'failed',
          { code: 'bad_update', message: 'The submission returned an update that does not parse' },
          { action: 'job.failed' },
        );
        return 'bad update';
      }
      await this.store(after.row, 'submit', 'submit', update.data);
    }
    return 'submitted';
  }

  /* ── Updates ─────────────────────────────────────────────────────────────── */

  /** Keep an update once (by its dedupe key) and queue it to be applied. Undefined: a repeat. */
  private async store(
    row: JobRow,
    source: 'callback' | 'poll' | 'submit',
    dedupe: string,
    update: JobUpdate,
  ): Promise<{ id: string } | undefined> {
    const [stored] = await this.db
      .insert(jobUpdates)
      .values({
        jobId: row.id,
        tenantId: row.tenantId,
        source,
        dedupe,
        status: update.status,
        body: update,
      })
      .onConflictDoNothing()
      .returning({ id: jobUpdates.id });
    if (stored)
      await this.queues.add(APPLY_QUEUE, { updateId: stored.id }, { jobId: `apply--${stored.id}` });
    return stored;
  }

  /**
   * A callback: the job exists and takes callbacks (404 otherwise), the post is signed with its
   * secret (401 otherwise), its body is an update (400 otherwise). Kept once: a repeat is 200
   * `duplicate`; one for a finished job is kept and changes nothing (200 `finished`); a new one
   * is queued (202).
   */
  async receive(
    id: string,
    req: { rawBody?: Buffer; headers: IncomingHttpHeaders; body: unknown },
  ): Promise<CallbackAnswer> {
    if (!UUID.test(id)) return { status: 404, body: { error: 'not_found' } };
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id));
    const def = row ? jobDefs.get(row.kind) : undefined;
    if (!row || !def || def.callback === false)
      return { status: 404, body: { error: 'not_found' } };
    const rawBody = req.rawBody;
    if (!rawBody) return { status: 401, body: { error: 'bad_signature' } };
    const options = def.callback ?? {};
    const secret = callbackSecret(this.config.secret, row.id);
    let genuine = false;
    try {
      genuine = options.verify
        ? options.verify({ rawBody, headers: req.headers }, { secret, job: recordOf(row) })
        : verifyJobCallback(secret, rawBody, req.headers[JOB_SIGNATURE_HEADER], {
            toleranceS: this.config.toleranceS,
          }).ok;
    } catch (e) {
      log.warn(`callback verify for ${row.id} threw: ${brief(e)}`);
    }
    if (!genuine) return { status: 401, body: { error: 'bad_signature' } };

    let raw: unknown;
    try {
      raw = options.parse ? options.parse(req.body, req.headers) : req.body;
    } catch (e) {
      return { status: 400, body: { error: 'bad_update', message: brief(e) } };
    }
    if (raw === null || raw === undefined)
      return { status: 200, body: { received: true, ignored: true } };
    const update = JobUpdate.safeParse(raw);
    if (!update.success)
      return { status: 400, body: { error: 'bad_update', issues: update.error.issues } };
    const dedupe =
      options.dedupe?.({ rawBody, headers: req.headers, body: req.body }) ??
      createHash('sha256').update(rawBody).digest('hex');

    if (isJobFinished(row.status)) {
      const [kept] = await this.db
        .insert(jobUpdates)
        .values({
          jobId: row.id,
          tenantId: row.tenantId,
          source: 'callback',
          dedupe,
          status: update.data.status,
          body: withoutData(update.data) as object,
          appliedAt: new Date(),
          outcome: 'ignored: finished',
        })
        .onConflictDoNothing()
        .returning({ id: jobUpdates.id });
      return {
        status: 200,
        body: { received: true, ...(kept ? { finished: true } : { duplicate: true }) },
      };
    }
    // Word from the service: the next poll can wait.
    if (def.poll && row.submittedAt)
      await this.db
        .update(jobs)
        .set({ nextPollAt: later(pollEvery(def)) })
        .where(and(eq(jobs.id, row.id), eq(jobs.status, 'running')));
    const stored = await this.store(row, 'callback', dedupe, update.data);
    if (!stored) return { status: 200, body: { received: true, duplicate: true } };
    return { status: 202, body: { received: true } };
  }

  /**
   * Apply a stored update (the `jobs.apply` queue). A transient failure (a download, the store)
   * is thrown for a retry; on the last try, or when the results can never be kept, a success
   * fails the job (`result_unavailable`).
   */
  async applyStored(updateId: string, last: boolean): Promise<string> {
    const [stored] = await this.db.select().from(jobUpdates).where(eq(jobUpdates.id, updateId));
    if (!stored || stored.appliedAt) return 'applied already';
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, stored.jobId));
    if (!row) return 'no job';
    let outcome: string;
    try {
      outcome = await this.apply(row, JobUpdate.parse(stored.body));
    } catch (e) {
      if (!(e instanceof ResultRefused) && !last) throw e;
      outcome = `failed: ${brief(e)}`;
      if (stored.status === 'succeeded')
        await this.finish(
          row.id,
          'failed',
          { code: 'result_unavailable', message: brief(e) },
          { action: 'job.failed' },
        );
    }
    await this.db
      .update(jobUpdates)
      .set({ appliedAt: new Date(), outcome, body: withoutData(stored.body) as object })
      .where(eq(jobUpdates.id, stored.id));
    return outcome;
  }

  /** Apply one update to a job. The first finishing update wins; later ones are ignored. */
  private async apply(row: JobRow, update: JobUpdate): Promise<string> {
    if (isJobFinished(row.status)) return 'ignored: finished';
    switch (update.status) {
      case 'running':
        return this.progress(row.id, update.progress, update.message);
      case 'failed':
        return (await this.finish(
          row.id,
          'failed',
          { code: update.error.code ?? 'failed', message: update.error.message },
          { action: 'job.failed' },
        ))
          ? 'applied'
          : 'ignored: finished';
      case 'cancelled':
        return (await this.finish(
          row.id,
          'cancelled',
          { code: 'cancelled', message: update.message ?? 'Cancelled by the service' },
          { action: 'job.cancelled' },
        ))
          ? 'applied'
          : 'ignored: finished';
      case 'succeeded':
        return this.succeed(row, update);
    }
  }

  /**
   * Progress: a higher percentage, a new message, or the first word that it runs. A lower
   * percentage (late, out of order) is ignored. An event for each change.
   */
  private progress(id: string, progress?: number, message?: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!current || isJobFinished(current.status)) return 'ignored: finished';
      const pct = progress === undefined ? null : Math.max(0, Math.min(100, Math.floor(progress)));
      const up = pct !== null && (current.progress === null || pct > current.progress);
      const said = message !== undefined && message !== current.message;
      const started = current.status === 'queued';
      if (!up && !said && !started)
        return pct !== null && current.progress !== null && pct < current.progress
          ? 'ignored: lower'
          : 'ignored: no change';
      const def = jobDefs.get(current.kind);
      const [row] = await tx
        .update(jobs)
        .set({
          status: 'running',
          ...(up ? { progress: pct } : {}),
          ...(said ? { message } : {}),
          ...(def?.poll && current.submittedAt ? { nextPollAt: later(pollEvery(def)) } : {}),
        })
        .where(eq(jobs.id, id))
        .returning();
      const info = infoOf(row);
      await recordEvents(tx, {
        principal: this.system(row),
        events: [
          ...(started ? [new JobEvent('job.running', info)] : []),
          ...(up || said ? [new JobEvent('job.progress', info)] : []),
        ],
      });
      return 'applied';
    });
  }

  /** A result file's bytes: inline, the kind's own download, or the guarded fetch. */
  private async bytesOf(
    row: JobRow,
    def: JobDef,
    file: { name: string; mime: string; data?: string; url?: string },
  ): Promise<Buffer> {
    if (file.data !== undefined) return Buffer.from(file.data, 'base64');
    const url = file.url as string;
    const ctx = this.context(row, def, CALL_TIMEOUT_MS, { byDeadline: false });
    if (def.download) return def.download({ name: file.name, mime: file.mime, url }, ctx);
    return fetchResult(url, {
      allowPrivate: this.config.allowPrivateUrls,
      maxBytes: this.files().config.maxBytes,
      timeoutMs: CALL_TIMEOUT_MS,
      signal: ctx.signal,
    });
  }

  /**
   * Success: the output is checked (`bad_output` fails it), the files are fetched and stored as
   * server files, then, in one transaction, the job succeeds and its files are kept on it.
   */
  private async succeed(row: JobRow, update: Extract<JobUpdate, { status: 'succeeded' }>) {
    const def = jobDefs.get(row.kind);
    const fail = async (code: string, message: string) =>
      (await this.finish(row.id, 'failed', { code, message }, { action: 'job.failed' }))
        ? `failed: ${code}`
        : 'ignored: finished';
    if (!def) return fail('unknown_kind', `This server has no job kind ${row.kind}`);
    let output: unknown = update.output ?? null;
    if (def.output) {
      const parsed = def.output.safeParse(update.output);
      if (!parsed.success) return fail('bad_output', 'The output is not what this job gives');
      output = parsed.data;
    }
    const list = update.files ?? [];
    const max = def.maxFiles ?? MAX_FILES;
    if (list.length > max) return fail('too_many_files', `At most ${max} result files`);

    const stored: string[] = [];
    for (const file of list) {
      const bytes = await this.bytesOf(row, def, file);
      try {
        const kept = await this.files().storeBytes({
          tenantId: row.tenantId,
          uploader: { kind: 'server' },
          source: 'server',
          name: file.name,
          mime: file.mime,
          bytes,
          audit: { actorKind: 'system', actorId: row.kind, channel: 'background' },
        });
        stored.push(kept.id);
      } catch (e) {
        // Too large, or not what it says it is: no retry makes it fit.
        if (e instanceof HttpException && [413, 422].includes(e.getStatus()))
          throw new ResultRefused(`${file.name}: ${brief(e)}`);
        throw e;
      }
    }

    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, row.id)).for('update');
      // Finished meanwhile: the files stay on no record, and the files sweeper deletes them.
      if (!current || isJobFinished(current.status)) return 'ignored: finished';
      const [done] = await tx
        .update(jobs)
        .set({
          status: 'succeeded',
          progress: 100,
          message: update.message ?? current.message,
          output: (toJson(output) ?? null) as unknown,
          resultFiles: stored,
          finishedAt: new Date(),
          leaseUntil: null,
          nextPollAt: null,
          completion: def.complete ? 'pending' : null,
        })
        .where(eq(jobs.id, row.id))
        .returning();
      if (stored.length)
        await tx
          .update(files)
          .set({
            resourceType: JOB,
            resourceId: done.id,
            field: RESULTS_FIELD,
            attachedAt: new Date(),
          })
          .where(
            and(
              inArray(files.id, stored),
              eq(files.tenantId, done.tenantId),
              isNull(files.resourceId),
              eq(files.status, 'ready'),
            ),
          );
      const p = this.system(done);
      await this.audit(tx, p, 'job.succeeded', done, { files: stored.length });
      await recordEvents(tx, {
        principal: p,
        events: [new JobEvent('job.succeeded', infoOf(done))],
      });
      return 'applied';
    });
  }

  /* ── The worker's tick ───────────────────────────────────────────────────── */

  /**
   * Every few seconds, in the worker: unfinished jobs past their deadline fail (`timed_out`)
   * and their service is asked to stop; due polls run; updates kept but never queued, and
   * queued jobs nobody is submitting, are queued again.
   */
  async tick(): Promise<{ timedOut: number; polled: number; requeued: number }> {
    let timedOut = 0;
    let polled = 0;
    let requeued = 0;

    const late = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.status, ['queued', 'running']), lt(jobs.deadlineAt, sql`now()`)))
      .limit(100);
    for (const { id } of late) {
      const done = await this.finish(
        id,
        'failed',
        { code: 'timed_out', message: 'It did not finish in time' },
        { action: 'job.timeout' },
      );
      if (done) {
        timedOut += 1;
        await this.askToStop(done);
      }
    }

    const due = await this.db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, 'running'),
            isNotNull(jobs.submittedAt),
            lte(jobs.nextPollAt, sql`now()`),
            or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, sql`now()`)),
          ),
        )
        .limit(50)
        .for('update', { skipLocked: true });
      if (!picked.length) return [];
      return tx
        .update(jobs)
        .set({ leaseUntil: later(CALL_TIMEOUT_MS + 5_000) })
        .where(
          inArray(
            jobs.id,
            picked.map((r) => r.id),
          ),
        )
        .returning();
    });
    for (const row of due) {
      await this.pollOne(row);
      polled += 1;
    }

    const unapplied = await this.db
      .select({ id: jobUpdates.id })
      .from(jobUpdates)
      .where(
        and(
          isNull(jobUpdates.appliedAt),
          lt(jobUpdates.receivedAt, sql`now() - interval '1 minute'`),
        ),
      )
      .limit(100);
    for (const { id } of unapplied) {
      await this.queues.add(APPLY_QUEUE, { updateId: id }, { jobId: `apply--${id}` });
      requeued += 1;
    }

    const stuck = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'queued'),
          isNull(jobs.submittedAt),
          lt(jobs.createdAt, sql`now() - interval '30 seconds'`),
          or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, sql`now()`)),
        ),
      )
      .limit(100);
    for (const row of stuck) {
      await this.queues.add(
        SUBMIT_QUEUE,
        { jobId: row.id },
        { jobId: submitJobId(row.id, row.attempts) },
      );
      requeued += 1;
    }
    return { timedOut, polled, requeued };
  }

  /** Ask the service once; what it says is kept and applied. A failure waits for the next poll. */
  private async pollOne(row: JobRow) {
    const def = jobDefs.get(row.kind);
    try {
      if (!def?.poll) return;
      const said = await def.poll(this.context(row, def, CALL_TIMEOUT_MS));
      if (said) {
        const update = JobUpdate.parse(said);
        const dedupe = `poll:${createHash('sha256').update(JSON.stringify(update)).digest('hex')}`;
        await this.store(row, 'poll', dedupe, update);
      }
    } catch (e) {
      log.warn(`poll ${row.id} (${row.kind}): ${brief(e)}`);
    } finally {
      await this.db
        .update(jobs)
        .set({ leaseUntil: null, nextPollAt: def?.poll ? later(pollEvery(def)) : null })
        .where(and(eq(jobs.id, row.id), eq(jobs.status, 'running')));
    }
  }

  /** The `jobs.cancel` queue: tell the service to stop. A throw is retried by the queue. */
  async stop(jobId: string): Promise<string> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    const def = row ? jobDefs.get(row.kind) : undefined;
    if (!row || !def?.cancel) return 'nothing to stop';
    await def.cancel(this.context(row, def, CALL_TIMEOUT_MS, { byDeadline: false }));
    return 'asked to stop';
  }

  /* ── Writing results back ────────────────────────────────────────────────── */

  /**
   * After a success, the kind's `complete` (the `job.succeeded` subscriber), as the system
   * principal of the job's business. At least once, at most COMPLETE_ATTEMPTS times; a throw is
   * kept on the job and retried by the subscriber's queue.
   */
  async complete(jobId: string): Promise<void> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (row?.status !== 'succeeded' || row.completion !== 'pending') return;
    const def = jobDefs.get(row.kind);
    if (!def?.complete) return;
    const [counted] = await this.db
      .update(jobs)
      .set({ completionAttempts: sql`${jobs.completionAttempts} + 1` })
      .where(and(eq(jobs.id, jobId), eq(jobs.completion, 'pending')))
      .returning();
    if (!counted) return;

    const p = this.system(row);
    const results = new Set(row.resultFiles);
    const resultFile = async (id: string) => {
      if (!results.has(id)) throw new Error(`${id} is not a result file of this job`);
      const [file] = await this.db
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.tenantId, row.tenantId), eq(files.status, 'ready')));
      if (!file) throw new Error(`The result file ${id} is gone`);
      return file;
    };
    let writes = 0;
    const ctx: CompleteContext = {
      job: { ...recordOf(row), output: row.output, files: row.resultFiles },
      principal: p,
      write: async (op, input) => {
        writes += 1;
        const out = await runWrite(
          this.db,
          { principal: p, requestId: randomUUID(), idempotencyKey: `job:${row.id}:${writes}` },
          op,
          input,
        );
        for (const event of out.events) this.bus.publish(event);
        return out.result;
      },
      copyFile: async (id) => {
        const file = await resultFile(id);
        const copy = await this.files().storeBytes({
          tenantId: row.tenantId,
          uploader: { kind: 'server' },
          source: 'server',
          name: file.name,
          mime: file.mime,
          bytes: await this.files().bytesOf(file),
          audit: { actorKind: 'system', actorId: row.kind, channel: 'background' },
        });
        return copy.id;
      },
      fileBytes: async (id) => this.files().bytesOf(await resultFile(id)),
      db: this.db,
      get: (token) => this.ref.get(token, { strict: false }),
    };
    try {
      await def.complete(ctx);
      await this.db
        .update(jobs)
        .set({ completion: 'done', completionError: null })
        .where(eq(jobs.id, jobId));
    } catch (e) {
      const last = counted.completionAttempts >= COMPLETE_ATTEMPTS;
      await this.db
        .update(jobs)
        .set({ completionError: brief(e), ...(last ? { completion: 'failed' as const } : {}) })
        .where(eq(jobs.id, jobId));
      log.warn(`complete ${jobId} (${row.kind}) #${counted.completionAttempts}: ${brief(e)}`);
      if (!last) throw e;
    }
  }
}
