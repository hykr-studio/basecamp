// State machines, business time and versions (B6, B4): the pure parts, from @hykr/contracts,
// and the two entity plugins' decisions.
import {
  addBusinessTime,
  BusinessHours,
  businessTimeBetween,
  canMove,
  checkStates,
  checkVersioned,
  diffFields,
  diffLists,
  durationMs,
  entitySpec,
  isFrozen,
  type Principal,
  SlaSettings,
  type StatesTrait,
  stateLabel,
  transitionsFrom,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { statesPlugin } from '../plugins/states.js';
import { versionedPlugin } from '../plugins/versioned.js';

const label = (en: string) => ({ en, hi: en, te: en });

const machine: StatesTrait = {
  field: 'status',
  initial: 'draft',
  states: {
    draft: {},
    sent: { label: label('Sent out') },
    done: { terminal: true },
  },
  transitions: [
    { name: 'send', from: 'draft', to: 'sent' },
    {
      name: 'finish',
      from: ['draft', 'sent'],
      to: 'done',
      requires: ['reason'],
      fields: ['reason'],
    },
  ],
  slas: [
    { name: 'unit.reply', state: 'sent', within: '4h', escalate: { notify: ['unit.decide'] } },
  ],
};

const specWith = (states: StatesTrait, versioned?: object) =>
  entitySpec({
    name: 'record',
    label: 'record',
    description: 'Records.',
    schemas: {
      read: z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
        version: z.number(),
      }),
      create: z.object({ title: z.string() }),
      update: z.object({
        title: z.string().optional(),
        status: z.string().optional(),
        reason: z.string().optional(),
        note: z.string().optional(),
      }),
    },
    list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 10, max: 10 } },
    traits: { states, ...(versioned ? { versioned } : {}) },
  });

describe('a state machine', () => {
  it('lists the moves out of a state, and knows which moves exist', () => {
    expect(transitionsFrom(machine, 'draft').map((t) => t.name)).toEqual(['send', 'finish']);
    expect(transitionsFrom(machine, 'done')).toEqual([]);
    expect(canMove(machine, 'sent', 'done')).toBe(true);
    expect(canMove(machine, 'done', 'draft')).toBe(false);
  });

  it('names a state by its label, or its name made readable', () => {
    expect(stateLabel(machine, 'sent', 'en')).toBe('Sent out');
    expect(stateLabel(machine, 'awaiting_reply', 'en')).toBe('Awaiting reply');
  });

  it('accepts a sound machine', () => {
    expect(() => checkStates(specWith(machine))).not.toThrow();
  });

  it('refuses every problem at once: unknown states, repeats, terminal exits, bad SLAs', () => {
    const bad: StatesTrait = {
      ...machine,
      initial: 'nowhere',
      transitions: [
        { name: 'send', from: 'draft', to: 'sent' },
        { name: 'send', from: 'draft', to: 'gone' },
        { name: 'undo', from: 'done', to: 'draft' },
        { name: 'set', from: 'draft', to: 'sent', fields: ['status', 'missing'], requires: ['x'] },
      ],
      slas: [
        { name: 'unit.reply', state: 'nowhere', within: '4h' },
        { name: 'unit.late', state: 'sent', within: '4d' as never },
        { name: 'unit.out', state: 'sent', within: '1h', escalate: { transition: 'send' } },
      ],
    };
    let message = '';
    try {
      checkStates(specWith(bad));
    } catch (e) {
      message = (e as Error).message;
    }
    for (const part of [
      'initial state "nowhere"',
      '"send" is declared twice',
      'names "gone"',
      'leaves "done", a terminal state',
      'may not set the state field',
      'sets "missing", not in the update schema',
      'requires "x"',
      'runs in "nowhere"',
      'is not a duration',
      'which does not leave "sent"',
    ])
      expect(message).toContain(part);
  });

  it('reads durations, and refuses anything else', () => {
    expect(durationMs('30m')).toBe(1_800_000);
    expect(durationMs('1.5h')).toBe(5_400_000);
    expect(durationMs(1000)).toBe(1000);
    expect(() => durationMs('2d' as never)).toThrow();
    expect(() => durationMs(0)).toThrow();
  });
});

describe('business time', () => {
  // 2026-11-06 is a Friday.
  const hours = BusinessHours.parse({
    week: Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [{ from: '09:00', to: '17:00' }]]),
    ),
  });
  const open = { week: hours.week, holidays: [] };
  const H = 3_600_000;

  it('counts every hour without a working week', () => {
    const start = new Date('2026-11-06T16:00:00Z');
    expect(addBusinessTime(start, 2 * H, undefined, 'UTC').toISOString()).toBe(
      '2026-11-06T18:00:00.000Z',
    );
  });

  it('skips nights and the weekend', () => {
    const friday = new Date('2026-11-06T16:00:00Z');
    expect(addBusinessTime(friday, 2 * H, open, 'UTC').toISOString()).toBe(
      '2026-11-09T10:00:00.000Z',
    );
    const saturday = new Date('2026-11-07T12:00:00Z');
    expect(addBusinessTime(saturday, 2 * H, open, 'UTC').toISOString()).toBe(
      '2026-11-09T11:00:00.000Z',
    );
    expect(businessTimeBetween(friday, new Date('2026-11-09T10:00:00Z'), open, 'UTC')).toBe(2 * H);
  });

  it('skips holidays', () => {
    const friday = new Date('2026-11-06T16:00:00Z');
    const off = { ...open, holidays: ['2026-11-09'] };
    expect(addBusinessTime(friday, 2 * H, off, 'UTC').toISOString()).toBe(
      '2026-11-10T10:00:00.000Z',
    );
  });

  it("counts in the business's own time zone", () => {
    // 17:30 on a Friday in Kolkata (UTC+5:30), open 09:00 to 18:00.
    const week = Object.fromEntries(
      ['mon', 'fri'].map((d) => [d, [{ from: '09:00', to: '18:00' }]]),
    );
    const start = new Date('2026-11-06T12:00:00Z');
    expect(addBusinessTime(start, H, { week }, 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-09T04:00:00.000Z',
    );
  });

  it('a day that loses an hour to summer time counts 23', () => {
    const week = { sun: [{ from: '00:00', to: '24:00' }] };
    const start = new Date('2026-03-29T00:00:00Z');
    expect(addBusinessTime(start, 23 * H, { week }, 'Europe/London').toISOString()).toBe(
      '2026-03-29T23:00:00.000Z',
    );
  });

  it('refuses a working week with no open hour, and a backwards interval', () => {
    expect(BusinessHours.safeParse({ week: { mon: [] } }).success).toBe(false);
    expect(
      BusinessHours.safeParse({ week: { mon: [{ from: '18:00', to: '09:00' }] } }).success,
    ).toBe(false);
    expect(SlaSettings.safeParse({ within: { 'unit.reply': '3d' } }).success).toBe(false);
    expect(SlaSettings.parse(undefined)).toEqual({ within: {}, off: [] });
  });
});

