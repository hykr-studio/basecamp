import { createInputOf, offlineOf } from '@hykr/contracts';
import { entityDefs } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getTableColumns } from 'drizzle-orm';
import { idempotencyKeepDays } from './idempotency.service.js';

const WRITES = new Set(['create', 'update', 'delete']);

/**
 * At start: the retention reads, and every served entity marked `offline` can take what the app
 * will queue: known writes, a text id column (a client-chosen UUID is stored as is), and a
 * create schema the client id joins without clashing.
 */
@Injectable()
export class OfflineStart implements OnModuleInit {
  onModuleInit() {
    idempotencyKeepDays();
    for (const def of entityDefs()) {
      const trait = offlineOf(def.spec);
      if (!trait) continue;
      const problems: string[] = [];
      for (const w of trait.writes ?? [])
        if (!WRITES.has(w)) problems.push(`"${w}" is not a write (create, update or delete)`);
      const id = (getTableColumns(def.table) as Record<string, { columnType?: string }>).id;
      if (id?.columnType !== 'PgText') problems.push('its id column is not text');
      if ('id' in def.spec.schemas.create.shape)
        problems.push('its create schema has its own "id" (the framework adds the client id)');
      else createInputOf(def.spec);
      if (problems.length) throw new Error(`${def.name} (offline): ${problems.join('; ')}`);
    }
  }
}
