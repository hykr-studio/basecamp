// The registry, with no domain: a tiny entity and views declared here, so these checks pass
// whatever domain the app ships with. The domain's own views are tested in domain/.
import { entitySpec, type PageSpec } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineScreen, defineView, spokenList, type ViewLabels } from './define-view.js';
import { createRegistry } from './registry.js';

const Item = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  dueOn: z.iso.date().nullable(),
});
const ItemSpec = entitySpec({
  name: 'item',
  label: 'item',
  description: 'Test items.',
  schemas: { read: Item, create: Item.omit({ id: true }), update: Item.partial() },
  list: {
    filterable: { done: 'boolean', dueOn: 'date' },
    sortable: ['dueOn'],
    defaultSort: [['dueOn', 'asc']],
    pageSize: { default: 20, max: 100 },
  },
});

const itemLabels = {
  empty: { en: 'No items.', hi: 'कोई आइटम नहीं।', te: 'ఐటమ్‌లు లేవు.' },
  noun: { en: ['item', 'items'], hi: ['आइटम', 'आइटम'], te: ['ఐటమ్', 'ఐటమ్‌లు'] },
} satisfies ViewLabels;
const ItemList = defineView({
  name: 'item.list',
  description: 'Items.',
  surfaces: ['inline', 'canvas', 'text', 'speech'],
  props: z.object({ title: z.string().optional(), items: z.array(Item) }),
  source: { entity: ItemSpec, into: 'items' },
  labels: itemLabels,
  text: (p) => p.items.map((i) => `• ${i.title}`).join('\n'),
  speak: (p, ctx) =>
    spokenList(
      p.items.map((i) => i.title),
      itemLabels,
      ctx,
    ),
});
const ItemWeek = defineView({
  name: 'item.week',
  description: 'Items by day; wide.',
  surfaces: ['canvas'],
  props: z.object({ items: z.array(Item) }),
  source: { entity: ItemSpec, into: 'items' },
  collapseTo: 'item.list',
  text: () => '',
  speak: () => '',
});
const Confirm = defineView({
  name: 'confirm.card',
  description: 'Inline only.',
  surfaces: ['inline', 'text'],
  props: z.object({ id: z.string() }),
  text: () => 'Waiting.',
  speak: () => 'Waiting.',
});
const ItemScreen = defineScreen({
  name: 'item.detail',
  title: 'item',
  description: 'One item.',
  params: z.object({ id: z.uuid() }),
});

const registry = createRegistry({
  views: [ItemList, ItemWeek, Confirm] as never,
  screens: [ItemScreen] as never,
});
const page: PageSpec = {
  title: 'Board',
  layout: 'two-column',
  blocks: [
    { id: 'week', view: 'item.week', query: { sort: 'dueOn' }, span: 'full' },
    { id: 'open', view: 'item.list', query: { done: false }, span: 'half' },
  ],
};

describe('checkPresent', () => {
  const inline = {
    kind: 'inline' as const,
    view: 'item.list',
    query: { done: false, dueOn: { lte: '2026-10-12' } },
  };

  it('passes a valid intent through on a surface that draws components', () => {
    expect(registry.checkPresent(inline, ['inline', 'canvas'])).toEqual({
      kind: 'show',
      present: inline,
    });
  });

  it('drops it where only words can be shown, keeping the data for the model', () => {
    expect(registry.checkPresent(inline, ['text']).kind).toBe('drop');
  });

  it('refuses unknown views and queries outside the entity list grammar', () => {
    expect(registry.checkPresent({ kind: 'inline', view: 'user.table' }, ['inline']).kind).toBe(
      'error',
    );
    const bad = registry.checkPresent(
      { kind: 'inline', view: 'item.list', query: { ownerId: 'x' } },
      ['inline'],
    );
    expect(bad).toMatchObject({ kind: 'error' });
  });

  it('opens only registered screens with valid params, and only with a canvas', () => {
    const open = {
      kind: 'open' as const,
      screen: 'item.detail',
      params: { id: crypto.randomUUID() },
    };
    expect(registry.checkPresent(open, ['inline', 'canvas']).kind).toBe('show');
    expect(registry.checkPresent(open, ['inline']).kind).toBe('drop');
    expect(
      registry.checkPresent({ ...open, params: { id: 'nope' } }, ['inline', 'canvas']).kind,
    ).toBe('error');
    expect(
      registry.checkPresent({ ...open, screen: 'admin.users' }, ['inline', 'canvas']).kind,
    ).toBe('error');
  });

  it('patches a block of the open page, and needs one', () => {
    const patch = {
      kind: 'patch' as const,
      blockId: 'open',
      query: { done: false, dueOn: { lt: '2026-10-07' } },
    };
    expect(registry.checkPresent(patch, ['inline', 'canvas'], page).kind).toBe('show');
    expect(registry.checkPresent(patch, ['inline', 'canvas']).kind).toBe('error');
    expect(
      registry.checkPresent({ ...patch, blockId: 'nope' }, ['inline', 'canvas'], page).kind,
    ).toBe('error');
  });
});

describe('pages', () => {
  it('accept canvas views with valid queries', () => {
    expect(registry.checkPage(page)).toEqual([]);
  });

  it('refuse views that cannot be on a page, and bad queries', () => {
    const errors = registry.checkPage({
      ...page,
      blocks: [
        { id: 'a', view: 'confirm.card', props: { id: 'x' }, span: 'half' },
        { id: 'b', view: 'item.list', query: { owner: 'x' }, span: 'half' },
      ],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('cannot be shown on a page');
  });

  it('patch one block: query replaced, the others untouched', () => {
    const next = registry.applyPatch(page, { blockId: 'open', query: { done: true } });
    if (typeof next === 'string') throw new Error(next);
    expect(next.blocks[1].query).toEqual({ done: true });
    expect(next.blocks[0]).toBe(page.blocks[0]);
  });
});

describe('createRegistry', () => {
  it('knows only the views it was given: the framework is not tied to a domain', () => {
    const empty = createRegistry({ views: [], screens: [] });
    expect(empty.checkPresent({ kind: 'inline', view: 'item.list' }, ['inline']).kind).toBe(
      'error',
    );
    expect(registry.getViewDef('item.list')).toBe(ItemList);
  });

  it('speaks a list in the turn’s language, from its labels', () => {
    const items = ['Tiles', 'Grout'].map((title) => ({
      id: title,
      title,
      done: false,
      dueOn: null,
    }));
    expect(ItemList.speak({ items }, { timeZone: 'UTC', lang: 'en' })).toBe(
      '2 items: Tiles, Grout.',
    );
    expect(ItemList.speak({ items }, { timeZone: 'UTC', lang: 'te' })).toBe(
      '2 ఐటమ్‌లు: Tiles, Grout.',
    );
    expect(ItemList.speak({ items: [] }, { timeZone: 'UTC', lang: 'hi' })).toBe('कोई आइटम नहीं।');
  });

  it('refuses a spoken list without the words to speak it', () => {
    const mute = defineView({ ...ItemList, name: 'item.mute', labels: {} });
    expect(() => createRegistry({ views: [mute] as never, screens: [] })).toThrow(
      /spoken list: give it labels.noun and labels.empty/,
    );
  });

  it('refuses a collapse to a view it does not have', () => {
    expect(() => createRegistry({ views: [ItemWeek] as never, screens: [] })).toThrow(
      /collapses to an unknown view/,
    );
  });

  it('lists the views for a surface, for tool descriptions', () => {
    expect(registry.catalog('canvas')).toContain('item.week (items query)');
    expect(registry.catalog('canvas')).not.toContain('confirm.card');
  });
});
