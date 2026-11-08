// Who is served an entity's SLA clocks at all, the SQL each branch's reach takes, and the list's
// keyset cursor, with no database: the reach itself is tested end to end
// (framework/api/test/framework/sla.e2e.test.ts).
import { type EntitySpec, type Expose, entitySpec, type Principal } from '@hykr/contracts';
import { PgDialect, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntity } from '../entity/define-entity.js';
import { listWhere } from '../query/aggregate.js';
import {
  clocksServed,
  decodeSlaCursor,
  encodeSlaCursor,
  reachSql,
  stateFieldHidden,
} from './sla-read.js';

const label = (en: string) => ({ en, hi: en, te: en });
const Row = z.object({ id: z.string(), title: z.string(), stage: z.string().optional() });

const specOf = (get: Expose, traits: EntitySpec['traits'] = {}) =>
  entitySpec({
    name: 'clocked',
    label: 'clocked record',
    description: 'Records with a clock.',
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 20, max: 100 } },
    expose: { list: 'all', get, create: 'all', update: 'all', delete: 'all' },
    traits: {
      states: {
        field: 'stage',
        initial: 'new',
        states: { new: { label: label('New') }, done: { label: label('Done'), terminal: true } },
        transitions: [{ name: 'finish', from: 'new', to: 'done' }],
        slas: [{ name: 'clocked.finish', state: 'new', within: '1h' }],
      },
      ...traits,
    },
  });

const person: Principal = {
  actor: { kind: 'user', id: 'ana' },
  subject: { kind: 'user', userId: 'ana' },
  tenantId: 't1',
  roles: ['staff'],
  scopes: [],
};
const assistant: Principal = { ...person, actor: { kind: 'agent', id: 'assistant' } };

describe('whose clocks are served', () => {
  it('people: wherever they may get the record; the assistant: only where get is exposed to it', () => {
    for (const p of [person, assistant])
      expect(clocksServed({ spec: specOf('all') }, p)).toBe(true);
    expect(clocksServed({ spec: specOf('human') }, person)).toBe(true);
    expect(clocksServed({ spec: specOf('human') }, assistant)).toBe(false);
  });

  it('nobody gets the clocks of an internal entity, whose records no route serves', () => {
    for (const p of [person, assistant])
      expect(clocksServed({ spec: specOf('internal') }, p)).toBe(false);
  });

  it("a field policy on the state field hides every record's state, so its clocks", () => {
    const spec = specOf('all', { fieldPolicy: { stage: 'clocked.stage.read' } });
    expect(stateFieldHidden({ spec }, person)).toBe(true);
    expect(stateFieldHidden({ spec }, assistant)).toBe(true);
    expect(stateFieldHidden({ spec }, { ...person, capabilities: ['clocked.stage.read'] })).toBe(
      false,
    );
    // A policy on another field leaves the state alone.
    const other = specOf('all', { fieldPolicy: { title: 'clocked.title.read' } });
    expect(stateFieldHidden({ spec: other }, person)).toBe(false);
    expect(stateFieldHidden({ spec: specOf('all') }, person)).toBe(false);
  });
});

describe("a branch's reach", () => {
  const rows = pgSchema('app').table('clocked_rows', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull(),
    stage: text('stage').notNull(),
  });
  const def = defineEntity(specOf('all'), {
    table: rows,
    owner: (t) => t.ownerId,
    access: { read: { staff: 'own' }, write: { staff: 'own' } },
  });
  const render = (q: ReturnType<typeof reachSql>) => new PgDialect().sqlToQuery(q);

  it('few records in reach: their timers by record, one array parameter', async () => {
    const where = await listWhere(def, person, { filters: [] });
    const q = render(reachSql({ def, where, ids: ['r1', 'r2'] }));
    expect(q.sql).toBe('"app"."sla_timers"."resource_id" = any($1::text[])');
    expect(q.params).toEqual([['r1', 'r2']]);
  });

  it("many: a fenced probe of the record per timer, under the entity's own list scope", async () => {
    const where = await listWhere(def, person, { filters: [] });
    const q = render(reachSql({ def, where }));
    expect(q.sql).toBe(
      'exists (select 1 from "app"."clocked_rows" where "app"."clocked_rows"."id" = ' +
        '"app"."sla_timers"."resource_id" and ("app"."clocked_rows"."tenant_id" = $1 and ' +
        '"app"."clocked_rows"."owner_id" = $2) offset 0)',
    );
    expect(q.params).toEqual(['t1', 'ana']);
  });
});

describe('the keyset cursor', () => {
  it('round-trips the due time to the microsecond and the id', () => {
    const c = { d: '2026-11-08T09:30:00.123456', i: 'b7c0f7f4-0c1e-4a8e-9f57-2f1c3d4e5a6b' };
    expect(decodeSlaCursor(encodeSlaCursor(c))).toEqual(c);
  });

  it('refuses anything else as 400 bad_cursor', () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      'not a cursor',
      enc(null),
      enc({ d: '2026-11-08T09:30:00.123', i: 'x' }),
      enc({ d: '2026-11-08T09:30:00.123456' }),
      enc({ d: '2026-11-08T09:30:00.123456', i: '' }),
      enc({ d: '2026-11-08T09:30:00.123456', i: 'x'.repeat(101) }),
      enc({ d: '2026-02-31T00:00:00.000000', i: 'x' }),
      enc({ d: '2026-13-01T00:00:00.000000', i: 'x' }),
      enc({ d: "2026-11-08T09:30:00.123456'; drop table x; --", i: 'x' }),
    ]) {
      let status = 0;
      let body: unknown;
      try {
        decodeSlaCursor(bad);
      } catch (e) {
        status = (e as { getStatus(): number }).getStatus();
        body = (e as { getResponse(): unknown }).getResponse();
      }
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'bad_cursor' });
    }
  });
});
