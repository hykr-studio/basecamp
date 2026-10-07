import { drawsComponents, type PageSpec, type Present, type Surface } from '@app/contracts';
import type { ScreenDef, ViewDef } from './define-view.js';
import { checkProps, checkQuery, problem } from './validate.js';

export type Checked =
  | { kind: 'show'; present: Present }
  /** Not for this surface: the data still reaches the model, which answers in words. */
  | { kind: 'drop'; reason: string }
  /** Invalid: a tool error the model sees and can correct. */
  | { kind: 'error'; error: string };

/**
 * A catalog of views and screens: everything the agent may show. A view not in it cannot
 * reach a screen, whatever the model writes. The framework (tools, the API, the app) takes
 * a registry; it never knows which domain's views are in it. Past ~30 views, give the agent
 * a find-view tool rather than listing them all in tool descriptions.
 */
export function createRegistry(input: {
  views: readonly ViewDef[];
  screens: readonly ScreenDef[];
}) {
  const viewsByName = new Map(input.views.map((v) => [v.name, v]));
  const screensByName = new Map(input.screens.map((s) => [s.name, s]));
  for (const v of input.views)
    if (v.collapseTo && !viewsByName.has(v.collapseTo))
      throw new Error(`${v.name} collapses to an unknown view ${v.collapseTo}`);

  const getViewDef = (name: string): ViewDef | undefined => viewsByName.get(name);
  const getScreenDef = (name: string): ScreenDef | undefined => screensByName.get(name);
  const viewsFor = (surface: Surface) => input.views.filter((v) => v.surfaces.includes(surface));

  /** Every block names a canvas view with a valid query and props. Empty means valid. */
  function checkPage(page: PageSpec): string[] {
    const errors: string[] = [];
    for (const block of page.blocks) {
      const view = getViewDef(block.view);
      if (!view) {
        errors.push(`Block "${block.id}": no view called ${block.view}`);
        continue;
      }
      if (!view.surfaces.includes('canvas'))
        errors.push(`Block "${block.id}": ${view.name} cannot be shown on a page`);
      const q = checkQuery(view, block.query);
      if (q) errors.push(`Block "${block.id}": ${q}`);
      const p = checkProps(view, block.props);
      if (p) errors.push(`Block "${block.id}": ${p}`);
    }
    return errors;
  }

  /** A patch changes one block: its query is replaced, its props merged. */
  function applyPatch(
    page: PageSpec,
    patch: { blockId: string; query?: Record<string, unknown>; props?: Record<string, unknown> },
  ): PageSpec | string {
    const block = page.blocks.find((b) => b.id === patch.blockId);
    if (!block)
      return `No block "${patch.blockId}" on the page (blocks: ${page.blocks.map((b) => b.id).join(', ')})`;
    const next: PageSpec = {
      ...page,
      blocks: page.blocks.map((b) =>
        b.id === patch.blockId
          ? {
              ...b,
              ...(patch.query ? { query: patch.query } : {}),
              ...(patch.props ? { props: { ...b.props, ...patch.props } } : {}),
            }
          : b,
      ),
    };
    const errors = checkPage(next);
    return errors.length ? errors.join('; ') : next;
  }

  /**
   * Is this intent valid, and can these surfaces show it? Runs on the server before a
   * result leaves it, so a client never has to guard against a bad view, query or screen.
   */
  function checkPresent(
    present: Present,
    surfaces: readonly Surface[],
    canvas?: PageSpec,
  ): Checked {
    const hasCanvas = surfaces.includes('canvas');
    switch (present.kind) {
      case 'text':
        return { kind: 'show', present };
      case 'inline': {
        const view = getViewDef(present.view);
        if (!view) return { kind: 'error', error: `No view called ${present.view}` };
        const bad = checkQuery(view, present.query) ?? checkProps(view, present.props);
        if (bad) return { kind: 'error', error: bad };
        if (!drawsComponents(surfaces))
          return { kind: 'drop', reason: 'This surface shows words, not views' };
        if (!view.surfaces.includes('inline'))
          return { kind: 'drop', reason: `${view.name} is not shown in the chat` };
        return { kind: 'show', present };
      }
      case 'open': {
        const screen = getScreenDef(present.screen);
        if (!screen) return { kind: 'error', error: `No screen called ${present.screen}` };
        const r = screen.params.safeParse(present.params);
        if (!r.success)
          return { kind: 'error', error: `Bad params for ${screen.name}: ${problem(r.error)}` };
        return hasCanvas ? { kind: 'show', present } : { kind: 'drop', reason: 'No canvas here' };
      }
      case 'page': {
        const errors = checkPage(present.page);
        if (errors.length) return { kind: 'error', error: errors.join('; ') };
        return hasCanvas ? { kind: 'show', present } : { kind: 'drop', reason: 'No canvas here' };
      }
      case 'patch': {
        if (!hasCanvas) return { kind: 'drop', reason: 'No canvas here' };
        if (!canvas)
          return { kind: 'error', error: 'No page is open to change: compose one first' };
        const next = applyPatch(canvas, present);
        return typeof next === 'string'
          ? { kind: 'error', error: next }
          : { kind: 'show', present };
      }
    }
  }

  return {
    views: input.views,
    screens: input.screens,
    getViewDef,
    getScreenDef,
    viewsFor,
    /** "todo.list: A checklist of …" lines, for the canvas tools' descriptions. */
    catalog: (surface: Surface) =>
      viewsFor(surface)
        .map(
          (v) =>
            `- ${v.name}${v.source ? ` (${v.source.entity.plural} query)` : ' (props)'}: ${v.description}`,
        )
        .join('\n'),
    checkPage,
    applyPatch,
    checkPresent,
  };
}

export type Registry = ReturnType<typeof createRegistry>;
