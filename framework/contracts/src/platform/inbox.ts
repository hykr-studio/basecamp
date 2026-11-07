/**
 * The in-app inbox (the framework's inbox feature): what notifications that list the `inapp`
 * channel left for a person, in the business they work in. And the comments feature's routes.
 */
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';

// /api/inbox: the inbox feature's routes. /api/comments: the comments feature's (its commands are
// platform commands; listing and the mention picker are its own controller's).
reserveRoutes('inbox', 'comments');

/** One item in a person's inbox. */
export const InboxEntry = z.object({
  id: z.string(),
  /** The notification that left it: 'comment.mention'. */
  notification: z.string(),
  title: z.string(),
  body: z.string(),
  /** An app path to open, when the notification gave one. */
  url: z.string().nullable(),
  /** The record it is about, to open with the app's link for that type. */
  record: z.object({ type: z.string(), id: z.string() }).nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type InboxEntry = z.infer<typeof InboxEntry>;

/** GET /api/inbox: newest first. */
export const InboxQuery = z.object({
  /** Only what is not read yet. */
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type InboxQuery = z.input<typeof InboxQuery>;

export const InboxPage = z.object({
  items: z.array(InboxEntry),
  nextCursor: z.string().nullable(),
  /** How many items are not read yet, in this business. */
  unread: z.number().int(),
});
export type InboxPage = z.infer<typeof InboxPage>;

/** POST /api/inbox/read: these items, or every one. */
export const MarkInboxRead = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100).optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => (v.ids === undefined) !== (v.all === undefined), {
    message: 'Send ids, or all: true',
  });
export type MarkInboxRead = z.infer<typeof MarkInboxRead>;
