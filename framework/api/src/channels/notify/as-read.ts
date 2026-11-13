// What a notification's words see: the record it is about, as one recipient may read it.
import type { Principal } from '@hykr/contracts';
import { entityDef, projectRead } from '@hykr/core';
import type { Row } from '@hykr/notifications';
import { getTableColumns, type Table } from 'drizzle-orm';
import type { z } from 'zod';

type Values = Record<string, unknown>;

/**
 * A stored row as `p` may read it, for the words a notification says to them (decisions H1).
 * An entity's record goes through its read schema, its plugins (field policy) and the read
 * projectors, as `toRead` and `eventFor` do; an event's row that is not a whole record (a
 * command's) is read with what it has. Keys of the row that are neither the entity's columns nor
 * its read fields (an event's own data: the SLA that ran out) stay; the record's other columns
 * (its owner, its customer) do not. Any other record (an approval, a mention) goes through the
 * read projectors as its type. `id` and `tenantId` are always there. Null: it does not read as
 * that record at all, so nothing is said.
 */
export function readAs(resourceType: string, row: Row, p: Principal): Row | null {
  const keep = { id: row.id, tenantId: row.tenantId };
  const def = entityDef(resourceType);
  if (!def) return { ...projectRead(resourceType, row, p), ...keep } as Row;
  const json = def.readJson(row);
  const schema = def.spec.schemas.read as z.ZodType;
  const object = 'shape' in schema ? (schema as z.ZodObject) : null;
  const whole = schema.safeParse(json);
  const read = whole.success ? whole : object?.partial().safeParse(json);
  if (!read?.success) return null;
  const seen = def.project(read.data as Values, p);
  const columns = getTableColumns(def.table as Table);
  const fields = object?.shape ?? {};
  const extras = Object.fromEntries(
    Object.entries(row).filter(([k]) => !(k in columns) && !(k in fields)),
  );
  return { ...extras, ...seen, ...keep } as Row;
}
