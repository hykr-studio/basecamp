import { describe, expect, it } from 'vitest';
import { importArgs } from './import-args.js';

describe('basecamp import options', () => {
  it('needs an entity, a file and who imports', () => {
    expect(() => importArgs([], { as: 'a@b.c' })).toThrow(/usage/);
    expect(() => importArgs(['todo'], { as: 'a@b.c' })).toThrow(/usage/);
    expect(() => importArgs(['todo', 'todos.csv'], {})).toThrow(/--as/);
  });

  it('reads every option', () => {
    expect(
      importArgs(['todo', 'todos.csv'], {
        as: 'ana@example.com',
        tenant: 't1',
        'dry-run': true,
        key: 'legacy_id',
        source: 'old-crm',
        format: 'csv',
        existing: 'skip',
        empty: 'null',
        map: ['Title=title', 'Notes='],
        ref: ['meetingId=meeting'],
        report: 'out.csv',
      }),
    ).toEqual({
      entity: 'todo',
      path: 'todos.csv',
      as: 'ana@example.com',
      tenant: 't1',
      dryRun: true,
      key: 'legacy_id',
      source: 'old-crm',
      format: 'csv',
      existing: 'skip',
      empty: 'null',
      columns: { Title: 'title', Notes: null },
      refs: { meetingId: 'meeting' },
      report: 'out.csv',
    });
  });

  it('leaves out what is not given', () => {
    expect(importArgs(['todo', 'todos.csv'], { as: 'a@b.c', 'dry-run': false })).toEqual({
      entity: 'todo',
      path: 'todos.csv',
      as: 'a@b.c',
      dryRun: false,
    });
  });

  it('refuses a value outside its choices, and a pair without its parts', () => {
    expect(() => importArgs(['todo', 'f'], { as: 'a@b.c', format: 'xlsx' })).toThrow(/--format/);
    expect(() => importArgs(['todo', 'f'], { as: 'a@b.c', existing: 'merge' })).toThrow(
      /--existing/,
    );
    expect(() => importArgs(['todo', 'f'], { as: 'a@b.c', empty: 'zero' })).toThrow(/--empty/);
    expect(() => importArgs(['todo', 'f'], { as: 'a@b.c', map: ['title'] })).toThrow(/--map/);
    expect(() => importArgs(['todo', 'f'], { as: 'a@b.c', ref: ['meetingId='] })).toThrow(/--ref/);
  });
});
