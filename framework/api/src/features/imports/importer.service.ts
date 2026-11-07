// The work of an import, in the worker: read the file, check its columns, then write its rows in
// batches, each row through runWrite with the entity's own create or update, as the person who
// started it. Records each key's record (app.import_keys), keeps a checkpoint per committed batch
// (app.import_batches), and returns the counts and the error report.
import { randomUUID } from 'node:crypto';
import {
  type ImportErrorCode,
  type ImportOptions,
  type ImportResult,
  type Principal,
  type WriteResult,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  auditCtx,
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  entityOp,
  runWrite,
  type Tx,
} from '@hykr/core';
import { type Database, files, importBatches, importKeys, writeAudit } from '@hykr/db';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { and, asc, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { filesConfig } from '../files/config.js';
import type { SubmitContext, SubmitResult } from '../jobs/define.js';
import { importsConfig } from './config.js';
import {
  formatOf,
  type ParsedFile,
  parseFile,
  type RawRow,
  TooManyRows,
  Unreadable,
} from './parse.js';
import { type Problem, reportFile } from './report.js';
import { cellValue, type EntityFields, fieldsOf, pick, planColumns, sameValue } from './values.js';

const log = new Logger('Imports');

type Values = Record<string, unknown>;
type Outcome = 'created' | 'updated' | 'unchanged' | 'skipped';
type Counts = Record<Outcome, number>;

/** A row's write would wait for an approval: rolled back, reported. */
class Parked extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A dry run's batch: everything it did is rolled back. */
class DryRun extends Error {}

/** A row that will not be written, found before its write. */
class RowProblem extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

const zero = (): Counts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 });

