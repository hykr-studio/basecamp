// `basecamp import`'s work, in a process with the framework loaded (a Nest application context
// with no processors): store a file from disk as a member's, start the import as them through
// the write path, follow its job until it finishes, and save the error report beside the file.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  type ImportOptionsInput,
  ImportResult,
  isJobFinished,
  type JobInfo,
  type Principal,
  type WriteResult,
} from '@hykr/contracts';
import { CORE_OPTIONS, type CoreOptions, PrincipalResolver, runWrite } from '@hykr/core';
import { membershipOf, user } from '@hykr/db';
import type { INestApplicationContext } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { eq, sql } from 'drizzle-orm';
import { FilesService } from '../files/files.service.js';
import { JobRunner } from '../jobs/runner.service.js';
import { StartImport } from './start.js';

/** What `basecamp import` asks for. */
export interface ImportFileOptions extends Omit<ImportOptionsInput, 'file'> {
  /** The file on disk. */
  path: string;
  /** Who imports: a member's email, or their user id. Their records, their rights. */
  as: string;
  /** Their business (its id); default: their default business. */
  tenant?: string;
  /** Where to save the error report; default: beside the file, under the report's name. */
  report?: string;
  /** Give up waiting after this long (the job goes on). Default: until it finishes. */
  waitMs?: number;
  /** How often to look at the job. Default 1 s. */
  everyMs?: number;
  /** Where progress lines go. Default: console.log. */
  log?: (line: string) => void;
}

export interface ImportOutcome {
  /** done: it finished (see `job.status`); waiting: it waits for an approval, or still runs. */
  status: 'finished' | 'needs_approval' | 'waiting';
  job?: JobInfo;
  approvalId?: string;
  /** The job's output, when it succeeded. */
  result?: ImportResult;
  /** Where the error report was saved. */
  reportPath?: string;
}

const MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.tsv': 'text/plain',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.ndjson': 'application/x-ndjson',
  '.jsonl': 'application/x-ndjson',
};

/** The person `as` names, as a principal in their business, on the `api` channel. */
async function principalOf(
  context: INestApplicationContext,
  db: CoreOptions['db'],
  o: Pick<ImportFileOptions, 'as' | 'tenant'>,
): Promise<Principal> {
  const [person] = await db
    .select({ id: user.id })
    .from(user)
    .where(o.as.includes('@') ? sql`lower(${user.email}) = lower(${o.as})` : eq(user.id, o.as));
  if (!person) throw new Error(`Nobody is signed up as ${o.as}`);
  // Never a business made on the spot: they must belong to one already.
  const member = await membershipOf(db, person.id, o.tenant);
  if (!member)
    throw new Error(
      o.tenant ? `${o.as} is not a member of business ${o.tenant}` : `${o.as} has no business`,
    );
  const standing = await context
    .get(PrincipalResolver, { strict: false })
    .forUser(person.id, { tenantId: member.tenantId, channel: 'api' });
  return { actor: { kind: 'user', id: person.id }, ...standing, scopes: [], channel: 'api' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Import a file from disk as a member of a business (decisions B20, 20): the file is stored as
 * theirs, `import.start` runs through the write path as them, and the worker runs the job (in
 * the tests, this same process). Resolves when the job finishes, or waits for an approval.
 */
export async function importFile(
  context: INestApplicationContext,
  o: ImportFileOptions,
): Promise<ImportOutcome> {
  const log = o.log ?? ((line: string) => console.log(line));
  const { db } = context.get<CoreOptions>(CORE_OPTIONS, { strict: false });
  const p = await principalOf(context, db, o);
  const userId = p.actor.id;
  const tenantId = p.tenantId as string;
  const path = resolve(o.path);
  const name = basename(path);
  const mime = MIME[extname(path).toLowerCase()] ?? 'text/csv';
  const files = context.get(FilesService, { strict: false });
  const stored = await files.storeBytes({
    tenantId,
    uploader: { kind: 'user', userId },
    name,
    mime,
    bytes: await readFile(path),
    audit: { actorKind: 'user', actorId: userId, channel: 'api' },
  });

  const {
    path: _path,
    as: _as,
    tenant: _tenant,
    report: _report,
    waitMs,
    everyMs,
    log: _log,
    ...options
  } = o;
  const { result, events } = await runWrite(
    db,
    { principal: p, requestId: randomUUID() },
    StartImport.op(),
    { ...options, file: stored.id },
  );
  const bus = context.get(EventBus, { strict: false });
  for (const event of events) bus.publish(event);
  if (result.status === 'needs_approval') {
    const approval = (result as Extract<WriteResult, { status: 'needs_approval' }>).approval;
    log(`The import waits for approval (${approval.id}): ${approval.reason}`);
    return { status: 'needs_approval', approvalId: approval.id };
  }
  let job = (result as { value: JobInfo }).value;
  log(`Import ${job.id} started${options.dryRun ? ' (a dry run)' : ''}`);

  const runner = context.get(JobRunner, { strict: false });
  const started = Date.now();
  let said = '';
  let hinted = false;
  while (!isJobFinished(job.status)) {
    if (waitMs !== undefined && Date.now() - started > waitMs) return { status: 'waiting', job };
    await sleep(everyMs ?? 1000);
    job = await runner.get(p, job.id);
    const line = job.message ?? job.status;
    if (line !== said) {
      said = line;
      log(`${job.progress !== null ? `${job.progress}% ` : ''}${line}`);
    }
    if (!hinted && job.status === 'queued' && Date.now() - started > 20_000) {
      hinted = true;
      log('Nothing has picked it up yet: is the worker running (basecamp start worker)?');
    }
  }
  if (job.status !== 'succeeded') return { status: 'finished', job };

  const out = ImportResult.parse(job.output);
  let reportPath: string | undefined;
  const [reportId] = job.files;
  if (reportId) {
    const row = await files.reachable(p, reportId);
    reportPath = o.report ? resolve(o.report) : join(dirname(path), row.name);
    await writeFile(reportPath, await files.bytesOf(row));
  }
  return { status: 'finished', job, result: out, reportPath };
}

/** What `basecamp import` prints at the end. */
export function importSummary(out: ImportOutcome): string[] {
  if (out.status === 'needs_approval')
    return [`Waiting for approval ${out.approvalId}: once approved, the worker runs it.`];
  if (out.status === 'waiting')
    return [`Still ${out.job?.status ?? 'running'}: job ${out.job?.id}. It goes on in the worker.`];
  const job = out.job as JobInfo;
  if (!out.result)
    return [`The import ${job.status}: ${job.error?.message ?? ''} (${job.error?.code ?? ''})`];
  const r = out.result;
  const lines = [
    `${r.dryRun ? 'A dry run (nothing was written): ' : ''}${r.rows} rows: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped, ${r.failed} not written`,
  ];
  for (const [code, n] of Object.entries(r.errors)) lines.push(`  ${code}: ${n}`);
  if (out.reportPath)
    lines.push(
      `Error report: ${out.reportPath}${r.reportTruncated ? ` (the first ${r.reportRows} rows)` : ''}`,
    );
  return lines;
}
