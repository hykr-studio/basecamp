// Holders of files that are not entities (a job's result files). Nothing here loads Nest.
import { createHookRegistry, type Principal } from '@hykr/contracts';
import type { Conn } from '@hykr/core';

declare module '@hykr/contracts' {
  interface Contributions {
    fileHolders: readonly FileHolder[];
  }
}

/**
 * Something other than an entity that keeps files: the jobs feature keeps a job's result
 * files on the job (`resource_type 'job'`). `FilesService` asks its holder whether a caller
 * reaches a file kept there, as it asks an entity's repo for a file on a record. An entity of
 * the same name wins, so a holder's type must never be an entity's name.
 */
export interface FileHolder {
  /** The resource type its files carry: 'job'. */
  type: string;
  /**
   * Does p reach this file, kept on this resource's field? The business is checked already.
   * Answer as the record would be shown to p: a field p does not see hides its files. Read on
   * `db` only: it may be a write's open transaction (a job's start checking its input files),
   * and nothing inside a transaction may wait for a second pooled connection.
   */
  reaches(a: {
    p: Principal;
    resourceId: string;
    field: string;
    fileId: string;
    db: Conn;
  }): Promise<boolean>;
}

/** File holders, by type. */
export const fileHolders = createHookRegistry<FileHolder>('file holder', (h) => h.type, {
  collects: 'fileHolders',
});
