import 'reflect-metadata';
import { assertConfig } from './config.js';

// The queue worker (`node dist/worker.js`): runs the channel's jobs. Same checks as the API.
assertConfig();

const { NestFactory } = await import('@nestjs/core');
const { WorkerModule } = await import('./worker.module.js');

const worker = await NestFactory.createApplicationContext(WorkerModule, {
  logger: ['log', 'warn', 'error'],
});
worker.enableShutdownHooks();
console.log('worker: processing the channel queues');
