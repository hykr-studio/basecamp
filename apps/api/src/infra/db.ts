import { createDb } from '@app/db';
import { config } from '../config.js';

export type Db = ReturnType<typeof createDb>;

/** One pool for the process: Nest providers and Better Auth share it. */
export const sharedDb: Db = createDb(config.databaseUrl);
