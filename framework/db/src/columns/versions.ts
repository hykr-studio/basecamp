import { integer, text } from 'drizzle-orm/pg-core';

/**
 * The version counter of a record with the `versioned` trait: 1 when created, one more on
 * every update, and a write against an older one answers 409.
 *
 *   version: versionColumn(),
 */
export const versionColumn = (name = 'version') => integer(name).notNull().default(1);

/**
 * A record that has revisions (v1, v2, v3), each a row of its own: `seriesId` holds the first
 * revision's id (null on the first, whose own id is the series), `revision` counts from 1.
 *
 *   ...revisionColumns(),
 */
export const revisionColumns = () => ({
  seriesId: text('series_id'),
  revision: integer('revision').notNull().default(1),
});
