// Keyset cursors over (created_at, id), newest first: what comes after the last row shown.
import { BadRequestException } from '@nestjs/common';
import { and, type Column, eq, lt, or, type SQL } from 'drizzle-orm';
import { storableInstant } from '../../infra/instant.js';

export type Keyset = { at: Date; id: string };

/** No id is longer: ids are uuids (36 characters) or shorter. */
const MAX_ID = 128;

/** The cursor after this row. */
export const encodeKeyset = (row: { createdAt: Date; id: string }) =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

export const badKeyset = () =>
  new BadRequestException({ error: 'bad_cursor', message: 'Unknown cursor' });

/**
 * A keyset from a cursor's two parts, when Postgres can take both: a time it can store (years 1
 * to 9999, not merely one JavaScript reads) and an id it can hold (text, no NUL, at most MAX_ID
 * long). Else undefined. Every keyset cursor reads its parts through this (V10).
 */
export function keysetOf(at: unknown, id: unknown): Keyset | undefined {
  const date = storableInstant(at);
  if (!date || typeof id !== 'string' || !id || id.length > MAX_ID || id.includes('\u0000'))
    return undefined;
  return { at: date, id };
}

/** A cursor back to a keyset, or 400 `bad_cursor`. */
export function decodeKeyset(cursor: string): Keyset {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const keyset = keysetOf(at, id);
  if (!keyset) throw badKeyset();
  return keyset;
}

/** Rows older than the keyset, in (created_at desc, id desc) order. */
export const olderThan = (k: Keyset, createdAt: Column, id: Column): SQL =>
  or(lt(createdAt, k.at), and(eq(createdAt, k.at), lt(id, k.id))) as SQL;