describe('versions', () => {
  const trait = { frozenWhen: { status: ['sent', 'done'] }, editableWhenFrozen: ['note'] };
  const spec = specWith(machine, trait);
  const target = { spec, table: {} as never };
  const p = { actor: { kind: 'user', id: 'u' }, roles: ['owner'] } as unknown as Principal;
  const row = { id: 'r', title: 'A', status: 'sent', reason: null, version: 3 };

  it('knows when a record is frozen', () => {
    expect(isFrozen(trait, row)).toBe(true);
    expect(isFrozen(trait, { ...row, status: 'draft' })).toBe(false);
    expect(isFrozen(undefined, row)).toBe(false);
    expect(() => checkVersioned(spec)).not.toThrow();
  });

  it('refuses a change to a frozen record, but not its state or its editable fields', () => {
    const decide = (action: 'update' | 'delete', input: Record<string, unknown> | null) =>
      versionedPlugin.decide?.(p, action, row, input, target) ?? null;
    expect(decide('update', { title: 'B' })).toMatchObject({
      decision: 'deny',
      rule: 'record_frozen',
    });
    expect(decide('delete', null)).toMatchObject({ rule: 'record_frozen' });
    expect(decide('update', { note: 'ok', title: 'A' })).toBeNull();
    expect(decide('update', { status: 'done', reason: 'Finished' })).toBeNull();
  });

  it('pins the version a parked write saw, and refuses a replay once it moved on', () => {
    const pinned = versionedPlugin.onPark?.(row, target) as Record<string, unknown>;
    expect(pinned).toEqual({ version: 3 });
    expect(versionedPlugin.onReplay?.(row, pinned, target)).toBeNull();
    expect(versionedPlugin.onReplay?.({ ...row, version: 4 }, pinned, target)).toMatchObject({
      error: 'stale',
    });
  });

  it('compares two revisions field by field, and their lines by a key', () => {
    expect(
      diffFields(
        { id: '1', title: 'A', total: 5, version: 2, createdAt: 'x' },
        { id: '2', title: 'A', total: 7, version: 1, createdAt: 'y' },
      ),
    ).toEqual([{ field: 'total', before: 5, after: 7 }]);
    const d = diffLists(
      [
        { id: 'a', title: 'Tile', qty: 1 },
        { id: 'b', title: 'Sink', qty: 1 },
      ],
      [
        { id: 'c', title: 'Tile', qty: 2 },
        { id: 'd', title: 'Tap', qty: 1 },
      ],
      (x) => String(x.title),
    );
    expect(d.added.map((x) => x.title)).toEqual(['Tap']);
    expect(d.removed.map((x) => x.title)).toEqual(['Sink']);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields).toEqual([{ field: 'qty', before: 1, after: 2 }]);
  });
});

describe('the states plugin', () => {
  const spec = specWith(machine);
  const target = { spec, table: {} as never };
  const p = { actor: { kind: 'user', id: 'u' }, roles: ['owner'] } as unknown as Principal;

  it('a create starts in the initial state; plain CRUD never moves it', () => {
    expect(statesPlugin.decide?.(p, 'create', null, { status: 'sent' }, target)).toMatchObject({
      rule: 'state_initial',
    });
    expect(statesPlugin.decide?.(p, 'create', null, { title: 'A' }, target)).toBeNull();
    const row = { id: 'r', status: 'draft' };
    expect(statesPlugin.decide?.(p, 'update', row, { status: 'sent' }, target)).toMatchObject({
      rule: 'state_through_transition',
    });
    expect(
      statesPlugin.decide?.(p, 'update', row, { status: 'draft', title: 'B' }, target),
    ).toBeNull();
  });

  it("a command's write moves it only along a declared transition", () => {
    const write = (row: Record<string, unknown>, input: Record<string, unknown>) =>
      statesPlugin.toValues?.(input, { p, action: 'update', row, input }, target);
    expect(write({ status: 'draft' }, { status: 'sent' })).toEqual({ status: 'sent' });
    expect(() => write({ status: 'done' }, { status: 'draft' })).toThrow();
    expect(
      statesPlugin.toValues?.(
        { title: 'A' },
        { p, action: 'create', row: null, input: {} },
        target,
      ),
    ).toEqual({ title: 'A', status: 'draft' });
  });
});
