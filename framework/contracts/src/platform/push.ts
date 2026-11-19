/**
 * Push notifications (the framework's push feature): a signed-in person's phone registers its
 * Expo push token, and a browser its Web Push subscription, for the business they work in.
 * Notifications that list `push` or `webpush` reach them.
 */
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';

// /api/push/tokens, /api/push/web: the push feature's own routes.
reserveRoutes('push');

/** Where push reaches: a phone (Expo) or a browser (Web Push). */
export const PushPlatform = z.enum(['ios', 'android', 'web']);
export type PushPlatform = z.infer<typeof PushPlatform>;

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export const WebPushSubscription = z.object({
  /** The push service's address for this browser: https, on a known push service. */
  endpoint: z.string().min(1).max(1024),
  /** When the browser lets the subscription lapse, if it says. Not used. */
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    /** The browser's P-256 public key, base64url. */
    p256dh: z.string().min(1).max(256),
    /** The browser's authentication secret, base64url. */
    auth: z.string().min(1).max(64),
  }),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;

/**
 * POST /api/push/tokens: this device or browser, for the signed-in person, in their business.
 * A phone sends its Expo push token, a browser its subscription.
 */
export const RegisterPushToken = z.union([
  z.object({
    /** An Expo push token: ExponentPushToken[…]. */
    token: z.string().min(1).max(256),
    platform: z.enum(['ios', 'android']),
  }),
  z.object({ platform: z.literal('web'), subscription: WebPushSubscription }),
]);
export type RegisterPushToken = z.infer<typeof RegisterPushToken>;

/**
 * POST /api/push/tokens/forget: this device (its token) or browser (its endpoint) gets no more
 * pushes. Needs no session.
 */
export const ForgetPushToken = z.union([
  z.object({ token: z.string().min(1).max(256) }),
  z.object({ endpoint: z.string().min(1).max(1024) }),
]);
export type ForgetPushToken = z.infer<typeof ForgetPushToken>;

/** One registered device or browser, as its owner sees it: the token or endpoint shortened. */
export const PushDevice = z.object({
  id: z.string(),
  platform: PushPlatform,
  /** The token's (or endpoint's) first characters and an ellipsis: enough to tell them apart. */
  token: z.string(),
  /** A browser's name and system ("Chrome on macOS"), when it said. */
  browser: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type PushDevice = z.infer<typeof PushDevice>;

/** GET /api/push/web/key: the server's VAPID public key, or null when web push is off. */
export const WebPushKey = z.object({ publicKey: z.string().nullable() });
export type WebPushKey = z.infer<typeof WebPushKey>;
