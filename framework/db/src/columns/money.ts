import { bigint, text } from 'drizzle-orm/pg-core';

/**
 * Money columns for an application's tables: an amount is a whole number of the currency's
 * minor units (`bigint`, read as a JavaScript number, exact up to 2^53), never `numeric` or a
 * float; the record's currency is one ISO 4217 code beside them. Give the entity's spec the
 * `money` trait, keyed by the same field names, and its reads carry `Money` objects.
 *
 *   total: minorUnits('total').notNull().default(0),
 *   currency: currencyColumn(),
 */
export const minorUnits = (name: string) => bigint(name, { mode: 'number' });

/** The record's currency (ISO 4217, upper case). */
export const currencyColumn = (name = 'currency') => text(name).notNull();
