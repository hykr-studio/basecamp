// Money, number series, tax lines and records with a parent (B3, B5), on neutral data: a
// `baskets` module whose baskets hold a tree of items (groups and lines), saved whole by one
// command. Only the money and line-items tests boot this server (`lineItems`).
import { defineModule, defineServer } from '@hykr/api';
import {
  applyTax,
  buildTree,
  CreatedBy,
  CurrencyCode,
  commandSpec,
  defineNumberSeries,
  defineTaxFunction,
  entitySpec,
  Money,
  MoneyInput,
  moduleSpec,
  mulDiv,
  type Principal,
  resolveMoneyInput,
  sumMoney,
  type TreeNode,
} from '@hykr/contracts';
import {
  allow,
  type ChildNode,
  commandController,
  commandHandler,
  defineChildEntity,
  defineCommand,
  defineEntity,
  deny,
  entityController,
  entityHandlers,
  type NamedEvent,
  needsApproval,
  nextNumber,
  type ReadProjector,
  tenantMoney,
  tenantOf,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { basketItems, baskets } from './schema.js';

const title = z.string().min(1).max(300);

export const Basket = z.object({
  id: z.string(),
  number: z.string().nullable(),
  title,
  status: z.enum(['open', 'void']),
  currency: CurrencyCode,
  total: Money,
  taxTotal: Money,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const BasketSpec = entitySpec({
  name: 'basket',
  label: 'basket',
  description: 'Baskets: a title, a total in minor units, a number when saved whole.',
  schemas: {
    read: Basket,
    create: z.object({
      title,
      currency: CurrencyCode.optional(),
      total: MoneyInput.optional(),
      taxTotal: MoneyInput.optional(),
      number: z.string().optional(),
    }),
    update: z.object({
      title: title.optional(),
      currency: CurrencyCode.optional(),
      total: MoneyInput.optional(),
      taxTotal: MoneyInput.optional(),
      status: z.enum(['open', 'void']).optional(),
    }),
  },
  list: {
    filterable: { total: 'money', status: 'enum' },
    sortable: ['createdAt', 'total'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  traits: { money: { fields: ['total', 'taxTotal'] } },
});

export const BasketItem = z.object({
  id: z.string(),
  basketId: z.string(),
  parentItemId: z.string().nullable(),
  position: z.number().int(),
  title,
  quantity: z.number().int(),
  currency: CurrencyCode,
  price: Money.nullable(),
  cost: Money.nullable().optional(),
  amount: Money,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

const itemFields = {
  title,
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  price: MoneyInput.nullable().optional(),
  cost: MoneyInput.nullable().optional(),
  amount: MoneyInput.optional(),
};

export const BasketItemSpec = entitySpec({
  name: 'basketItem',
  label: 'basket item',
  description: 'The items of a basket: groups and priced lines, in a tree.',
  schemas: {
    read: BasketItem,
    create: z.object(itemFields),
    update: z.object({
      ...itemFields,
      title: title.optional(),
      parentItemId: z.string().nullable().optional(),
      position: z.number().int().min(0).optional(),
      basketId: z.string().optional(),
    }),
  },
  list: {
    filterable: { basketId: 'id', amount: 'money' },
    sortable: ['position', 'createdAt'],
    defaultSort: [['position', 'asc']],
    pageSize: { default: 100, max: 1000 },
  },
  traits: {
    money: { fields: ['price', 'cost', 'amount'] },
    parent: { entity: 'basket', field: 'basketId', nest: 'parentItemId', position: 'position' },
  },
});

/** A basket's tree as a save sends it: flat, each node naming the node above by its ref. */
export const SaveItemInput = z.object({
  ref: z.string().min(1).max(40),
  parent: z.string().min(1).max(40).optional(),
  id: z.uuid().optional(),
  title,
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  price: MoneyInput.optional(),
  cost: MoneyInput.optional(),
});

export const SaveBasketSpec = commandSpec({
  name: 'basket.save',
  description: 'Save a whole basket: its title and every item, groups and lines, in one go.',
  input: z.object({
    basketId: z.uuid().optional(),
    title,
    currency: CurrencyCode.optional(),
    items: z.array(SaveItemInput).max(1000),
  }),
  output: z.object({ basket: Basket, items: z.array(BasketItem) }),
  http: { method: 'POST', path: '/api/baskets/save' },
  tool: 'save-basket',
  expose: 'all',
  touches: ['basket', 'basketItem'],
});

const ACCESS: Access = {
  read: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
  write: { owner: 'own', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

/** The basket series: a fiscal-year counter, "B2026-27-001". */
export const BasketSeries = defineNumberSeries({
  name: 'fixture.basket',
  format: 'B{fy}-{seq:3}',
  reset: 'fiscal',
});

/** Declared but never registered: nextNumber refuses it. */
export const UnregisteredSeries = defineNumberSeries({
  name: 'fixture.unregistered',
  format: 'U{seq}',
  reset: 'none',
});

type Priced = { amount: Money };

/** The fixture's own tax: one flat 10% levy on every line, rounded half up. */
export const flatLevy = defineTaxFunction<Priced>({
  name: 'fixture.flat-levy',
  compute: (lines, { currency }) => {
    if (lines.length === 0) return [];
    const basis = sumMoney(
      lines.map((l) => l.amount),
      currency,
    );
    return [
      {
        code: 'levy',
        label: 'Levy',
        basis,
        rateBp: 1000,
        amount: { minor: mulDiv(basis.minor, 1000, 10_000), currency },
      },
    ];
  },
});

export const BasketDef = defineEntity(BasketSpec, {
  table: baskets,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  rules: [
    // Numbers come from the series, through a save.
    (_p, _action, _row, input, ctx) =>
      input?.number !== undefined && ctx.via !== 'basket.save'
        ? deny('number_by_save', 'A basket gets its number when it is saved whole')
        : null,
  ],
});

export const BasketItemDef = defineChildEntity(BasketItemSpec, {
  table: basketItems,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
  parent: { def: BasketDef, owner: (t) => t.ownerId, customer: (t) => t.customerId },
  rules: [
    // An item's own rule, which a save runs for every new item.
    (_p, action, _row, input) =>
      action === 'create' && String(input?.title ?? '').startsWith('[refuse]')
        ? deny('item_refused', 'This item is refused')
        : null,
  ],
});

/** basket.saved: a command's event. */
export class BasketSaved implements NamedEvent {
  readonly eventName = 'basket.saved';
  constructor(readonly row: unknown) {}
}

type SaveItem = z.infer<typeof SaveItemInput>;

/** The flat items as a tree of child nodes, with each line's amount and each group's sum. */
function priced(items: readonly SaveItem[], currency: string) {
  const tree = buildTree(items, { key: 'ref', parent: 'parent' });
  const leaves: Priced[] = [];
  const toNode = (n: TreeNode<SaveItem>): ChildNode & { amount: Money } => {
    const children = n.children.map(toNode);
    const price = n.price === undefined ? null : resolveMoneyInput(n.price, currency);
    const cost = n.cost === undefined ? null : resolveMoneyInput(n.cost, currency);
    const quantity = n.quantity ?? 1;
    const amount = children.length
      ? sumMoney(
          children.map((c) => c.amount),
          currency,
        )
      : { minor: mulDiv(price?.minor ?? 0, quantity, 1), currency };
    if (!children.length) leaves.push({ amount });
    return {
      ...(n.id ? { id: n.id } : {}),
      title: n.title,
      quantity,
      price,
      cost,
      amount,
      children,
    };
  };
  const nodes = tree.map(toNode);
  return { nodes, totals: applyTax(flatLevy, leaves, { currency }) };
}

export const SaveBasket = defineCommand(SaveBasketSpec, {
  resource: { type: 'basket', id: (input) => input.basketId ?? null },
  load: async (tx, p, input) => ({
    basket: input.basketId ? await BasketDef.repo.get(tx, p, input.basketId) : null,
    money: await tenantMoney(tx, tenantOf(p)),
  }),
  authorize: (p, { basket }) => {
    if (basket?.status === 'void') return deny('basket_void', 'This basket is void');
    return p.actor.kind === 'agent'
      ? needsApproval('agent_saves', 'Baskets the assistant saves need approval')
      : allow('person_saves');
  },
  summarize: (input) => `Save ${input.title} with ${input.items.length} items`,
  run: async ({ tx, principal, input, loaded, via }) => {
    const currency = loaded.basket?.currency ?? input.currency ?? loaded.money.currency;
    const { nodes, totals } = priced(input.items, currency);
    const money = { total: totals.total, taxTotal: totals.taxTotal };
    let basket: typeof baskets.$inferSelect;
    let change: 'created' | 'updated';
    if (loaded.basket) {
      basket = await BasketDef.repo.update(
        tx,
        principal,
        loaded.basket,
        { title: input.title, ...money },
        via,
      );
      change = 'updated';
    } else {
      // Taken here, in run: a parked save takes no number until it is approved.
      const { number } = await nextNumber(tx, principal, BasketSeries);
      basket = await BasketDef.repo.insert(
        tx,
        principal,
        { title: input.title, currency, number, ...money },
        via,
      );
      change = 'created';
    }
    const items = await BasketItemDef.children.replace(tx, principal, basket, nodes, via);
    return {
      value: { basket, items: items.rows },
      touched: [
        {
          type: 'basket',
          id: basket.id,
          change,
          before: loaded.basket ?? undefined,
          after: basket,
        },
        ...items.touched,
      ],
      events: [new BasketSaved(basket)],
    };
  },
});

@Module({
  controllers: [
    commandController(SaveBasket),
    entityController(BasketDef),
    entityController(BasketItemDef),
  ],
  providers: [
    ...entityHandlers(BasketDef),
    ...entityHandlers(BasketItemDef),
    commandHandler(SaveBasket),
  ],
})
export class BasketsModule {}

const hidesCost = (p: Principal) => (p.roles ?? []).includes('staff');
const withoutCost = (item: unknown) => {
  if (!item || typeof item !== 'object') return item;
  const { cost: _cost, ...rest } = item as Record<string, unknown>;
  return rest;
};

/** Staff never see an item's cost: in reads, in a save's result, on its approval card. */
export const costHidden: ReadProjector = {
  name: 'fixture.cost-hidden',
  project: (type, value, p) => {
    if (!hidesCost(p)) return value;
    if (type === 'basketItem') return withoutCost(value) as Record<string, unknown>;
    const input = value.input as { items?: unknown[] } | undefined;
    if (type === 'approval' && value.action === 'basket.save' && Array.isArray(input?.items))
      return { ...value, input: { ...input, items: input.items.map(withoutCost) } };
    return value;
  },
};

export const basketsModule = defineModule({
  ...moduleSpec({
    name: 'baskets',
    entities: { baskets: BasketSpec, basketItems: BasketItemSpec },
    commands: [SaveBasketSpec],
  }),
  server: BasketsModule,
  tables: { baskets, basketItems },
  contributes: { numberSeries: [BasketSeries], readProjectors: [costHidden] },
});

/** The fixture plus baskets. */
export const lineItems = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, basketsModule],
});
