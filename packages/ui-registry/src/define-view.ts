import type { EntitySpec, Surface } from '@app/contracts';
import { count, firstFew, type Labels, type Lang, type Noun, pick } from '@app/i18n';
import type { z } from 'zod';

/**
 * A gesture in a view, mapped to the framework: an entity action or command (so validation,
 * authorization, approvals and audit all apply), or a registered screen opened in the canvas.
 * The component never calls the API itself.
 */
export type ViewAction<Item = never> =
  | {
      /** `<entity>.<create|update|delete>` or a command's name, e.g. 'todo.update'. */
      command: string;
      args: (item: Item) => Record<string, unknown>;
    }
  | { screen: string; params: (item: Item) => Record<string, unknown> };

/** Who the words are for: their time zone, so times read as their own, and their language. */
export type TextContext = { timeZone: string; lang: Lang };

/**
 * A view's words in every language: what the app shows as its title and when it is empty, and
 * what one of its rows is called ("to-do" / "to-dos"), for counts and spoken answers.
 */
export type ViewLabels = { title?: Labels; empty?: Labels; noun?: Noun };

export interface ViewDef<P extends z.ZodObject = z.ZodObject> {
  /** Stable id used by tools, the canvas, saved pages and the client registry. */
  name: string;
  /** What the agent reads when choosing a view: include when not to use it. */
  description: string;
  /** Where it may appear. The server filters tools and checks present against this. */
  surfaces: readonly Surface[];
  /** Everything the renderer needs; checked on the server before it reaches a client. */
  props: P;
  /**
   * Where the data comes from: the client fills `props[into]` through the entity's own list
   * (by: 'query') or get (by: 'id', with props.id), with the person's session. Without a
   * source, the intent carries the full props (kpi.row).
   */
  source?: { entity: EntitySpec; into: string; by: 'query' | 'id' };
  actions: Record<string, ViewAction<never>>;
  labels: ViewLabels;
  /** Words for WhatsApp. */
  text: (props: z.infer<P>, ctx: TextContext) => string;
  /**
   * The short form for voice, in ctx.lang: at most a sentence or two. With a screen, the
   * model is given it to phrase its answer while the view shows the detail; without one, it
   * is the answer.
   */
  speak: (props: z.infer<P>, ctx: TextContext) => string;
  /** At most this many rows are fetched to render text. */
  textLimit: number;
  /** On a narrow screen the container swaps in this view (calendar.week → calendar.day). */
  collapseTo?: string;
}

type ViewInput<P extends z.ZodObject> = Omit<
  ViewDef<P>,
  'actions' | 'textLimit' | 'source' | 'labels'
> & {
  source?: { entity: EntitySpec; into: keyof z.infer<P> & string; by?: 'query' | 'id' };
  actions?: Record<string, ViewAction<never>>;
  labels?: ViewLabels;
  textLimit?: number;
};

/**
 * Declare a view the agent may choose to show. Base components (cards, rows, badges) are
 * ordinary React and are not registered; only views are. The React component is bound in
 * each app with bindView (@app/ui-registry/react).
 */
export function defineView<P extends z.ZodObject>(def: ViewInput<P>): ViewDef<P> {
  return {
    ...def,
    source: def.source ? { by: 'query', ...def.source } : undefined,
    actions: def.actions ?? {},
    labels: def.labels ?? {},
    textLimit: def.textLimit ?? 10,
  };
}

/** A typed action: the item type comes from the view's props, checked where it is declared. */
export function action<Item>(a: ViewAction<Item>): ViewAction<never> {
  return a as ViewAction<never>;
}

export interface ScreenDef<P extends z.ZodObject = z.ZodObject> {
  name: string;
  /** What the canvas header and the chat's chip call it: "meeting", "saved page". */
  title: string;
  /** What the agent reads when choosing a screen for canvas-open. */
  description: string;
  params: P;
}

/** A screen the canvas can open: the person's own app screen, shown beside the chat. */
export function defineScreen<P extends z.ZodObject>(def: ScreenDef<P>): ScreenDef<P> {
  return def;
}

/**
 * The spoken form of a list, in the person's language: "3 to-dos: Call the plumber, Order
 * tiles, Book a visit." or the view's empty line.
 */
export function spokenList(names: string[], labels: ViewLabels, ctx: TextContext): string {
  if (names.length === 0) return labels.empty ? pick(labels.empty, ctx.lang) : '';
  const head = labels.noun ? `${count(names.length, labels.noun, ctx.lang)}: ` : '';
  return `${head}${firstFew(names, ctx.lang)}.`;
}
