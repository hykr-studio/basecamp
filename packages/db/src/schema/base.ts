import { sql } from 'drizzle-orm';
import { pgSchema, text } from 'drizzle-orm/pg-core';

/** The business schema: framework tables and the domain's. */
export const app = pgSchema('app');

/** A text uuid primary key, as every table uses. */
export const id = () => text('id').primaryKey().default(sql`gen_random_uuid()::text`);
