/// <reference types="node" />
// The web push service worker (push-sw.js) and the config plugin that copies it (app.plugin.js),
// run as plain scripts: the worker in a sandbox with a stand-in `self`.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const source = readFileSync(join(root, 'push-sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;
type Tab = { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };

/** The worker in a sandbox: what it listens to, what it shows, the tabs it sees. */
function worker(tabs: Tab[] = []) {
  const on: Record<string, Listener> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const openWindow = vi.fn(async () => undefined);
  const self = {
    addEventListener: (name: string, fn: Listener) => {
      on[name] = fn;
    },
    skipWaiting: vi.fn(),
    registration: {
      scope: 'https://studio.example.com/',
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => tabs), openWindow },
  };
  runInNewContext(source, { self, URL });
  /** Dispatch an event and wait for what it handed to waitUntil. */
  const fire = async (name: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> | undefined;
    on[name]({ ...event, waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
  };
  return { fire, shown, openWindow };
}
const push = (payload: unknown) => ({
  data: {
    json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
  },
});
const tab = (url: string): Tab => ({
  url,
  focus: vi.fn(async () => undefined),
  postMessage: vi.fn(),
});

describe('the service worker', () => {
  it('shows what was pushed: title, body, the notification as its tag, the link', async () => {
    const w = worker();
    await w.fire(
      'push',
      push({
        title: 'Approval waiting',
        body: 'Discount 18%',
        url: '/approvals/a1',
        notification: 'approval.request',
      }),
    );
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe('Approval waiting');
    expect(w.shown[0].options).toMatchObject({
      body: 'Discount 18%',
      tag: 'approval.request',
      data: { url: '/approvals/a1' },
    });
  });

  it('shows nothing for a push that is not ours, or not JSON', async () => {
    const w = worker();
    await w.fire('push', { data: null });
    await w.fire('push', push({ hello: 'there' }));
    await w.fire('push', { data: { json: () => JSON.parse('not json') } });
    expect(w.shown).toEqual([]);
  });

  it('keeps no link that leaves the app', async () => {
    const w = worker();
    for (const url of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)'])
      await w.fire('push', push({ title: 'T', body: 'B', url, notification: 'n' }));
    expect(w.shown.map((s) => s.options.data)).toEqual(
      [{}, {}, {}].map(() => ({ url: undefined })),
    );
  });

  it("a click focuses the app's open tab and routes it to the link", async () => {
    const mine = tab('https://studio.example.com/orders');
    const other = tab('https://elsewhere.example.com/');
    const w = worker([other, mine]);
    const close = vi.fn();
    await w.fire('notificationclick', { notification: { close, data: { url: '/orders/7' } } });
    expect(close).toHaveBeenCalled();
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.postMessage).toHaveBeenCalledWith({ type: 'hykr.push.open', url: '/orders/7' });
    expect(other.focus).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('a click with no tab open opens one on the link; a bad link opens the app', async () => {
    const w = worker([]);
    await w.fire('notificationclick', {
      notification: { close: vi.fn(), data: { url: '/todos' } },
    });
    await w.fire('notificationclick', {
      notification: { close: vi.fn(), data: { url: 'https://evil.example/' } },
    });
    expect(w.openWindow.mock.calls).toEqual([
      ['https://studio.example.com/todos'],
      ['https://studio.example.com/'],
    ]);
  });
});

describe('the config plugin', () => {
  const plugin = createRequire(__filename)(join(root, 'app.plugin.js')) as ((
    c: object,
  ) => object) & {
    writeWebPushFiles: (root: string, config: object) => void;
  };

  it('writes the service worker, a manifest and the icon into public/, and keeps the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hykr-app-'));
    // A 1x1 PNG's header is enough for its size.
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(512, 16);
    png.writeUInt32BE(512, 20);
    writeFileSync(join(dir, 'icon.png'), png);
    const config = { name: 'Studio', icon: './icon.png', _internal: { projectRoot: dir } };
    expect(plugin(config)).toBe(config);
    expect(readFileSync(join(dir, 'public', 'push-sw.js'), 'utf8')).toBe(source);
    expect(JSON.parse(readFileSync(join(dir, 'public', 'manifest.webmanifest'), 'utf8'))).toEqual({
      name: 'Studio',
      short_name: 'Studio',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      icons: [{ src: '/pwa-icon.png', type: 'image/png', sizes: '512x512' }],
    });
    expect(readFileSync(join(dir, 'public', 'pwa-icon.png'))).toEqual(png);
  });

  it('says so when it cannot write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hykr-app-'));
    // A file where the folder should be.
    writeFileSync(join(dir, 'public'), '');
    expect(() => plugin({ name: 'Studio', _internal: { projectRoot: dir } })).toThrow(
      /could not write the web push files/,
    );
  });
});
