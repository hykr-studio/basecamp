// Declaring kinds of long-running jobs. Nothing here reads the configuration or loads Nest: an
// application module or a feature file can import it at load time.
import type { IncomingHttpHeaders } from 'node:http';
import {
  createHookRegistry,
  type JobAbout,
  type JobUpdate,
  type Principal,
  type WriteResult,
} from '@hykr/contracts';
import type { WriteOp } from '@hykr/core';
import type { Database } from '@hykr/db';
import type { Type } from '@nestjs/common';
import type { z } from 'zod';

declare module '@hykr/contracts' {
  interface Contributions {
    jobs: readonly JobDef[];
  }
}

/** One job, as a kind's functions see it. */
export interface JobRecord<I = unknown> {
  id: string;
  tenantId: string;
  kind: string;
  input: I;
  /** The service's id for it, once submitted. */
  externalId: string | null;
  about: JobAbout | null;
  /** This submission's number, from 1. */
  attempt: number;
  deadlineAt: Date;
}

/** What `submit`, `poll`, `cancel` and `download` get. */
export interface JobContext<I = unknown> {
  job: JobRecord<I>;
  /** Aborts at the call's time limit or the job's deadline, whichever is first. */
  signal: AbortSignal;
  /** A short-lived download URL for one of the job's input files (`inputFiles`). */
  fileUrl(id: string): Promise<string>;
  /** The bytes of one of the job's input files (`inputFiles`). */
  fileBytes(id: string): Promise<Buffer>;
  /** A provider from any loaded module (an HTTP client, a credentials service). */
  get<T>(token: Type<T> | string | symbol): T;
}

/** Where the service posts updates, and the secret it signs them with. */
export interface JobCallbackTarget {
  url: string;
  /** This job's own secret: sign each post with it (`signJobCallback`). */
  secret: string;
  /** The header the signature goes in: `x-job-signature`. */
  header: string;
}

export interface SubmitContext<I = unknown> extends JobContext<I> {
  /** Null when the kind takes no callbacks (`callback: false`). */
  callback: JobCallbackTarget | null;
  /** Report progress while submitting (work that runs here, in the worker). */
  progress(percent: number, message?: string): Promise<void>;
}

/** What a submission returns: the service's id, and an update when it already knows one. */
export interface SubmitResult {
  externalId?: string;
  /** Work done in `submit` itself returns its finished update. */
  update?: JobUpdate;
}

/** What `complete` gets: the finished job, and how to write results back as the server. */
export interface CompleteContext<I = unknown, O = unknown> {
  job: JobRecord<I> & { output: O; files: readonly string[] };
  /** `systemPrincipal({ tenantId, job: <kind>, runId: <job id> })`. */
  principal: Principal;
  /**
   * `runWrite` as the system principal, with the idempotency key `job:<id>:<n>` (the hook's
   * n-th write): when the hook runs again, its earlier writes return their first result.
   */
  write<In, L, V>(op: WriteOp<In, L, V>, input: unknown): Promise<WriteResult>;
  /** A copy of one result file, stored as a server file that a system write can attach. */
  copyFile(id: string): Promise<string>;
  /** The bytes of one result file. */
  fileBytes(id: string): Promise<Buffer>;
  db: Database;
  get<T>(token: Type<T> | string | symbol): T;
}

/** A callback as it arrived. */
export interface JobCallbackRequest {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
}

/** How a kind's service calls back, when it is not in the framework's own format. */
export interface JobCallbackOptions {
  /**
   * Is this post from the job's service? Default: the `x-job-signature` header
   * (`verifyJobCallback`) with the job's secret and the timestamp tolerance. Give this for a
   * service that signs its own way.
   */
  verify?(req: JobCallbackRequest, ctx: { secret: string; job: JobRecord }): boolean;
  /** The service's body as a `JobUpdate` (checked), or null to ignore it. Default: as is. */
  parse?(body: unknown, headers: IncomingHttpHeaders): unknown;
  /** One key per delivery (a provider's delivery id). Default: the raw body's SHA-256. */
  dedupe?(req: JobCallbackRequest & { body: unknown }): string | undefined;
}

/**
 * A kind of long-running job: work handed to an outside service (or run in the worker) that
 * reports progress and finishes with an output and result files. Start one with `startJob`
 * inside a write; contribute the kind as `jobs`.
 */
