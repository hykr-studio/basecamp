// Starting a job inside a write. Nothing here loads Nest's modules.
import type { JobInfo, Principal } from '@hykr/contracts';
import {
  auditCtx,
  type Conn,
  deny,
  entityDef,
  RuleDenied,
  recordEvents,
  type Tx,
  toJson,
} from '@hykr/core';
import { jobs, writeAudit } from '@hykr/db';
import { subjectKeyOf } from '@hykr/policy';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { type JobDef, jobDefs } from './define.js';
import { infoOf, JOB, JobEvent } from './info.js';

/**
 * What startJob needs of the running feature: whether p reaches these files, read on the
 * starting write's transaction (nothing inside it may wait for a second pooled connection).
 */
export interface JobsRuntime {
  filesReachable(conn: Conn, p: Principal, ids: readonly string[]): Promise<boolean>;
}

let running: JobsRuntime | undefined;

/** The jobs feature's service registers itself when the process starts. */
export function setJobsRuntime(r: JobsRuntime | undefined) {
  running = r;
}

/**
 * Start a job, inside a write's transaction (a command's `run`): it exists exactly when the
 * write commits. The input is checked; the record it is about must be one p reaches (404
 * otherwise) and every input file one p reaches (a refusal, `file_unavailable`). The job is
 * audited (`job.start`) and its `job.queued` event stored; the worker submits it.
 *
 *   run: async ({ tx, principal, input, loaded }) => {
 *     const job = await startJob(tx, principal, ExportJob, { reportId: loaded.id });
 *     return { value: job, touched: [] };
 *   },
 */
export async function startJob<I>(
  tx: Tx,
  p: Principal,
  def: JobDef<I>,
  rawInput: unknown,
  o: { requestId?: string } = {},
): Promise<JobInfo> {
  if (jobDefs.get(def.name) !== def)
    throw new Error(`The job "${def.name}" is not contributed (contributes: { jobs: [...] })`);
  if (!running) throw new Error('The jobs feature is not running in this process');
  const tenantId = p.tenantId;
  if (!tenantId)
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'no_tenant',
      reason: 'A job belongs to a business',
    });
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success)
    throw new BadRequestException({
      error: 'invalid_job_input',
      message: `The input of ${def.name} is not valid`,
      issues: parsed.error.issues,
    });
  const input = parsed.data;

  let about: { entity: string; id: string } | null = null;
  if (def.about) {
    const entity = entityDef(def.about.entity);
    if (!entity) throw new Error(`Job ${def.name} is about "${def.about.entity}", not served`);
    const id = def.about.id(input);
    const record = id ? await entity.repo.find(tx, p, id) : undefined;
    if (!record)
      throw new NotFoundException({ error: 'not_found', message: `No such ${entity.spec.label}` });
    about = { entity: entity.name, id };
  }

  const fileIds = [...new Set(def.inputFiles?.(input) ?? [])];
  if (fileIds.length && !(await running.filesReachable(tx, p, fileIds)))
    throw new RuleDenied(deny('file_unavailable', 'A file this job needs is not one you can use'));

  const requestId = o.requestId ?? null;
  const [row] = await tx
    .insert(jobs)
    .values({
      tenantId,
      kind: def.name,
      status: 'queued',
      input: toJson(input) ?? {},
      aboutType: about?.entity ?? null,
      aboutId: about?.id ?? null,
      startedFor: subjectKeyOf(p),
      startedByKind: p.actor.kind,
      startedById: p.actor.id,
      requestId,
      principal: p,
      deadlineAt: new Date(Date.now() + def.timeoutMs),
    })
    .returning();
  const info = infoOf(row);
  await writeAudit(tx, {
    ...auditCtx(
      p,
      { rule: 'jobs', reason: `Started ${def.name}` },
      { principal: p, requestId: requestId ?? '' },
    ),
    requestId,
    action: 'job.start',
    resourceType: JOB,
    resourceId: row.id,
    after: { kind: def.name, about },
  });
  await recordEvents(tx, {
    principal: p,
    requestId: requestId ?? undefined,
    events: [new JobEvent('job.queued', info)],
  });
  return info;
}
