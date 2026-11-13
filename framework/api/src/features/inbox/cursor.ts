// Keyset cursors over (time, id), newest first: what comes after the last row shown. A cursor
// keeps its row's time as Postgres stores it (`keysetTime`, to the microsecond), selected with
// the row: a Date keeps milliseconds, and a cut on one skipped the rows of that millisecond
// (docs/decisions/V12.md). The inbox, comments, agent runs, the credits ledger, the integrations
// delivery log and the platform routing log read theirs here.
import { exactTime, readTimeKey, type TimeKey, timeAfter, timeSame } from '@hykr/core';
import { BadRequestException } from '@nestjs/common';
import { and, type Column, lt, or, type SQL } from 'drizzle-orm';

export type Keyset = { at: TimeKey; id: string };

/** No id is longer: ids are uuids (36 characters) or shorter. */
const MAX_ID = 128;

/** A NUL, or half of a surrogate pair: text Postgres cannot hold. */
const TEXT_FAULT = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** What a keyset read selects beside its row: the row's time as its cursor keeps it. */
export const keysetTime = (time: Column) => exactTime(time);

/** The cursor after this row: its time as `keysetTime` read it, and its id. */
export const encodeKeyset = (row: { at: string; id: string }) =>
  Buffer.from(`${row.at}|${row.id}`).toString('base64url');

export const badKeyset = () =>
  new BadRequestException({ error: 'bad_cursor', message: 'Unknown cursor' });

/**
 * A keyset from a cursor's two parts, when Postgres can take both: a time `keysetTime` wrote (or
 * the millisecond a cursor made before V12 kept), from the year 1 to 9999, and an id it can hold
 * (text, no NUL or half of a surrogate pair, at most MAX_ID long). Else undefined. Every keyset
 * cursor reads its parts through this.
 */
export function keysetOf(at: unknown, id: unknown): Keyset | undefined {
  const time = readTimeKey(at);
  if (!time || typeof id !== 'string' || !id || id.length > MAX_ID || TEXT_FAULT.test(id))
    return undefined;
  return { at: time, id };
}

/** A cursor back to a keyset, or 400 `bad_cursor`. */
export function decodeKeyset(cursor: string): Keyset {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const keyset = keysetOf(at, id);
  if (!keyset) throw badKeyset();
  return keyset;
}

/** Rows older than the keyset, in (time desc, id desc) order. */
export const olderThan = (k: Keyset, time: Column, id: Column): SQL =>
  or(timeAfter(time, time, k.at, 'desc'), and(timeSame(time, time, k.at), lt(id, k.id))) as SQL;

/**
 * A `before=` bound on a log paged back in time: the token its last page handed out (a keyset),
 * or a time someone chose (rows strictly before it, as `before` always took). Undefined when it
 * is neither.
 */
export function beforeOf(
  before: string | undefined,
  time: (text: string) => Date | undefined,
): Keyset | Date | undefined {
  if (!before) return undefined;
  if (/^[A-Za-z0-9_-]+$/.test(before)) {
    const [at, id] = Buffer.from(before, 'base64url').toString().split('|');
    const keyset = keysetOf(at, id);
    if (keyset) return keyset;
  }
  return time(before);
}

/** Rows before a `before=` bound, newest first: past its keyset, or strictly before its time. */
export const beforeWhere = (bound: Keyset | Date, time: Column, id: Column): SQL =>
  bound instanceof Date ? lt(time, bound) : olderThan(bound, time, id);
