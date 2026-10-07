import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { sharedDb } from './db.js';

export const DB = Symbol('DB');
export const IDEMPOTENCY_REPO = Symbol('IDEMPOTENCY_REPO');

@Global()
@Module({
  providers: [
    { provide: DB, useValue: sharedDb.db },
    { provide: IDEMPOTENCY_REPO, useValue: sharedDb.idempotency },
  ],
  exports: [DB, IDEMPOTENCY_REPO],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await sharedDb.pool.end();
  }
}
