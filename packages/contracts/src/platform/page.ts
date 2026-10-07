import { z } from 'zod';
import { PageSpec } from '../framework/present.js';
import { CreatedBy, entitySpec } from '../framework/spec.js';

const name = z.string().min(1).max(80);

/** A canvas page the person kept: its layout of queries, so it always shows today's data. */
export const SavedPage = z.object({
  id: z.string(),
  name,
  spec: PageSpec,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedPage = z.infer<typeof SavedPage>;

export const CreatePageInput = z.object({ name, spec: PageSpec });
export type CreatePageInput = z.input<typeof CreatePageInput>;

export const UpdatePageInput = z
  .object({ name: name.optional(), spec: PageSpec.optional() })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );
export type UpdatePageInput = z.infer<typeof UpdatePageInput>;

/**
 * Saved pages: one declaration, so CRUD, the list grammar, agent tools and audit come
 * from the framework. "Save this as my Monday view" is a plain create.
 */
export const SavedPageSpec = entitySpec({
  name: 'page',
  label: 'page',
  description:
    'Pages the user saved from the canvas, by name ("Monday view"). Open one with canvas-open (screen page.view); save the page on the canvas with create-page, passing its spec unchanged.',
  schemas: { read: SavedPage, create: CreatePageInput, update: UpdatePageInput },
  list: {
    filterable: { name: 'text' },
    sortable: ['name', 'updatedAt', 'createdAt'],
    defaultSort: [['updatedAt', 'desc']],
    search: ['name'],
    pageSize: { default: 50, max: 100 },
    examples: { name: '{ "contains": "monday" }' },
  },
  // The assistant may save and find pages; renaming and deleting are the person's.
  expose: { list: 'all', get: 'all', create: 'all', update: 'human', delete: 'human' },
  views: { list: 'page.list' },
});
