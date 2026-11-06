// Declaring queues and schedules. Nothing here reads the configuration or loads Nest: it is safe
// to import from an application module or a feature file at load time.
import { type QueueDef, queues, type ScheduleDef, schedules } from '../hooks.js';

/** Inject the `Jobs` (QueuesModule's JobsService) under this token: `@Inject(JOBS) jobs: Jobs`. */
export const JOBS = Symbol('JOBS');

/** Lower case words joined by '.' or '-': 'credits.alerts', 'wa-send'. ':' is BullMQ's separator. */
const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function checkName(kind: string, name: string) {
  if (!NAME.test(name))
    throw new Error(
      `The ${kind} name "${name}" must be lower case words joined by "." or "-" (e.g. "credits.alerts")`,
    );
}

/**
 * A queue, checked: its name, and positive numbers. Contribute it (`contributes: { queues }`)
 * and add jobs with `JobsService.add(queue, data)` or `ctx.jobs.add(...)`.
 *
 *   export const AlertQueue = defineQueue<{ tenantId: string }>({
 *     name: 'credits.alerts',
 *     attempts: 3,
 *     process: async (job, ctx) => ctx.get(CreditsService).alert(job.data.tenantId),
 *   });
 */
// biome-ignore lint/suspicious/noExplicitAny: a queue's job data is its own
export function defineQueue<D = any, R = unknown>(def: QueueDef<D, R>): QueueDef<D, R> {
  checkName('queue', def.name);
  for (const key of ['concurrency', 'attempts', 'backoffMs'] as const) {
    const value = def[key];
    if (value !== undefined && !(Number.isInteger(value) && value > 0))
      throw new Error(`Queue ${def.name}: ${key} must be a positive whole number`);
  }
  return def;
}

/**
 * Register queues now, at import: for framework code whose processors are Nest classes (the
 * channel's queues). Everything else contributes its queues instead.
 */
export function registerQueue(...defs: QueueDef[]): void {
  queues.register(...defs.map((d) => defineQueue(d)));
}

/**
 * A schedule, checked: its name, exactly one of `every` (milliseconds) and `cron` (UTC), and
 * `every` at least a second. The worker upserts it on its queue at startup; a schedule whose
 * queue is not registered stops the start.
 */
export function defineSchedule(def: ScheduleDef): ScheduleDef {
  checkName('schedule', def.name);
  if ((def.every === undefined) === (def.cron === undefined))
    throw new Error(`Schedule ${def.name}: give exactly one of every and cron`);
  if (def.every !== undefined && !(Number.isInteger(def.every) && def.every >= 1000))
    throw new Error(`Schedule ${def.name}: every is in milliseconds, at least 1000`);
  if (def.cron !== undefined && def.cron.trim().split(/\s+/).length < 5)
    throw new Error(`Schedule ${def.name}: cron needs at least five fields`);
  return def;
}

/** What every job on a queue gets unless its add() says otherwise. */
export function jobDefaults(def: QueueDef) {
  return {
    // Repeated from BullModule.forRoot: a queue's own defaultJobOptions replace the shared ones.
    removeOnComplete: 1000,
    removeOnFail: 5000,
    ...(def.attempts ? { attempts: def.attempts } : {}),
    ...(def.backoffMs ? { backoff: { type: 'exponential' as const, delay: def.backoffMs } } : {}),
  };
}

/** Check every registered queue and schedule, as the start does. */
export function checkQueues() {
  for (const q of queues.all()) defineQueue(q);
  for (const s of schedules.all()) {
    defineSchedule(s);
    if (!queues.has(s.queue))
      throw new Error(
        `Schedule ${s.name} adds jobs to ${s.queue}, which is not a registered queue`,
      );
  }
}
