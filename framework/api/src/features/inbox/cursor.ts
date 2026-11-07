// Keyset cursors over (created_at, id), newest first: what comes after the last row shown.
import { BadRequestException } from '@nestjs/common';
import { and, type Column, eq, lt, or, type SQL } from 'drizzle-orm';

export type Keyset = { at: Date; id: string };

/** The cursor after this row. */
export const encodeKeyset = (row: { createdAt: Date; id: string }) =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

/** A cursor back to a keyset, or 400. */
export function decodeKeyset(cursor: string): Keyset {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime()))
    throw new BadRequestException({ error: 'bad_cursor', message: 'Unknown cursor' });
  return { at: date, id };
}

/** Rows older than the keyset, in (created_at desc, id desc) order. */
export const olderThan = (k: Keyset, createdAt: Column, id: Column): SQL =>
  or(lt(createdAt, k.at), and(eq(createdAt, k.at), lt(id, k.id))) as SQL;
