import type { PageSpec, Present } from '@app/contracts';
import { registry } from '@app/ui-registry';
import { create } from 'zustand';

/**
 * The canvas: the part of the screen beside the chat that the assistant can drive. It shows
 * one registered screen, or a page of views. The person's own navigation (the rail, the
 * tabs) stays theirs: the assistant can open things here, never move them elsewhere.
 */
export type CanvasState =
  | { kind: 'closed' }
  | { kind: 'screen'; screen: string; params: Record<string, unknown> }
  | { kind: 'page'; page: PageSpec; pageId?: string };

type Store = {
  state: CanvasState;
  /** The last thing shown, so a chip or a reopen can bring it back. */
  last: CanvasState;
  /** Tool calls already applied: a re-render or reconnect never opens the same page twice. */
  applied: Set<string>;
  show: (state: Exclude<CanvasState, { kind: 'closed' }>) => void;
  close: () => void;
  reopen: () => void;
};

export const useCanvas = create<Store>((set, get) => ({
  state: { kind: 'closed' },
  last: { kind: 'closed' },
  applied: new Set(),
  show: (state) => set({ state, last: state }),
  close: () => set({ state: { kind: 'closed' } }),
  reopen: () => {
    const { last } = get();
    if (last.kind !== 'closed') set({ state: last });
  },
}));

/**
 * The page the person is working with: the one on the canvas, or (on a phone, back in the
 * chat) the one they last saw. Sent with each turn so the assistant can patch or save it.
 */
function workingPage() {
  const { state, last } = useCanvas.getState();
  if (state.kind === 'page') return state;
  return state.kind === 'closed' && last.kind === 'page' ? last : undefined;
}

export function currentPage(): { page: PageSpec; pageId?: string } | undefined {
  const page = workingPage();
  return page ? { page: page.page, pageId: page.pageId } : undefined;
}

/**
 * Apply an intent from a tool result, once per tool call. open → a screen; page → a page;
 * patch → one block of the page on the canvas (ignored, with a warning, if none is open).
 */
export function applyCanvasIntent(present: Present, toolCallId?: string) {
  const store = useCanvas.getState();
  if (toolCallId) {
    if (store.applied.has(toolCallId)) return;
    store.applied.add(toolCallId);
  }
  switch (present.kind) {
    case 'open':
      return store.show({ kind: 'screen', screen: present.screen, params: present.params });
    case 'page':
      return store.show({ kind: 'page', page: present.page, pageId: present.pageId });
    case 'patch': {
      // The page being refined, shown again with the change.
      const now = workingPage();
      if (!now) {
        console.warn('canvas-patch with no page open: ignored', present.blockId);
        return;
      }
      const next = registry.applyPatch(now.page, present);
      if (typeof next === 'string') {
        console.warn('canvas-patch could not apply:', next);
        return;
      }
      return store.show({ kind: 'page', page: next, pageId: now.pageId });
    }
  }
}
