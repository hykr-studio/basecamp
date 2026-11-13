// What a job keeps of the error that stopped it, which its starter reads on `GET /api/jobs/:id`
// (docs/decisions/V10.md): never a database error's query and parameters, and only text
// Postgres can store, else the job's own row could not record it.
import { describe, expect, it } from 'vitest';
import { DATABASE_ERROR, told } from '../../dist/features/jobs/told.js';

describe('told', () => {
  it('keeps a database error’s query, parameters and row values out of what the starter reads', () => {
    // drizzle wraps the driver's error, and its message holds the SQL and every parameter.
    const driver = Object.assign(new Error('unsupported Unicode escape sequence'), {
      name: 'PostgresError',
      code: '22P05',
    });
    const wrapped = Object.assign(
      new Error(
        'Failed query: insert into "app"."import_batches" ("job_id") values ($1)\nparams: a,b',
      ),
      { name: 'DrizzleQueryError', cause: driver },
    );
    for (const e of [
      wrapped,
      driver,
      new Error('Failed query: select 1'),
      new Error('outer', { cause: driver }),
    ])
      expect(told(e)).toBe(DATABASE_ERROR);
  });

  it('keeps any other error’s message, as text Postgres can store', () => {
    expect(told(new Error('The service answered 503'))).toBe('The service answered 503');
    expect(told('plain words')).toBe('plain words');
    expect(told(new Error('a\u0000b'))).toBe('a�b');
    // Cut at 500 characters, through a surrogate pair: its first half alone is no character.
    const cut = told(new Error(`${'x'.repeat(499)}\u{1F600}`));
    expect(cut).toBe(`${'x'.repeat(499)}�`);
  });
});
