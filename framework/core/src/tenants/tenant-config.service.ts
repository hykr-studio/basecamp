import { featureEnabled, parseTenantSettings, type TenantConfig } from '@hykr/contracts';
import { type Database, schema } from '@hykr/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';

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
   * not cached, so a new one is seen at once). Stored settings that do not parse throw.
   */
  async get(tenantId: string): Promise<TenantInfo> {
    return (await this.load(tenantId)) ?? { name: '', settings: parseTenantSettings(undefined) };
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
   * The business as cached in this process, without a query: undefined when it is not cached
   * (or expired). For synchronous readers on a path that just loaded it with `get`.
   */
  peek(tenantId: string): TenantInfo | undefined {
    const hit = this.cache.get(tenantId);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.info : undefined;
  }

  /** The business from the cache or the database; null when there is no such business. */
  private async load(tenantId: string): Promise<TenantInfo | null> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.info;
    const [row] = await this.db
      .select({ name: schema.tenants.name, settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!row) {
      this.cache.delete(tenantId);
      return null;
    }
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
