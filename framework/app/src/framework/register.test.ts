// What `Register` types the app's hooks with: a catalog, or several modules' entities merged.
// The checks are types: `tsc -p tsconfig.test.json` (the package's typecheck) fails if one breaks.
import { type Catalog, createCatalog, entitySpec, type ModuleSpec } from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CatalogOf, MergedEntities } from './hooks';

const Order = z.object({ id: z.string(), total: z.number() });
const Visit = z.object({ id: z.string(), at: z.string() });
const OrderSpec = entitySpec({
  name: 'order',
  label: 'order',
  description: 'Orders.',
  schemas: { read: Order, create: Order.omit({ id: true }), update: Order.partial() },
  list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 20, max: 100 } },
});
const VisitSpec = entitySpec({
  name: 'visit',
  label: 'visit',
  description: 'Visits.',
  schemas: { read: Visit, create: Visit.omit({ id: true }), update: Visit.partial() },
  list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 20, max: 100 } },
});
const orders = {
  name: 'orders',
  entities: { orders: OrderSpec },
  commands: [],
} satisfies ModuleSpec;
const visits = {
  name: 'visits',
  entities: { visits: VisitSpec },
  commands: [],
} satisfies ModuleSpec;
const catalog = createCatalog({ name: 'One', entities: { orders: OrderSpec }, commands: [] });

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_: T) => _;
type ReadOf<C extends Catalog, K extends keyof C['entities']> = z.infer<
  C['entities'][K]['schemas']['read']
>;

describe('Register', () => {
  it('takes a catalog as it is', () => {
    type C = CatalogOf<{ catalog: typeof catalog }>;
    assert<Equal<C, typeof catalog>>(true);
    assert<Equal<ReadOf<C, 'orders'>, { id: string; total: number }>>(true);
    expect(catalog.entities.orders).toBe(OrderSpec);
  });

  it("merges its modules' entities, with the platform's", () => {
    type C = CatalogOf<{ modules: [typeof orders, typeof visits] }>;
    assert<Equal<keyof MergedEntities<[typeof orders, typeof visits]>, 'orders' | 'visits'>>(true);
    assert<Equal<ReadOf<C, 'visits'>, { id: string; at: string }>>(true);
    assert<Equal<ReadOf<C, 'orders'>['total'], number>>(true);
    // The framework's own entities stay in.
    assert<'pages' extends keyof C['entities'] ? true : false>(true);
    expect(orders.entities.orders.name).toBe('order');
  });

  it('is the general catalog without a registration, and with no modules', () => {
    assert<Equal<CatalogOf<object>, Catalog>>(true);
    type None = CatalogOf<{ modules: [] }>;
    assert<'pages' extends keyof None['entities'] ? true : false>(true);
    assert<'orders' extends keyof None['entities'] ? false : true>(true);
    expect(true).toBe(true);
  });
});
