import { CreatedBy, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const name = z.string().min(1).max(200);

/** A product the business sells: what an order's line may name (`productId`). */
export const ProductView = z.object({
  id: z.string(),
  name,
  /** The business's own code for it. */
  sku: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type ProductView = z.infer<typeof ProductView>;

const productFields = {
  name,
  sku: z.string().min(1).max(60).nullable().optional(),
};

export const ProductSpec = entitySpec({
  name: 'product',
  label: 'product',
  description:
    "The business's products: a name and a code. An order's line may name one (productId); it keeps its own price.",
  schemas: {
    read: ProductView,
    create: z.object(productFields),
    update: z.object({ ...productFields, name: name.optional() }),
  },
  fieldLabels: {
    name: { en: 'Name', hi: 'नाम', te: 'పేరు' },
    sku: { en: 'Code', hi: 'कोड', te: 'కోడ్' },
  },
  list: {
    filterable: { name: 'text', sku: 'text' },
    sortable: ['name', 'createdAt'],
    defaultSort: [['name', 'asc']],
    search: ['name', 'sku'],
    pageSize: { default: 50, max: 200 },
  },
});
