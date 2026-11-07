import { listInputSchema, summaryInputSchema } from '@hykr/contracts';
import { z } from 'zod';
import type { ViewCheckContext, ViewDef } from './define-view.js';

/** What the agent may write as props: the fetched field is the client's to fill. */
export function agentProps(view: ViewDef): z.ZodObject {
  return view.source ? view.props.omit({ [view.source.into]: true } as never) : view.props;
}

export const problem = (error: z.ZodError) => z.prettifyError(error).replaceAll('\n', ' ');

/** A view's query, checked against its entity's list grammar (the same check the API runs). */
export function checkQuery(view: ViewDef, query: unknown): string | null {
  if (!view.source || view.source.by === 'id') {
    return query === undefined ? null : `${view.name} takes props, not a query`;
  }
  const schema =
    view.source.by === 'summary'
      ? summaryInputSchema(view.source.entity)
      : listInputSchema(view.source.entity, { maxLimit: 100 });
  const r = schema.safeParse(query ?? {});
  return r.success ? null : `Bad query for ${view.name}: ${problem(r.error)}`;
}

/** A view's props: its schema (less what its source fills), then its own `check`. */
export function checkProps(
  view: ViewDef,
  props: unknown,
  ctx: ViewCheckContext = {},
): string | null {
  const r = agentProps(view).safeParse(props ?? {});
  if (!r.success) return `Bad props for ${view.name}: ${problem(r.error)}`;
  const own = view.check?.(r.data as never, ctx);
  return own ? `Bad props for ${view.name}: ${own}` : null;
}