/** Postgres error codes (also through drizzle's wrapper), said without the database's detail. */
function databaseProblem(e: unknown): RowProblem | undefined {
  const code =
    (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  const constraint = String(
    (e as { constraint?: unknown })?.constraint ??
      (e as { cause?: { constraint?: unknown } })?.cause?.constraint ??
      '',
  );
  if (code === '23505' && constraint.startsWith('import_keys'))
    return new RowProblem('conflict', 'Another import wrote this key first');
  if (code === '23505')
    return new RowProblem('conflict', 'Another record already has one of these values');
  if (code === '23503') return new RowProblem('invalid', 'It names a record that does not exist');
  if (code === '23502') return new RowProblem('invalid', 'A value it needs is missing');
  if (code === '23514') return new RowProblem('invalid', 'A value is outside what is allowed');
  if (code.startsWith('22')) return new RowProblem('invalid', 'A value does not fit its field');
  return new RowProblem('failed', 'The database refused this row');
}

/** Why a write failed, as the error report says it. */
export function problemOf(e: unknown): RowProblem {
  if (e instanceof RowProblem) return e;
  if (e instanceof Parked) return new RowProblem('needs_approval', e.reason);
  if (e instanceof ZodError) {
    const [first] = e.issues;
    return new RowProblem(
      'invalid',
      e.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
      first?.path.length ? String(first.path[0]) : null,
    );
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const body = e.getResponse() as { rule?: string; reason?: string; message?: unknown } | string;
    const said =
      typeof body === 'string'
        ? body
        : (body.reason ?? (typeof body.message === 'string' ? body.message : e.message));
    if (status === 403)
      return new RowProblem(
        'forbidden',
        typeof body === 'object' && body.rule ? `${said} (${body.rule})` : said,
      );
    if (status === 404) return new RowProblem('not_found', said);
    if (status === 409) return new RowProblem('conflict', said);
    if (status === 400 || status === 422) return new RowProblem('invalid', said);
    return new RowProblem('failed', said);
  }
  const db = databaseProblem(e);
  if (db) return db;
  log.warn(`an import row failed: ${e instanceof Error ? e.message : e}`);
  return new RowProblem('failed', 'This row could not be written');
}

/** What one batch did. */
interface BatchOutcome {
  counts: Counts;
  problems: Problem[];
}

/** One row ready to be written: its key, its values by field, and its file row. */
interface Prepared {
  raw: RawRow;
  key: string;
  values: Values;
}

/**
 * Runs imports (the `imports.records` job's `submit`). Every write is the entity's own
 * operation through runWrite, as the job's starter; nothing here decides who may write what.
 */
@Injectable()
export class Importer {
  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {
    this.db = core.db;
  }

  async run(ctx: SubmitContext<ImportOptions>): Promise<SubmitResult> {
    const job = ctx.job;
    const o = job.input;
    const config = importsConfig();
    const failed = (code: string, message: string): SubmitResult => ({
      update: { status: 'failed', error: { code, message: message.slice(0, 500) } },
    });

    const def = entityDef(o.entity);
    if (!def) return failed('unknown_entity', `This server has no "${o.entity}" records`);
    const [file] = await this.db
      .select({ name: files.name, mime: files.mime })
      .from(files)
      .where(and(eq(files.id, o.file), eq(files.tenantId, job.tenantId)));
    if (!file) return failed('file_gone', 'The file to import is gone');
    const format = formatOf(o.format, file);

    let parsed: ParsedFile;
    try {
      parsed = parseFile(await ctx.fileBytes(o.file), format, config.maxRows);
    } catch (e) {
      if (e instanceof Unreadable) return failed('unreadable', e.message);
      if (e instanceof TooManyRows) return failed('too_many_rows', e.message);
      throw e;
    }
    const fields = fieldsOf(def.spec);
    const plan = planColumns(parsed.columns, fields, o);
    if (plan.unknown.length)
      return failed(
        'unknown_columns',
        `These columns are not fields of a ${def.spec.label}: ${plan.unknown.join(', ')}`,
      );
    if (parsed.rows.length && !parsed.columns.includes(o.key))
      return failed('missing_key_column', `The file has no "${o.key}" column (the key)`);

    // As the starter, now: still in the business, today's roles. An approval of the import
    // itself never approves its rows: each row is decided on its own.
    const { approvedBy: _approved, ...starter } = await ctx.starter();
    const p: Principal = { ...starter, runId: job.id };

    const rows = this.prepare(parsed, plan.fieldOf, fields, o);
    const totals = zero();
    const problems: Problem[] = [];
    const size = config.batchSize;
    for (let b = 0; b * size < rows.length; b++) {
      if (ctx.signal.aborted) throw new Error('The import ran out of time');
      const slice = rows.slice(b * size, (b + 1) * size);
      const outcome =
        (await this.checkpoint(job.id, b)) ??
        (await this.batch(p, def, fields, slice, b, o, job.id, job.tenantId));
      for (const k of Object.keys(totals) as Outcome[]) totals[k] += outcome.counts[k];
      problems.push(...outcome.problems);
      const done = Math.min(rows.length, (b + 1) * size);
      if (done < rows.length)
        await ctx.progress(
          Math.floor((done * 100) / rows.length),
          `${done} of ${rows.length} rows`,
        );
    }
    await this.db.delete(importBatches).where(eq(importBatches.jobId, job.id));

    problems.sort((a, b) => a.n - b.n);
    const errors: Record<string, number> = {};
    for (const x of problems) errors[x.code] = (errors[x.code] ?? 0) + 1;
    const report = problems.length
      ? reportFile({ name: file.name, format, columns: parsed.columns }, problems, {
          rows: config.reportRows,
          // Room for the files feature's cap, with a margin.
          bytes: Math.floor(filesConfig().maxBytes * 0.95),
        })
      : undefined;
    const result: ImportResult = {
      entity: def.name,
      source: o.source,
      dryRun: o.dryRun,
      rows: rows.length,
      ...totals,
      failed: problems.length,
      errors,
      reportRows: report?.rows ?? 0,
      reportTruncated: report?.truncated ?? false,
    };
    await writeAudit(this.db, {
      ...auditCtx(
        p,
        { rule: 'imports', reason: o.dryRun ? 'Checked an import' : 'Imported a file' },
        { principal: p, requestId: '' },
      ),
      requestId: null,
      action: 'import.done',
      resourceType: 'job',
      resourceId: job.id,
      after: result,
    });
    return {
      update: {
        status: 'succeeded',
        output: result,
        message: `${result.created} created, ${result.updated} updated, ${result.failed} not written${o.dryRun ? ' (a dry run: nothing was written)' : ''}`,
      },
      files: report ? [report.file] : [],
    };
  }

  /**
   * Each row's key and values. A row without a key, or with a key seen before in the file, is
   * kept with its problem: it is reported, never written.
   */
  private prepare(
    parsed: ParsedFile,
    fieldOf: Map<string, string>,
    fields: EntityFields,
    o: ImportOptions,
  ): (Prepared | { raw: RawRow; problem: RowProblem })[] {
    const seen = new Set<string>();
    return parsed.rows.map((raw) => {
      if (raw.problem) return { raw, problem: new RowProblem('invalid', raw.problem) };
      const k = raw.values[o.key];
      const key = k === undefined || k === null ? '' : String(k).trim();
      if (!key) return { raw, problem: new RowProblem('missing_key', `No ${o.key}`, o.key) };
      if (key.length > 200)
        return { raw, problem: new RowProblem('invalid', 'The key is longer than 200', o.key) };
      if (seen.has(key))
        return {
          raw,
          problem: new RowProblem('duplicate_key', `Another row has ${o.key} ${key}`, o.key),
        };
      seen.add(key);
      const values: Values = {};
      for (const [column, field] of fieldOf) {
        if (!Object.hasOwn(raw.values, column)) continue;
        const v = raw.values[column];
        values[field] = parsed.text
          ? cellValue(fields.create[field] ?? fields.update[field], String(v ?? ''), o.empty)
          : v;
      }
      return { raw, key, values };
    });
  }

  /** A batch an earlier attempt of this job committed, with what it did. */
  private async checkpoint(jobId: string, batch: number): Promise<BatchOutcome | undefined> {
    const [row] = await this.db
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.jobId, jobId), eq(importBatches.batch, batch)));
    return row
      ? { counts: { ...zero(), ...(row.counts as Counts) }, problems: row.problems as Problem[] }
      : undefined;
  }

  /**
   * One batch, in one transaction: each row in its own savepoint, so a row that fails leaves the
   * others. A real run stores its checkpoint with it, then publishes the writes' events; a dry
   * run rolls it all back.
   */
  private async batch(
    p: Principal,
    def: AnyEntityDef,
    fields: EntityFields,
    rows: (Prepared | { raw: RawRow; problem: RowProblem })[],
    batch: number,
    o: ImportOptions,
    jobId: string,
    tenantId: string,
  ): Promise<BatchOutcome> {
    let out: BatchOutcome = { counts: zero(), problems: [] };
    let events: object[] = [];
    try {
      await this.db.transaction(async (tx) => {
        out = { counts: zero(), problems: [] };
        events = [];
        for (const row of rows) {
          const report = (x: RowProblem) =>
            out.problems.push({
              n: row.raw.n,
              code: x.code,
              field: x.field,
              message: x.message,
              values: row.raw.values,
            });
          if ('problem' in row) {
            report(row.problem);
            continue;
          }
          try {
            const done = await tx.transaction((sp) =>
              this.row(sp, p, def, fields, row, o, jobId, tenantId),
            );
            out.counts[done.outcome] += 1;
            events.push(...done.events);
          } catch (e) {
            report(problemOf(e));
          }
        }
        if (o.dryRun) throw new DryRun();
        await tx.insert(importBatches).values({
          jobId,
          batch,
          tenantId,
          counts: out.counts,
          problems: out.problems,
        });
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
      return out;
    }
    for (const event of events) this.bus.publish(event);
    return out;
  }

  /** One row, inside its savepoint: create or update its record, and keep its key. */
  private async row(
    tx: Tx,
    p: Principal,
    def: AnyEntityDef,
    fields: EntityFields,
    row: Prepared,
    o: ImportOptions,
    jobId: string,
    tenantId: string,
  ): Promise<{ outcome: Outcome; events: object[] }> {
    const values = await this.resolveRefs(tx, p, row.values, o, tenantId);
    const keyOf = and(
      eq(importKeys.tenantId, tenantId),
      eq(importKeys.entity, def.name),
      eq(importKeys.source, o.source),
      eq(importKeys.externalId, row.key),
    );
    // Locked until the batch commits: two imports of one source never make a record twice.
    const [known] = await tx.select().from(importKeys).where(keyOf).for('update');
    const events: object[] = [];
    const write = async (action: 'create' | 'update', id: string | null, input: Values) => {
      const outcome = await runWrite(
        this.db,
        { principal: p, requestId: randomUUID(), tx },
        entityOp(def, action, id ? { id } : null),
        input,
      );
      if (outcome.result.status === 'needs_approval')
        throw new Parked(
          (outcome.result as Extract<WriteResult, { status: 'needs_approval' }>).approval.reason,
        );
      events.push(...outcome.events);
      return (outcome.result as { value: Values }).value;
    };

    if (known) {
      if (o.existing === 'skip') return { outcome: 'skipped', events };
      const record = await def.repo.find(tx, p, known.recordId);
      if (!record)
        throw new RowProblem(
          'not_found',
          `The ${def.spec.label} imported from ${o.key} ${row.key} is gone, or not yours`,
        );
      const patch = pick(values, fields.update);
      // Nothing to write (a row of its key only): unchanged, whatever an update schema that
      // wants at least one field says.
      if (!Object.keys(patch).length) return { outcome: 'unchanged', events };
      const checked = def.spec.schemas.update.safeParse(patch);
      if (!checked.success) throw checked.error;
      const shown = def.toRead(record, p) as Values;
      const changed = Object.keys(patch).filter(
        (k) => !sameValue(shown[k], (checked.data as Values)[k]),
      );
      if (!changed.length) return { outcome: 'unchanged', events };
      await write('update', known.recordId, Object.fromEntries(changed.map((k) => [k, patch[k]])));
      await tx.update(importKeys).set({ jobId, updatedAt: new Date() }).where(keyOf);
      return { outcome: 'updated', events };
    }

    const create = pick(values, fields.create);
    const checked = def.spec.schemas.create.safeParse(create);
    if (!checked.success) throw checked.error;
    // Fields only the update schema takes (a to-do's `done`) are written after the create.
    const later = Object.fromEntries(
      Object.entries(pick(values, fields.update)).filter(([k]) => !Object.hasOwn(fields.create, k)),
    );
    if (Object.keys(later).length) {
      const after = def.spec.schemas.update.safeParse(later);
      if (!after.success) throw after.error;
    }
    const created = await write('create', null, create);
    const id = String(created.id);
    if (Object.keys(later).length) await write('update', id, later);
    await tx.insert(importKeys).values({
      tenantId,
      entity: def.name,
      source: o.source,
      externalId: row.key,
      recordId: id,
      jobId,
    });
    return { outcome: 'created', events };
  }

  /**
   * `refs` columns hold other records' keys in the same source: each becomes that record's id,
   * when it was imported and the importer reaches it.
   */
  private async resolveRefs(
    tx: Tx,
    p: Principal,
    values: Values,
    o: ImportOptions,
    tenantId: string,
  ): Promise<Values> {
    if (!o.refs) return values;
    const out = { ...values };
    for (const [field, entity] of Object.entries(o.refs)) {
      const v = out[field];
      if (v === undefined || v === null || v === '') continue;
      const target = entityDef(entity);
      const key = String(v).trim();
      const [found] = target
        ? await tx
            .select({ recordId: importKeys.recordId })
            .from(importKeys)
            .where(
              and(
                eq(importKeys.tenantId, tenantId),
                eq(importKeys.entity, target.name),
                eq(importKeys.source, o.source),
                eq(importKeys.externalId, key),
              ),
            )
            .orderBy(asc(importKeys.createdAt))
        : [];
      const reached = found && target ? await target.repo.find(tx, p, found.recordId) : undefined;
      if (!reached)
        throw new RowProblem('unknown_reference', `No ${entity} was imported as ${key}`, field);
      out[field] = found.recordId;
    }
    return out;
  }
}
