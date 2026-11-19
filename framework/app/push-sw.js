// @hykr/app's service worker for web push (W1). The app's config plugin (`@hykr/app` in
// app.json's plugins) copies it into the app's public/ folder, so the site serves it at
// /push-sw.js; pushPlugin() registers it after sign-in. It shows what the server pushed
// ({ title, body, url, notification }) and, on a click, focuses the app's tab on the
// notification's link or opens one. Nothing else: no caching, no offline pages.

/** The link a click opens: a path in this app ('/orders/1'), never another site or scheme. */
function appPathOf(data) {
  const url = data?.url;
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return undefined;
  return url;
}

/** What the server sent, or nothing when it is not ours. */
function payloadOf(event) {
  if (!event.data) return undefined;
  try {
    const p = event.data.json();
    return p && typeof p.title === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const p = payloadOf(event);
  if (!p) return;
  const url = appPathOf(p);
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: typeof p.body === 'string' ? p.body : '',
      // One per notification kind: a newer one of the same kind replaces the older.
      tag: typeof p.notification === 'string' ? p.notification : undefined,
      icon: '/pwa-icon.png',
      badge: '/pwa-icon.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = appPathOf(event.notification.data) ?? '/';
  event.waitUntil(
    (async () => {
      const here = new URL(self.registration.scope).origin;
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = tabs.find((c) => new URL(c.url).origin === here);
      if (tab) {
        await tab.focus();
        // The app routes in place (no reload): pushPlugin listens for this.
        tab.postMessage({ type: 'hykr.push.open', url: path });
        return;
      }
      await self.clients.openWindow(new URL(path, here).href);
    })(),
  );
});
