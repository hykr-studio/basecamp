import type { ApiClient } from '@app/api-client';
import { drawsComponents, type PageSpec, type Present, type Surface } from '@app/contracts';
import type { ViewDef } from '@app/ui-registry';
import type { ToolContext, ToolKit } from './tool-factory.js';

/** Where this turn can show things (the chat endpoint sets it; Studio defaults to inline). */
export function surfacesOf(ctx: ToolContext | undefined): Surface[] {
  return (ctx?.requestContext?.get('surfaces') as Surface[] | undefined) ?? ['inline'];
}

/** The page the canvas shows now, sent by the app with the turn. */
export function canvasOf(ctx: ToolContext | undefined): PageSpec | undefined {
  return (ctx?.requestContext?.get('canvas') as { page?: PageSpec } | undefined)?.page;
}

/**
 * A view in words, for a surface without a screen. The data comes through the agent's own
 * API client: the same routes, repository and owner scope as the app, so the text can only
 * ever contain what the person could already see.
 */
async function inWords(
  view: ViewDef,
  present: Extract<Present, { kind: 'inline' }>,
  surfaces: Surface[],
  ctx: ToolContext | undefined,
  client: ApiClient,
): Promise<string | undefined> {
  const props: Record<string, unknown> = { ...present.props };
  if (view.source) {
    const api = client.entity(view.source.entity);
    if (view.source.by === 'id') props[view.source.into] = await api.get(String(props.id));
    else
      props[view.source.into] = (await api.list({ ...present.query, limit: view.textLimit })).items;
  }
  const parsed = view.props.safeParse(props);
  if (!parsed.success) return undefined;
  const timeZone = (ctx?.requestContext?.get('timeZone') as string | undefined) ?? 'UTC';
  const words = surfaces.includes('text') ? view.text : view.speak;
  return words(parsed.data, { timeZone });
}

export type Resolved = { present?: Present } | { error: string };

/**
 * What a tool result shows, for this turn's surfaces. Runs before the result reaches the
 * model or the client:
 * - inline or canvas: checked against the registry and passed through; the client fetches.
 * - text or voice: the view rendered to words here, replacing the intent.
 * - not allowed on the surface: dropped; the model still has the data and answers in words.
 * - invalid: an error, which the model sees and can correct.
 */
export async function resolvePresent(
  present: Present,
  ctx: ToolContext | undefined,
  kit: ToolKit,
): Promise<Resolved> {
  const surfaces = surfacesOf(ctx);
  const checked = kit.registry.checkPresent(present, surfaces, canvasOf(ctx));
  if (checked.kind === 'error') return { error: checked.error };
  if (checked.kind === 'show') return { present: checked.present };
  if (present.kind === 'inline' && !drawsComponents(surfaces)) {
    const view = kit.registry.getViewDef(present.view);
    const text = view ? await inWords(view, present, surfaces, ctx, kit.clientFor(ctx)) : undefined;
    return text ? { present: { kind: 'text', text } } : {};
  }
  return {};
}
