import { TenantSettings } from '@app/contracts';
import { type Database, schema } from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../infra/db.module.js';

/** A business as its channels need it: its name and how it works (settings, with defaults). */
@Injectable()
export class TenantsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(tenantId: string): Promise<{ name: string; settings: TenantSettings }> {
    const [row] = await this.db
      .select({ name: schema.tenants.name, settings: schema.tenants.settings })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    return { name: row?.name ?? '', settings: TenantSettings.parse(row?.settings ?? {}) };
  }
}
