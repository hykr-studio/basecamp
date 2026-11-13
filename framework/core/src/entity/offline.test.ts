// Offline capture's pure parts (B12): reading `If-Match`, matching it against a record's version,
// and the create input that takes a client-chosen id.
import {
  createInputOf,
  entitySpec,
  etagOf,
  IfMatchError,
  ifMatchHolds,
  parseIfMatch,
  queuesOffline,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const base = {
  name: 'note',
  label: 'note',
  description: 'Notes.',
  schemas: {
    read: z.object({ id: z.string(), title: z.string(), version: z.number() }),
    create: z.object({ title: z.string() }).refine((v) => v.title !== 'no', 'Not that title'),
    update: z.object({ title: z.string().optional() }),
  },
  list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 10, max: 10 } },
} as const;
const offline = entitySpec({ ...base, traits: { offline: { writes: ['create'] }, versioned: {} } });
const plain = entitySpec(base);

describe('If-Match', () => {
  it('reads versions, weak tags, bare numbers, lists and *', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('  ')).toBeUndefined();
    expect(parseIfMatch('*')).toEqual({ any: true });
    expect(parseIfMatch('"3"')).toEqual({ versions: [3] });
    expect(parseIfMatch('W/"4", "5" ,6')).toEqual({ versions: [4, 5, 6] });
    expect(etagOf(7)).toBe('"7"');
  });

  it('refuses anything that is not a version', () => {
    for (const bad of ['abc', '"abc"', '"1.5"', 'W/3', '"-1"', '"1", x'])
      expect(() => parseIfMatch(bad), bad).toThrow(IfMatchError);
  });

  it("holds when the record's version is named, or for * on any record", () => {
    const row = { id: 'n', title: 't', version: 2 };
    expect(ifMatchHolds(offline, row, { versions: [1, 2] })).toBe(true);
    expect(ifMatchHolds(offline, row, { versions: [1] })).toBe(false);
    expect(ifMatchHolds(plain, row, { any: true })).toBe(true);
    // An entity without versions has nothing to match a tag against.
    expect(ifMatchHolds(plain, row, { versions: [2] })).toBe(false);
  });
});

describe('client-chosen ids', () => {
  it('an offline entity takes a UUID id on create, and keeps its own checks', () => {
    const input = createInputOf(offline);
    const id = '6f1c2b9e-1d3a-4c5b-8e7f-0a1b2c3d4e5f';
    expect(input.parse({ id, title: 'x' })).toEqual({ id, title: 'x' });
    expect(input.parse({ title: 'x' })).toEqual({ title: 'x' });
    expect(input.safeParse({ id: 'nope', title: 'x' }).success).toBe(false);
    expect(input.safeParse({ title: 'no' }).success).toBe(false);
    // The spec's own schema (tools, MCP) is unchanged.
    expect(offline.schemas.create.parse({ id, title: 'x' })).toEqual({ title: 'x' });
  });

  it('an entity without the trait drops an id', () => {
    expect(createInputOf(plain).parse({ id: 'x', title: 'y' })).toEqual({ title: 'y' });
  });

  it('queues only the writes the trait names', () => {
    expect(queuesOffline(offline, 'create')).toBe(true);
    expect(queuesOffline(offline, 'update')).toBe(false);
    expect(queuesOffline(plain, 'create')).toBe(false);
  });
});
