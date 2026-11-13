import {
  featureEnabled,
  parseTenantSettings,
  type SettingsKey,
  settingsSections,
  type TenantConfig,
  type TenantSettingsSections,
} from '@hykr/contracts';
import { type Database, schema } from '@hykr/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Conn, CORE_OPTIONS, type CoreOptions } from '../tokens.js';

/** A business as its features need it: its name and its settings, defaults applied. */
export interface TenantInfo {
  name: string;
  settings: TenantConfig;
}

const DEFAULT_TTL_MS = 10_000;

/**
 * A business's name and settings (the base ones, `features` and every settings section),
 * cached per process for a few seconds (`CoreOptions.tenantConfigTtlMs`), so features can ask
 * on every request. Code that changes a business's settings calls `invalidate`; other
 * processes see the change when their copy expires.
 */
@Injectable()
export class TenantConfigService {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; info: TenantInfo }>();
  private readonly logger = new Logger(TenantConfigService.name);

  constructor(@Inject(CORE_OPTIONS) options: CoreOptions) {
    this.db = options.db;
    this.ttlMs = options.tenantConfigTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * The business's name and settings. An unknown business has no name and the defaults (it is
   * not cached, so a new one is seen at once). Stored settings that do not parse throw. A caller
   * inside a transaction passes it as `conn`: a miss in the cache then reads on it, not the pool.
   */
  async get(tenantId: string, conn?: Conn): Promise<TenantInfo> {
    return (
      (await this.load(tenantId, conn)) ?? { name: '', settings: parseTenantSettings(undefined) }
    );
  }

  /**
   * Is this feature on for this business? Fails closed: no business, an unknown one, settings
   * that do not parse, and any value but `true` are all off.
   */
  async isEnabled(tenantId: string | null | undefined, key: string): Promise<boolean> {
    if (!tenantId) return false;
    let info: TenantInfo | null;
    try {
      info = await this.load(tenantId);
    } catch (e) {
      this.logger.warn(`Settings of business ${tenantId} do not parse; "${key}" is off: ${e}`);
      return false;
    }
    return info !== null && featureEnabled(info.settings, key);
  }

  /**
   * One settings section of the business, defaults applied. When another part of its settings
   * does not parse, this section is parsed alone, so one feature's broken section does not take
   * another feature down with it. This section not parsing throws. A caller inside a
   * transaction passes it as `conn`: a miss in the cache then reads on it, not on the pool.
   */
  async section<K extends SettingsKey>(
    tenantId: string,
    key: K,
    conn?: Conn,
  ): Promise<TenantSettingsSections[K]> {
    const hit = this.fresh(tenantId);
    if (hit) return hit.settings[key];
    const row = await this.row(tenantId, conn);
    if (!row) return parseTenantSettings(undefined)[key];
    try {
      return this.remember(tenantId, row).settings[key];
    } catch (e) {
      const section = settingsSections.get(key);
      if (!section) throw e;
      const stored = isObject(row.settings) ? row.settings[key] : undefined;
      return section.schema.parse(stored) as TenantSettingsSections[K];
    }
  }

  /**
   * The business as cached in this process, without a query: undefined when it is not cached
   * (or expired). For synchronous readers on a path that just loaded it with `get`.
   */
  peek(tenantId: string): TenantInfo | undefined {
    return this.fresh(tenantId);
  }

  /** The business from the cache or the database; null when there is no such business. */
  private async load(tenantId: string, conn?: Conn): Promise<TenantInfo | null> {
    const hit = this.fresh(tenantId);
    if (hit) return hit;
    const row = await this.row(tenantId, conn);
    return row ? this.remember(tenantId, row) : null;
  }

  private fresh(tenantId: string): TenantInfo | undefined {
    const hit = this.cache.get(tenantId);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.info : undefined;
  }

  /** The stored row, as it is. An unknown business is dropped from the cache. */
  private async row(
    tenantId: string,
    conn: Conn = this.db,
  ): Promise<{ name: string; settings: unknown } | null> {
    const [row] = await conn
      .select({ name: schema.tenants.name, settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!row) this.cache.delete(tenantId);
    return row ?? null;
  }

  /** Parse and cache a stored row; settings that do not parse throw and are not cached. */
  private remember(tenantId: string, row: { name: string; settings: unknown }): TenantInfo {
    const info = { name: row.name, settings: parseTenantSettings(row.settings) };
    this.cache.set(tenantId, { at: Date.now(), info });
    return info;
  }

  /** Forget one business's settings (after changing them), or every business's. */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
