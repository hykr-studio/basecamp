// Web push in a browser (W1): the service worker the site serves at /push-sw.js, the browser's
// push subscription registered for the signed-in person in the business they work in, and
// whether notifications are on here. Permission is asked only from a person's click
// (`enableWebPush`), never when a page loads: browsers block a prompt without a gesture.
import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { api } from '../../api';
import { onBusinessChange } from '../../framework/business';
import { appPathOf } from './links';

/**
 * Whether this browser gets notifications: on; off (it can be turned on); blocked (the person
 * or the browser refused, only the browser's settings change that); unsupported (this browser
 * has no web push, or the server has no web push keys). Undefined until the plugin has looked.
 */
export type PushStatus = 'on' | 'off' | 'blocked' | 'unsupported';

/** Where the site serves the service worker (copied into public/ by @hykr/app's config plugin). */
export const SERVICE_WORKER_PATH = '/push-sw.js';
/** The web app manifest the config plugin writes next to it. */
export const MANIFEST_PATH = '/manifest.webmanifest';
/** What the service worker posts to an open tab when a notification is clicked. */
export const OPEN_MESSAGE = 'hykr.push.open';
/** Remembered in this browser when the person turned notifications off here. */
const OFF_KEY = 'hykr.push.off';

let status: PushStatus | undefined;
const listeners = new Set<() => void>();
function setStatus(next: PushStatus | undefined) {
  status = next;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const current = () => status;

/** Whether this browser gets notifications (on, off, blocked, unsupported), for a screen. */
export function usePushStatus(): PushStatus | undefined {
  return useSyncExternalStore(subscribe, current, current);
}

const remember = (off: boolean) => {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch {
    // No storage (a private window): only this page remembers.
  }
};
const turnedOff = () => {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
};

/** The browser can do web push: a service worker, the Push API and notifications. */
export function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** A base64url key as the bytes `pushManager.subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** The manifest, for "Add to Home Screen" (iOS shows web push only for a site added there). */
function linkManifest() {
  if (typeof document === 'undefined' || document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = MANIFEST_PATH;
  document.head.appendChild(link);
}

/** A click on a notification, in an open tab: go to its link in this app. */
function onWorkerMessage(event: MessageEvent) {
  const data = event.data as { type?: unknown; url?: unknown } | null;
  if (data?.type !== OPEN_MESSAGE) return;
  const path = appPathOf(data);
  if (!path) return;
  try {
    router.navigate(path as never);
  } catch (e) {
    console.warn('A notification’s link could not open:', e);
  }
}

type Session = { registration: ServiceWorkerRegistration; key: Uint8Array<ArrayBuffer> };
let session: Session | undefined;

/** Subscribe this browser (or reuse its subscription) and register it for the person. */
async function subscribeHere(s: Session): Promise<PushSubscription> {
  let sub = await s.registration.pushManager.getSubscription();
  // Made with another key (the server's keys changed): it cannot be sent to any more.
  if (sub && !sameKey(sub.options.applicationServerKey, s.key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await s.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: s.key,
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error('The browser gave a subscription without keys');
  await api.push.register({
    platform: 'web',
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  });
  return sub;
}

/**
 * After sign-in: register the service worker, and when the person allowed notifications here
 * before (and did not turn them off), register this browser again. Never asks.
 */
export async function startWebPush(): Promise<() => void> {
  if (!webPushSupported()) {
    setStatus('unsupported');
    return () => setStatus(undefined);
  }
  const { publicKey } = await api.push.webKey();
  if (!publicKey) {
    setStatus('unsupported');
    return () => setStatus(undefined);
  }
  linkManifest();
  navigator.serviceWorker.addEventListener('message', onWorkerMessage);
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: '/' });
  session = { registration, key: keyBytes(publicKey) };
  const s = session;
  const sync = async () => {
    if (Notification.permission === 'denied') return setStatus('blocked');
    if (Notification.permission !== 'granted' || turnedOff()) return setStatus('off');
    await subscribeHere(s);
    setStatus('on');
  };
  await sync();
  // Subscriptions are per business: register again in the one the person switches to.
  const stopSwitch = onBusinessChange(() => {
    if (status === 'on') void sync().catch((e) => console.warn('Web push:', e));
  });
  return () => {
    stopSwitch();
    navigator.serviceWorker.removeEventListener('message', onWorkerMessage);
    session = undefined;
    setStatus(undefined);
  };
}

/**
 * Turn notifications on in this browser: ask for permission (call it from a click), subscribe,
 * register. Answers where it stands after.
 */
export async function enableWebPush(): Promise<PushStatus> {
  const s = session;
  if (!s) return status ?? 'unsupported';
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission === 'denied') {
    setStatus('blocked');
    return 'blocked';
  }
  if (permission !== 'granted') {
    setStatus('off');
    return 'off';
  }
  remember(false);
  await subscribeHere(s);
  setStatus('on');
  return 'on';
}

/** This browser gets no more pushes: unsubscribe it and forget it on the server. */
async function forgetHere(): Promise<void> {
  const sub = await session?.registration.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => undefined);
  await api.push.forget({ endpoint }).catch(() => undefined);
}

/** Turn notifications off in this browser, and keep them off at the next sign-in. */
export async function disableWebPush(): Promise<void> {
  remember(true);
  await forgetHere();
  if (session) setStatus(Notification.permission === 'denied' ? 'blocked' : 'off');
}

/** At sign-out: this browser stops getting the person's pushes. */
export async function signOutWebPush(): Promise<void> {
  await forgetHere();
}
