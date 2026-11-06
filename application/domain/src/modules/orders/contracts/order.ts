import { CreatedBy, entitySpec } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);

export const OrderView = z.object({
  id: z.string(),
  title,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});
export type OrderView = z.infer<typeof OrderView>;

export const CreateOrderInput = z.object({ title });
export const UpdateOrderInput = z.object({ title: title.optional() });

export const OrderSpec = entitySpec({
  name: 'order',
  label: 'order',
  // What the assistant reads to choose its tools: say what one is and when to use it.
  description: 'Orders: each has a title.',
  schemas: { read: OrderView, create: CreateOrderInput, update: UpdateOrderInput },
  fieldLabels: {
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
  },
  list: {
    filterable: { title: 'text', createdAt: 'date' },
    sortable: ['createdAt', 'title'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title'],
    pageSize: { default: 25, max: 100 },
    examples: { title: '{ "contains": "first" }' },
  },
  // An agent never deletes without the person.
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'order.list' },
});
