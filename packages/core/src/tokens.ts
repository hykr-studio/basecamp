import type { Channel } from '@app/contracts';
import type { Database } from '@app/db';

/** The Drizzle database every generated handler uses. */
export const CORE_DB = Symbol('CORE_DB');
export const CORE_OPTIONS = Symbol('CORE_OPTIONS');

export interface AgentKey {
  id: string;
  key: string;
  /** May start a chat turn for the person it acts for (POST /api/chat). */
  relay?: boolean;
  /** Every call it makes belongs to this channel, whatever its headers say. */
  channel?: Channel;
}

export interface CoreOptions {
  db: Database;
  /**
   * The agents this API knows, each with its own key (x-agent-key + x-agent-id). The assistant
   * acts through tools; a relay (the voice worker) may also start a chat turn for the person it
   * acts for, and every call it makes belongs to its channel.
   */
  agents: AgentKey[];
  /** How long a parked operation waits for its owner. Default 24 hours. */
  approvalTtlMs?: number;
}

/** A transaction handle: what every write and every command's repository calls receive. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** A connection or a transaction. Reads take either. */
export type Conn = Database | Tx;
