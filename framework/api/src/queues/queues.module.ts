import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from 'bullmq';
// The channel's queues register themselves when this loads: they are in the registry too.
import '../channels/queues.js';
import { config } from '../config.js';
import { installFeatures } from '../features/install.js';
import { type QueueDef, queues, type ServerContext, schedules } from '../hooks.js';
import { checkQueues, JOBS, jobDefaults } from './define.js';
import { JobsService, serverContext } from './jobs.service.js';

const log = new Logger('Queues');

const pascal = (name: string) =>
  name
    .split(/[.-]/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

/**
 * A Nest processor for a queue that brings its own `process`: BullMQ's explorer finds it like a
 * hand-written one, and closes its worker with the app.
 */
function processorFor(def: QueueDef): Type {
  if (!def.process) throw new Error(`Queue ${def.name} has no process`);
  const run: NonNullable<QueueDef['process']> = def.process;
  @Processor(def.name, { concurrency: def.concurrency ?? 1 })
  class RegistryProcessor extends WorkerHost {
    private readonly ctx: ServerContext;
    constructor(@Inject(ModuleRef) ref: ModuleRef) {
      super();
      this.ctx = serverContext(ref);
    }
    process(job: Job) {
      return run(job, this.ctx);
    }
  }
  Object.defineProperty(RegistryProcessor, 'name', { value: `${pascal(def.name)}Processor` });
  return RegistryProcessor;
}

/** Every schedule, upserted on its queue once the worker's processors exist. */
@Injectable()
export class SchedulesService implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap() {
    for (const s of schedules.all()) {
      await this.jobs
        .queue(s.queue)
        .upsertJobScheduler(
          s.name,
          s.every !== undefined ? { every: s.every } : { pattern: s.cron, tz: 'UTC' },
          { name: s.name, data: s.data ?? {} },
        );
    }
    if (schedules.all().length) log.log(`${schedules.all().length} schedules upserted`);
  }
}

/**
 * Redis for jobs, and every queue in the registry (the channel's, the features', the
 * application's), under this process's prefix. Global: any module can inject a queue
 * (`@InjectQueue(name)`) or `JobsService`. With processors (the worker, or the API inline), each
 * queue that brings its own `process` gets a worker, and the schedules are upserted.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest's dynamic-module pattern
export class QueuesModule {
  static forRoot(opts: { processors: boolean }): DynamicModule {
    // Features contribute queues: they must be in the registry before it is read.
    installFeatures();
    checkQueues();
    const all = queues.all();
    const registered = BullModule.registerQueue(
      ...all.map((q) => ({ name: q.name, defaultJobOptions: jobDefaults(q) })),
    );
    const processors: Provider[] = opts.processors
      ? [...all.filter((q) => q.process).map(processorFor), SchedulesService]
      : [];
    return {
      module: QueuesModule,
      imports: [
        BullModule.forRoot({
          connection: { url: config.redisUrl },
          prefix: config.queuePrefix,
          defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
        }),
        registered,
      ],
      providers: [JobsService, { provide: JOBS, useExisting: JobsService }, ...processors],
      exports: [registered, JobsService, JOBS],
    };
  }
}
