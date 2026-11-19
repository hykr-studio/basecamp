import { jsonb } from 'drizzle-orm/pg-core';

/**
 * A record's custom fields (A11): one jsonb object, `custom`, whose keys a business defines
 * (`app.custom_fields`). Give an entity this column, the `customFields` trait and `custom` in its
 * schemas. Its JS key must be `custom`.
 */
export const customFieldsColumn = () =>
  jsonb('custom').$type<Record<string, string | number | boolean>>().notNull().default({});
