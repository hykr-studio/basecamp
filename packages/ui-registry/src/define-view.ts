import type { EntitySpec, Surface } from '@app/contracts';
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

/** Who the words are for: a time zone, so times read as the person's own. */
export type TextContext = { timeZone: string };

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
  /** Words for WhatsApp; `speak` is the shorter form for voice. */
  text: (props: z.infer<P>, ctx: TextContext) => string;
  speak: (props: z.infer<P>, ctx: TextContext) => string;
  /** At most this many rows are fetched to render text. */
  textLimit: number;
  /** On a narrow screen the container swaps in this view (calendar.week → calendar.day). */
  collapseTo?: string;
}

type ViewInput<P extends z.ZodObject> = Omit<ViewDef<P>, 'actions' | 'textLimit' | 'source'> & {
  source?: { entity: EntitySpec; into: keyof z.infer<P> & string; by?: 'query' | 'id' };
  actions?: Record<string, ViewAction<never>>;
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
