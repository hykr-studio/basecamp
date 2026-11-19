// Data that is not an entity's, in a business's export: a feature's or a module's own tables.
// Nothing here loads Nest: a module can declare a source at load time.
import { createHookRegistry, type Principal } from '@hykr/contracts';
import { entityDefs } from '@hykr/core';
import type { Database } from '@hykr/db';
import type { Type } from '@nestjs/common';

declare module '@hykr/contracts' {
  interface Contributions {
    dataExportSources: readonly DataExportSource[];
  }
}

/** What a source gets: who the export is for, in which business. */
export interface DataExportContext {
  /** The person the export is for, as they stand now. Yield only what they may read. */
  principal: Principal;
  tenantId: string;
  db: Database;
  /** Aborts when the export runs out of time. */
  signal: AbortSignal;
  /** A provider from any loaded module. */
  get<T>(token: Type<T> | string | symbol): T;
}

type Row = Record<string, unknown>;

/**
 * Rows of a business's data that no entity serves, for its export: written as `<name>.json` and
 * `<name>.csv` beside the entities' files. `rows` yields only what `ctx.principal` may read, as
 * they may see it; each row then passes the read projectors with the source's name as its
 * resource type. Contribute it as `dataExportSources`.
 */
export interface DataExportSource {
  /** Unique, lower case letters, digits and '-': 'audit-log'. Its files' name. */
  name: string;
  rows(ctx: DataExportContext): AsyncIterable<Row> | Promise<readonly Row[]>;
}

/** Export sources, in registration order. */
export const dataExportSources = createHookRegistry<DataExportSource>(
  'data export source',
  (s) => s.name,
  { collects: 'dataExportSources' },
);

const NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * What is wrong with the sources: a bad name, or one an entity's plural or the manifest already
 * takes (names compared without case: archives are unpacked on file systems that ignore it).
 */
export function exportSourceProblems(): string[] {
  const problems: string[] = [];
  const taken = new Map<string, string>([['manifest', 'the manifest']]);
  for (const d of entityDefs()) taken.set(d.plural.toLowerCase(), `the entity ${d.name}`);
  for (const s of dataExportSources.all()) {
    if (!NAME.test(s.name))
      problems.push(`Export source "${s.name}": use lower case letters, digits and "-"`);
    const clash = taken.get(s.name.toLowerCase());
    if (clash) problems.push(`Export source "${s.name}" takes the file name of ${clash}`);
    if (typeof s.rows !== 'function') problems.push(`Export source "${s.name}": give rows(ctx)`);
  }
  return problems;
}