// biome-ignore lint/suspicious/noExplicitAny: a job's input and output are its own
export interface JobDef<I = any, O = any> {
  /** Unique, prefixed by its owner: 'reports.export'. Lower case words joined by '.' or '-'. */
  name: string;
  /** What it does, for people and the assistant. */
  description: string;
  input: z.ZodType<I>;
  /** Its output, checked on success: one that does not parse fails the job (`bad_output`). */
  output?: z.ZodType<O>;
  /** The record it is about: whoever reaches that record reaches the job and its files. */
  about?: { entity: string; id(input: I): string };
  /** File ids in the input the work reads: the starter must reach each one. */
  inputFiles?(input: I): readonly string[];
  /** How long it may take from its start: past that, it fails as `timed_out`. */
  timeoutMs: number;
  /** Hands the work over (or does it). Throwing is retried, then fails it (`submit_failed`). */
  submit(ctx: SubmitContext<I>): Promise<SubmitResult | undefined>;
  /** How long one submission may take. Default 60 s. */
  submitTimeoutMs?: number;
  /** Submissions before it fails. Default 3. */
  submitAttempts?: number;
  /** The wait before the second submission; it doubles each time. Default 5 s. */
  submitBackoffMs?: number;
  /** Asks the service how it is going: an update, or null for no news. */
  poll?(ctx: JobContext<I>): Promise<JobUpdate | null>;
  /** How often to poll after the last update. Default 30 s. */
  pollEveryMs?: number;
  /**
   * How its service calls back. Default: the framework's format, signed (`signJobCallback`).
   * `false`: it never does (a callback is 404): it is polled, or `submit` does the work itself.
   */
  callback?: false | JobCallbackOptions;
  /** Asks the service to stop (cancelled, timed out). Best effort, retried. */
  cancel?(ctx: JobContext<I>): Promise<void>;
  /** Fetches a result file given by URL (a service that needs credentials). Default: a guarded fetch. */
  download?(file: { name: string; mime: string; url: string }, ctx: JobContext<I>): Promise<Buffer>;
  /** After it succeeded: write the results back. Runs at least once, in the worker. */
  complete?(ctx: CompleteContext<I, O>): Promise<void>;
  /** Result files at most. Default 20. */
  maxFiles?: number;
}

/** Kinds of jobs, by name. */
export const jobDefs = createHookRegistry<JobDef>('job', (d) => d.name, { collects: 'jobs' });

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

const positiveInt = (v: number | undefined) => v === undefined || (Number.isInteger(v) && v > 0);

/**
 * A kind of job, checked: its name, its numbers, and that its functions are functions.
 *
 *   export const ExportJob = defineJob({
 *     name: 'reports.export',
 *     description: 'Exports a report as a spreadsheet.',
 *     input: z.object({ reportId: z.uuid() }),
 *     about: { entity: 'report', id: (i) => i.reportId },
 *     timeoutMs: 15 * 60_000,
 *     submit: async (ctx) => ({ externalId: await service.start(ctx.job.input, ctx.callback) }),
 *   });
 */
// biome-ignore lint/suspicious/noExplicitAny: a job's input and output are its own
export function defineJob<I = any, O = any>(def: JobDef<I, O>): JobDef<I, O> {
  if (!NAME.test(def.name) || def.name.length > 64)
    throw new Error(
      `The job name "${def.name}" must be lower case words joined by "." or "-", at most 64 characters`,
    );
  if (!def.description?.trim()) throw new Error(`Job ${def.name}: describe what it does`);
  if (typeof def.submit !== 'function') throw new Error(`Job ${def.name}: give submit`);
  for (const key of [
    'timeoutMs',
    'submitTimeoutMs',
    'submitAttempts',
    'submitBackoffMs',
    'pollEveryMs',
    'maxFiles',
  ] as const)
    if (!positiveInt(def[key]))
      throw new Error(`Job ${def.name}: ${key} must be a positive whole number`);
  if (def.timeoutMs === undefined) throw new Error(`Job ${def.name}: give timeoutMs`);
  if (def.pollEveryMs !== undefined && def.pollEveryMs < 1000)
    throw new Error(`Job ${def.name}: pollEveryMs is in milliseconds, at least 1000`);
  if (def.pollEveryMs !== undefined && !def.poll)
    throw new Error(`Job ${def.name}: pollEveryMs without poll`);
  if (def.about && (!def.about.entity || typeof def.about.id !== 'function'))
    throw new Error(`Job ${def.name}: about needs an entity and an id(input)`);
  return def;
}
