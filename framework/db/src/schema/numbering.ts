import { bigint, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './base.js';
import { tenantColumn } from './tenancy.js';

/**
 * The counters behind number series (`nextNumber` in @hykr/core): the last number given, per
 * business, series and period ('-', 'Y2026', 'FY2026'). A number is taken in the write's own
 * transaction, which holds the row until it commits: a write that rolls back gives its number
 * back, so a series has no gaps and no repeats.
 */
export const numberSeries = app.table(
  'number_series',
  {
    tenantId: tenantColumn(),
    /** The application's series name: 'orders.order'. */
    series: text('series').notNull(),
    period: text('period').notNull(),
    last: bigint('last', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.series, table.period] })],
);
