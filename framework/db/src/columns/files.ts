import { sql } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';

/**
 * A file field's column (see `FileRef` in @hykr/contracts): one file's id, or null. Name the
 * column's key after the spec's field, and list the field in the spec's `files` trait.
 */
export const fileColumn = (name: string) => text(name);

/** A list of files' ids, in order (`fileRefs()` in @hykr/contracts); empty by default. */
export const fileColumns = (name: string) =>
  text(name).array().notNull().default(sql`'{}'::text[]`);
