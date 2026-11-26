// The browser adapter, against fake model contexts of both shapes: the draft's (document,
// registerTool with a signal, a promise) and the early preview's (navigator, unregisterTool).
import { describe, expect, it, vi } from 'vitest';
import { findModelContext, type ModelContextLike, registerTools, type WebMcpTool } from './adapter';

const tool = (name: string): WebMcpTool => ({
  name,
  description: `The ${name} tool.`,
  execute: async () => 'ok',
});

/** The draft's shape: tools by name, removed when their signal aborts. */
function draftContext() {
  const tools = new Map<string, WebMcpTool>();
  const mc: ModelContextLike = {
    registerTool: vi.fn(async (t: WebMcpTool, options?: { signal?: AbortSignal }) => {
      if (tools.has(t.name)) throw new DOMException('Duplicate tool', 'InvalidStateError');
      tools.set(t.name, t);
      options?.signal?.addEventListener('abort', () => tools.delete(t.name));
    }),
  };
  return { mc, tools };
}

/** The early preview's shape: synchronous, with unregisterTool and no signal. */
function previewContext() {
  const tools = new Map<string, WebMcpTool>();
  const mc: ModelContextLike = {
    registerTool: vi.fn((t: WebMcpTool) => {
      if (tools.has(t.name)) throw new Error(`Duplicate ${t.name}`);
      tools.set(t.name, t);
    }),
    unregisterTool: vi.fn((name: string) => {
      if (!tools.delete(name)) throw new Error(`No tool ${name}`);
    }),
  };
  return { mc, tools };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('findModelContext', () => {
  it('prefers document.modelContext, then navigator.modelContext', () => {
    const a = draftContext().mc;
    const b = previewContext().mc;
    expect(
      findModelContext({ document: { modelContext: a }, navigator: { modelContext: b } }),
    ).toBe(a);
    expect(findModelContext({ navigator: { modelContext: b } })).toBe(b);
  });

  it('finds none without the API, or with one that cannot register tools', () => {
    expect(findModelContext({})).toBeUndefined();
    expect(findModelContext({ navigator: {} })).toBeUndefined();
    expect(findModelContext({ document: { modelContext: { provideContext() {} } } })).toBe(
      undefined,
    );
    expect(findModelContext({ navigator: { modelContext: null } })).toBeUndefined();
  });

  it('reads the global scope by default (none here, as in a native app)', () => {
    expect(findModelContext()).toBeUndefined();
  });
});

describe('registerTools', () => {
  it('registers each tool with a signal, and the unregister aborts it (the draft)', async () => {
    const { mc, tools } = draftContext();
    const off = registerTools(mc, [tool('list-records'), tool('get-record')]);
    await settle();
    expect([...tools.keys()]).toEqual(['list-records', 'get-record']);
    const [, options] = vi.mocked(mc.registerTool).mock.calls[0];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    off();
    expect(tools.size).toBe(0);
    expect(options?.signal?.aborted).toBe(true);
    off(); // twice is harmless
  });

  it('calls unregisterTool where the browser has it (the early preview)', () => {
    const { mc, tools } = previewContext();
    const off = registerTools(mc, [tool('list-records'), tool('get-record')]);
    expect(tools.size).toBe(2);
    off();
    expect(tools.size).toBe(0);
    expect(mc.unregisterTool).toHaveBeenCalledTimes(2);
  });

  it('logs a tool the browser refuses and still registers the others', async () => {
    const log = vi.fn();
    const draft = draftContext();
    await draft.mc.registerTool(tool('list-records'));
    registerTools(draft.mc, [tool('list-records'), tool('get-record')], log);
    await settle();
    expect(draft.tools.has('get-record')).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'WebMCP: the tool list-records was not registered',
      expect.any(DOMException),
    );

    const preview = previewContext();
    preview.mc.registerTool(tool('get-record'));
    const off = registerTools(preview.mc, [tool('list-records'), tool('get-record')], log);
    expect(log).toHaveBeenLastCalledWith(
      'WebMCP: the tool get-record was not registered',
      expect.any(Error),
    );
    off();
    // Only what it registered is taken back: the other script's tool stays.
    expect([...preview.tools.keys()]).toEqual(['get-record']);
  });

  it('undoes a registration that settles after the unregister', async () => {
    let resolve = () => {};
    const unregister = vi.fn();
    const mc: ModelContextLike = {
      registerTool: vi.fn(() => new Promise<void>((r) => (resolve = r))),
      unregisterTool: unregister,
    };
    const off = registerTools(mc, [tool('list-records')]);
    off();
    expect(unregister).not.toHaveBeenCalled();
    resolve();
    await settle();
    expect(unregister).toHaveBeenCalledWith('list-records');
  });

  it('uses the handle a registration gives back, when there is one', () => {
    const unregister = vi.fn();
    const mc: ModelContextLike = { registerTool: vi.fn(() => ({ unregister })) };
    const off = registerTools(mc, [tool('list-records')]);
    off();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('ignores an unregister that fails: the tool is gone already', async () => {
    const mc: ModelContextLike = {
      registerTool: vi.fn(),
      unregisterTool: vi.fn(async () => {
        throw new Error('already gone');
      }),
    };
    const off = registerTools(mc, [tool('list-records')]);
    expect(() => off()).not.toThrow();
    await settle();
  });
});
