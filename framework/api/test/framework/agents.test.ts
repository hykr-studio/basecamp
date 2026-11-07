// Agents (A6), without a server: what a trigger means, and what a scope's run token reaches.
import { createCatalog } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  cronProblem,
  eventMatches,
  keptTriggers,
  messageMatches,
  movingValue,
  nextRun,
  resolveWhere,
  sameTrigger,
  scopesFor,
  triggerLabel,
  webhookMatches,
} from '../../dist/index.js';
import { tasksSpec, visitsSpec } from '../fixture/dist/contracts.js';

describe('schedules', () => {
  it('fire next in their zone', () => {
    // Monday 09:00 in Kolkata is 03:30 UTC.
    const from = new Date('2026-11-04T00:00:00Z'); // a Wednesday
    expect(nextRun('0 9 * * 1', 'Asia/Kolkata', from)?.toISOString()).toBe(
      '2026-11-09T03:30:00.000Z',
    );
    expect(nextRun('0 9 * * 1', 'UTC', from)?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('refuse a bad pattern, a bad zone, and more often than every 5 minutes', () => {
    expect(cronProblem('0 9 * * 1', 'Asia/Kolkata')).toBeNull();
    expect(cronProblem('*/5 * * * *', 'UTC')).toBeNull();
    expect(cronProblem('* * * * *', 'UTC')).toMatch(/more often than every 5 minutes/);
    expect(cronProblem('*/2 9 * * *', 'UTC')).toMatch(/more often/);
    expect(cronProblem('nonsense', 'UTC')).toMatch(/is not a schedule/);
    expect(cronProblem('0 9 * * 1', 'Nowhere/Here')).toMatch(/is not a time zone/);
  });
});

describe('conditions', () => {
  it('move $now and $today with time, in the business’s zone', () => {
    const now = new Date('2026-11-07T20:00:00Z'); // already the 8th in Kolkata
    expect(movingValue('$today', now, 'Asia/Kolkata')).toBe('2026-11-08');
    expect(movingValue('$today', now, 'UTC')).toBe('2026-11-07');
    expect(movingValue('$today-7d', now, 'UTC')).toBe('2026-10-31');
    expect(movingValue('$now-2h', now, 'UTC')).toBe('2026-11-07T18:00:00.000Z');
    expect(
      resolveWhere({ done: false, dueOn: { lt: '$today' }, tags: ['$now'] }, now, 'UTC'),
    ).toEqual({ done: false, dueOn: { lt: '2026-11-07' }, tags: ['2026-11-07T20:00:00.000Z'] });
    // Anything else stays as written.
    expect(resolveWhere({ title: '$todays' }, now, 'UTC')).toEqual({ title: '$todays' });
  });
});

describe('matching', () => {
  it('events by name or prefix, and the record’s fields', () => {
    const t = { kind: 'event' as const, on: ['task.*'], where: { done: false } };
    expect(eventMatches(t, { name: 'task.created' }, { done: false })).toBe(true);
    expect(eventMatches(t, { name: 'task.created' }, { done: true })).toBe(false);
    expect(eventMatches(t, { name: 'tasks.created' }, { done: false })).toBe(false);
    expect(eventMatches({ kind: 'event', on: ['*'] }, { name: 'x.y' }, null)).toBe(true);
  });

  it('messages by any of their words, in any case', () => {
    expect(messageMatches({ kind: 'message' }, 'anything')).toBe(true);
    expect(messageMatches({ kind: 'message', contains: ['price', 'rate'] }, 'The RATE?')).toBe(
      true,
    );
    expect(messageMatches({ kind: 'message', contains: ['price'] }, 'hello')).toBe(false);
  });

  it('webhooks by connection and type', () => {
    const t = { kind: 'webhook' as const, connectionId: 'c1', on: ['parcel.*'] };
    expect(webhookMatches(t, 'c1', 'parcel.arrived')).toBe(true);
    expect(webhookMatches(t, 'c2', 'parcel.arrived')).toBe(false);
    expect(webhookMatches(t, 'c1', 'invoice.paid')).toBe(false);
  });

  it('say what started a run', () => {
    expect(triggerLabel({ kind: 'recurring', cron: '0 9 * * 1' })).toBe(
      'on the schedule "0 9 * * 1"',
    );
    expect(triggerLabel({ kind: 'manual' })).toBe('run now');
  });
});

describe('an edited trigger', () => {
  it('is the same whatever order its keys come back in (jsonb sorts them its own way)', () => {
    const condition = {
      kind: 'condition' as const,
      entity: 'task',
      where: { title: { contains: 'x' }, done: false },
      everyMinutes: 5,
    };
    // As Postgres gives jsonb back: shorter keys first, at every level.
    const stored = JSON.parse(
      '{"kind":"condition","where":{"done":false,"title":{"contains":"x"}},"entity":"task","everyMinutes":5}',
    );
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(condition));
    expect(sameTrigger(stored, condition)).toBe(true);
    expect(
      sameTrigger(
        { at: '2026-12-01T09:00:00Z', kind: 'once' },
        {
          kind: 'once',
          at: '2026-12-01T09:00:00Z',
        },
      ),
    ).toBe(true);
    expect(
      sameTrigger(
        { cron: '0 9 * * 1', kind: 'recurring' },
        {
          kind: 'recurring',
          cron: '0 9 * * 1',
        },
      ),
    ).toBe(true);
    // A default the schema adds is the same as one written out.
    expect(
      sameTrigger(
        { kind: 'condition', entity: 'task', where: {} },
        {
          kind: 'condition',
          entity: 'task',
          where: {},
          everyMinutes: 15,
        },
      ),
    ).toBe(true);
  });

  it('changed: another value, another order of a list, or a spec the schema no longer reads', () => {
    const t = { kind: 'event' as const, on: ['task.created', 'task.updated'] };
    expect(sameTrigger({ kind: 'event', on: ['task.updated', 'task.created'] }, t)).toBe(false);
    expect(sameTrigger({ kind: 'event', on: ['task.created'] }, t)).toBe(false);
    expect(sameTrigger({ kind: 'mention' }, t)).toBe(false);
    expect(sameTrigger({ kind: 'event', on: [], extra: 1 }, t)).toBe(false);
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });

  it('keeps its row wherever it moved, its own position first, each row once', () => {
    const once = { kind: 'once' as const, at: '2026-12-01T09:00:00Z' };
    const mention = { kind: 'mention' as const };
    const rows = [
      { id: 'a', position: 0, spec: { kind: 'mention' } },
      { id: 'b', position: 1, spec: { at: '2026-12-01T09:00:00Z', kind: 'once' } },
      { id: 'c', position: 2, spec: { kind: 'mention' } },
    ];
    const ids = (t: Parameters<typeof keptTriggers>[1]) =>
      keptTriggers(rows, t).map((r) => r?.id ?? null);
    expect(ids([mention, once, mention])).toEqual(['a', 'b', 'c']);
    // The first trigger removed: the others move up and keep theirs.
    expect(ids([once, mention])).toEqual(['b', 'a']);
    // A mention where the time was is new (the others keep their own); a changed time is new.
    expect(ids([mention, mention, mention])).toEqual(['a', null, 'c']);
    expect(ids([{ ...once, at: '2026-12-02T09:00:00Z' }, mention])).toEqual([null, 'a']);
    // A row at its own position stays there; an earlier trigger takes another.
    const moved = [
      { id: 'x', position: 0, spec: once },
      { id: 'y', position: 1, spec: mention },
      { id: 'z', position: 2, spec: mention },
    ];
    expect(keptTriggers(moved, [mention, mention]).map((r) => r?.id)).toEqual(['z', 'y']);
  });
});

describe('a scope', () => {
  it('reaches the entities and operations of its generated tools, never the agents’', () => {
    const catalog = createCatalog(tasksSpec, visitsSpec);
    const scopes = scopesFor(
      ['list-tasks', 'delete-task', 'reschedule-visit', 'create-agent'],
      catalog,
    );
    expect(scopes.sort()).toEqual(
      [
        'agent-run',
        'agent-run.read:task',
        'agent-run.write:task.delete',
        'agent-run.write:visit.reschedule',
      ].sort(),
    );
    // Nothing at all: it reads and writes nothing through the entities.
    expect(scopesFor([], catalog)).toEqual(['agent-run']);
  });
});
