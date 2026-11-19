import type { Database } from '@hykr/db';
import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { type Jobs, type QueueDef, queues, type ServerContext } from '../hooks.js';
import { DB } from '../infra/db.module.js';

/** Adds jobs to any registered queue, by its def or its name. */
@Injectable()
export class JobsService implements Jobs {
  constructor(@Inject(ModuleRef) private readonly ref: ModuleRef) {}

  queue<D = unknown>(name: string): Queue<D> {
    if (!queues.has(name)) throw new Error(`No queue is registered as ${name}`);
    return this.ref.get(getQueueToken(name), { strict: false });
  }

  add<D>(queue: QueueDef<D> | string, data: D, opts: JobsOptions & { name?: string } = {}) {
    const { name, ...options } = opts;
    const q = this.queue<D>(typeof queue === 'string' ? queue : queue.name);
    // biome-ignore lint/suspicious/noExplicitAny: BullMQ's name/data generics
    return (q as Queue<any>).add(name ?? 'job', data, options) as Promise<Job<D>>;
  }
}

/** The services a job or an event handler may use, looked up when first used. */
export function serverContext(ref: ModuleRef): ServerContext {
  return {
    get: (token) => ref.get(token, { strict: false }),
    get db() {
      return ref.get<Database>(DB, { strict: false });
    },
    get jobs() {
      return ref.get(JobsService, { strict: false });
    },
  };
}
