import { z } from 'zod';

/**
 * Where a turn can show things. The app sends inline + canvas; a voice session in the app adds
 * speech (it says the short version and shows the rest); WhatsApp sends text; a call with no
 * screen at all sends speech alone. The server uses the list twice: to choose the agent's
 * tools, and to resolve what a tool result shows.
 */
export const Surface = z.enum(['inline', 'canvas', 'text', 'speech']);
export type Surface = z.infer<typeof Surface>;
export const Surfaces = z.array(Surface).min(1).max(4);

/** Surfaces that draw components; the rest get words. */
export const drawsComponents = (surfaces: readonly Surface[]) =>
  surfaces.includes('inline') || surfaces.includes('canvas');

/**
 * A list query in the entity's JSON grammar ({ done: false, dueOn: { lte: '…' } }). Its
 * shape depends on the entity, so it is checked against that entity's list config where it
 * is used (the registry, the tool, the API), never trusted as is.
 */
export const ViewQuery = z.record(z.string(), z.unknown());
export type ViewQuery = z.infer<typeof ViewQuery>;

/** One block of a composed page: a view, filled by a query (or by props for views without one). */
export const PageBlock = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Use lower-case letters, digits and dashes')
    .max(40),
  view: z.string().min(1).max(60),
  /** The entity is the view's own; the query narrows it. */
  query: ViewQuery.optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  /** two-column layouts only: a block may take the full width. */
  span: z.enum(['half', 'full']).default('half'),
});
export type PageBlock = z.infer<typeof PageBlock>;

/**
 * A page the assistant composed (or the person saved): queries, not data. Every block is
 * fetched with the person's own session, so a page is always current and never shows rows
 * they could not already see.
 */
export const PageSpec = z.object({
  title: z.string().min(1).max(80),
  layout: z.enum(['stack', 'two-column']).default('stack'),
  blocks: z
    .array(PageBlock)
    .min(1)
    .max(8)
    .refine((blocks) => new Set(blocks.map((b) => b.id)).size === blocks.length, {
      message: 'Block ids must be unique',
    }),
});
export type PageSpec = z.infer<typeof PageSpec>;

/**
 * What a tool result asks to show. The agent never produces components: it names a
 * registered view (or screen) and a query, and the surface decides how it is shown.
 */
export const Present = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline'),
    view: z.string(),
    query: ViewQuery.optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal('open'),
    screen: z.string(),
    params: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('page'), page: PageSpec, pageId: z.string().optional() }),
  z.object({
    kind: z.literal('patch'),
    blockId: z.string(),
    query: ViewQuery.optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  /** Text and voice: the server already rendered the view into words. */
  z.object({ kind: z.literal('text'), text: z.string() }),
]);
export type Present = z.infer<typeof Present>;
