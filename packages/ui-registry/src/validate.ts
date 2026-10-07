import { listInputSchema } from '@app/contracts';
import { z } from 'zod';
import type { ViewDef } from './define-view.js';

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
  const r = listInputSchema(view.source.entity, { maxLimit: 100 }).safeParse(query ?? {});
  return r.success ? null : `Bad query for ${view.name}: ${problem(r.error)}`;
}

export function checkProps(view: ViewDef, props: unknown): string | null {
  const r = agentProps(view).safeParse(props ?? {});
  return r.success ? null : `Bad props for ${view.name}: ${problem(r.error)}`;
}
