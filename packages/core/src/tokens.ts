import type { Database } from '@app/db';

/** The Drizzle database every generated handler uses. */
export const CORE_DB = Symbol('CORE_DB');
export const CORE_OPTIONS = Symbol('CORE_OPTIONS');

export interface CoreOptions {
  db: Database;
  /** The shared agent key (Step 6). */
  agentApiKey: string;
  /** The only agent this API knows. */
  agentId: string;
  /** How long a parked operation waits for its owner. Default 24 hours. */
  approvalTtlMs?: number;
}

/** A transaction handle: what every write and every command's repository calls receive. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** A connection or a transaction. Reads take either. */
export type Conn = Database | Tx;
