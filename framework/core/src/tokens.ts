import type { Channel } from '@hykr/contracts';
import type { Database } from '@hykr/db';

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
  /** How long a business's settings stay cached in this process (TenantConfigService). Default 10 s. */
  tenantConfigTtlMs?: number;
  /**
   * This process's queue prefix (BULL_PREFIX), stamped on every stored event so only this
   * deployment's relay passes it on. Default 'bull'.
   */
  queuePrefix?: string;
  /**
   * The currency of a business that chose none (DEFAULT_CURRENCY, ISO 4217). Unset: XXX, the
   * standard's "no currency".
   */
  defaultCurrency?: string;
  /**
   * The time zone of a business that set none (DEFAULT_TIME_ZONE, IANA). Unset: UTC
   * (`tenantZone`).
   */
  defaultTimeZone?: string;
  /**
   * Does a person who signs up get a business of their own, as its creator? Default true. False:
   * they are in no business until someone invites them or puts them on a record (a participant).
   */
  createBusinessOnSignUp?: boolean;
}

/** A transaction handle: what every write and every command's repository calls receive. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** A connection or a transaction. Reads take either. */
export type Conn = Database | Tx;
