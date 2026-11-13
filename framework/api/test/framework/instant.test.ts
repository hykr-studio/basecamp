// A time from a query string is one Postgres can store, or none (docs/decisions/V1.md).
import { describe, expect, it } from 'vitest';
import { storableInstant } from '../../dist/infra/instant.js';

describe('storableInstant', () => {
  it('reads a time Postgres stores', () => {
    expect(storableInstant('2026-11-12T16:55:48.123Z')?.toISOString()).toBe(
      '2026-11-12T16:55:48.123Z',
    );
    expect(storableInstant('0001-01-01T00:00:00Z')?.getUTCFullYear()).toBe(1);
    expect(storableInstant('9999-12-31T23:59:59Z')?.getUTCFullYear()).toBe(9999);
  });

  it('refuses what JavaScript reads but Postgres has no room for, and what is no time', () => {
    // The year 0000 too, which `z.iso.datetime()` takes (V10).
    for (const text of [
      '99999',
      '-100000-01-01T00:00:00Z',
      '+010000-01-01T00:00:00Z',
      '0000-01-01T00:00:00Z',
      '0000-01-01',
      '9999-12-31T23:59:59-01:00',
    ])
      expect(storableInstant(text), text).toBeUndefined();
    for (const text of ['not-a-date', '', undefined, ['2026-01-01', '2026-01-02'], 5])
      expect(storableInstant(text), JSON.stringify(text)).toBeUndefined();
  });
});
