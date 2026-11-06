import { checkVersioned, revisionFields, versionedOf, versionField } from '@hykr/contracts';
import { entityDefs } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { getTableColumns } from 'drizzle-orm';

/** At start: every served entity's versioning names fields its schemas and table have. */
@Injectable()
export class VersionsStart implements OnModuleInit {
  onModuleInit() {
    for (const def of entityDefs()) {
      const trait = versionedOf(def.spec);
      if (!trait) continue;
      checkVersioned(def.spec);
      const columns = getTableColumns(def.table) as Record<string, unknown>;
      const rev = revisionFields(trait);
      for (const field of [versionField(trait), ...(rev ? [rev.series, rev.number] : [])])
        if (!columns[field]) throw new Error(`${def.name}'s versions: its table has no "${field}"`);
    }
  }
}
