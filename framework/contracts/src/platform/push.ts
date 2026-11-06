/**
 * Push notifications (the framework's push feature): a signed-in person's phone registers its
 * Expo push token for the business they work in, and notifications that list `push` reach it.
 */
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';

// /api/push/tokens: the push feature's own routes.
reserveRoutes('push');

/** The phones push reaches. Web push is not supported. */
export const PushPlatform = z.enum(['ios', 'android']);
export type PushPlatform = z.infer<typeof PushPlatform>;

/** POST /api/push/tokens: this device, for the signed-in person, in their business. */
export const RegisterPushToken = z.object({
  /** An Expo push token: ExponentPushToken[…]. */
  token: z.string().min(1).max(256),
  platform: PushPlatform,
});
export type RegisterPushToken = z.infer<typeof RegisterPushToken>;

/** POST /api/push/tokens/forget: this device gets no more pushes. Needs no session. */
export const ForgetPushToken = z.object({ token: z.string().min(1).max(256) });
export type ForgetPushToken = z.infer<typeof ForgetPushToken>;

/** One registered device, as its owner sees it: the token shortened. */
export const PushDevice = z.object({
  id: z.string(),
  platform: PushPlatform,
  /** The token's first characters and an ellipsis: enough to tell devices apart. */
  token: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type PushDevice = z.infer<typeof PushDevice>;
