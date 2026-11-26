/**
 * The one file that touches the browser's WebMCP API. It is a draft that still moves: the
 * Community Group draft and Chrome put it on `document.modelContext`, with `registerTool(tool,
 * { signal })` and unregistration by aborting the signal; Chrome's early preview had it on
 * `navigator.modelContext`, with `unregisterTool(name)`. Both are handled here, and nothing
 * else in the app knows which one the browser has.
 */

/** One tool as the browser takes it (the draft's `ModelContextTool`). */
export interface WebMcpTool {
  /** 1 to 128 of A-Z, a-z, 0-9, _ - and '.'. Unique on the page. */
  name: string;
  title?: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema?: object;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  /** Its answer is serialised to JSON for the agent; a string stays as it is. */
  execute(input: Record<string, unknown>, options?: unknown): Promise<unknown>;
}

/** What the adapter needs from the browser: `registerTool`, and `unregisterTool` if it has one. */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}

type Scope = { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } };

const usable = (value: unknown): value is ModelContextLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { registerTool?: unknown }).registerTool === 'function';

/**
 * The browser's model context, or undefined: `document.modelContext` (the draft), then
 * `navigator.modelContext` (the early preview). One without `registerTool` counts as none.
 * Native apps and browsers without WebMCP have none.
 */
export function findModelContext(scope: Scope = globalThis as Scope): ModelContextLike | undefined {
  for (const candidate of [scope.document?.modelContext, scope.navigator?.modelContext])
    if (usable(candidate)) return candidate;
  return undefined;
}

export type Log = (message: string, error?: unknown) => void;
const warn: Log = (message, error) => console.warn(message, error);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';
const unregisterOf = (value: unknown) =>
  typeof (value as { unregister?: unknown } | null)?.unregister === 'function'
    ? () => (value as { unregister: () => unknown }).unregister()
    : undefined;

/**
 * Register the tools; returns the function that unregisters them (once). A tool the browser
 * refuses (a name another script holds, a schema it rejects) is logged by name and skipped:
 * the others still register and nothing is thrown into the app. A registration that settles
 * after the unregister is undone then.
 */
export function registerTools(
  mc: ModelContextLike,
  tools: readonly WebMcpTool[],
  log: Log = warn,
): () => void {
  const controller = new AbortController();
  let gone = false;
  const undo = new Map<string, () => unknown>();
  const unregister = (name: string, handle?: () => unknown) => {
    try {
      const out = handle ? handle() : mc.unregisterTool?.(name);
      if (isThenable(out)) out.then(undefined, () => {});
    } catch {
      // Already gone: a browser that honours the signal and also has unregisterTool.
    }
  };
  const registered = (name: string, out: unknown) => {
    // The early preview's registerTool may give back a handle; the draft's resolves to nothing.
    if (gone) unregister(name, unregisterOf(out));
    else undo.set(name, unregisterOf(out) ?? (() => mc.unregisterTool?.(name)));
  };
  for (const tool of tools) {
    const failed = (e: unknown) => log(`WebMCP: the tool ${tool.name} was not registered`, e);
    try {
      const out = mc.registerTool(tool, { signal: controller.signal });
      if (isThenable(out)) out.then((value) => registered(tool.name, value), failed);
      else registered(tool.name, out);
    } catch (e) {
      failed(e);
    }
  }
  return () => {
    if (gone) return;
    gone = true;
    controller.abort();
    for (const [name, handle] of undo) unregister(name, handle);
    undo.clear();
  };
}
