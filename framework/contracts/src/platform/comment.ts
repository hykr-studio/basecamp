/**
 * Comments on records, with @-mentions (the framework's comments feature). A comment is reached
 * only through the record it is on: whoever reads the record reads its comments. Adding, editing
 * and removing are commands, so they pass the write path (rules, approvals, audit); reading is
 * GET /api/comments.
 */
import { z } from 'zod';
import { COMMENT_BODY_MAX, MENTION_KIND } from '../framework/comments.js';
import { CreatedBy, commandSpec } from '../framework/spec.js';
import { capabilities, defineCapability } from '../roles.js';

/** The record a comment is on: its entity's name ('order') and its id. */
export const CommentOn = z.object({
  entity: z.string(),
  id: z.string(),
});
export type CommentOn = z.infer<typeof CommentOn>;

/** Someone a comment names: a person ('user'), or another kind a feature registers. */
export const Mention = z.object({
  kind: z.string().regex(MENTION_KIND),
  id: z.string(),
  /** Their name, as the server knew it when the comment was written. */
  label: z.string(),
});
export type Mention = z.infer<typeof Mention>;

/** A comment as one person reads it. */
export const Comment = z.object({
  id: z.string(),
  on: CommentOn,
  /** The text, with mention tokens: @[Name](user:<id>). */
  body: z.string(),
  mentions: z.array(Mention),
  /** Only people who may read team-only comments see it (comments.internal). */
  internal: z.boolean(),
  /** Where on the record it is pinned (a version, a point), as the entity's trait allows. */
  anchor: z.unknown().nullable(),
  author: z.object({ id: z.string().nullable(), name: z.string().nullable() }),
  createdBy: CreatedBy,
  editedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** What the reader may do with it. */
  can: z.object({ edit: z.boolean(), remove: z.boolean() }),
});
export type Comment = z.infer<typeof Comment>;

const entity = z
  .string()
  .min(1)
  .max(64)
  .describe("The record's type: an entity name, as its get tool names it (get-<entity>)");
const recordId = z.string().min(1).max(128).describe("The record's id");
const body = z
  .string()
  .trim()
  .min(1)
  .max(COMMENT_BODY_MAX)
  .describe(
    'The comment. To mention someone, write @[Their name](user:<id>) with an id from list-mentionable: they are told.',
  );

export const AddCommentInput = z.object({
  entity,
  recordId,
  body,
  internal: z
    .boolean()
    .optional()
    .describe('true: only the team sees it, not customers. Only when the user asks.'),
  anchor: z
    .unknown()
    .optional()
    .describe('Where on the record it belongs, when the record type takes one. Usually leave out.'),
});
export type AddCommentInput = z.input<typeof AddCommentInput>;

/** comment.add: a comment on a record the person can read. */
export const AddCommentSpec = commandSpec({
  name: 'comment.add',
  description:
    'Add a comment to a record the user can read, as the user. Mention people with @[Name](user:<id>); they are told. Use it only when the user asks to comment or to tell someone on a record.',
  input: AddCommentInput,
  output: Comment,
  http: { method: 'POST', path: '/api/comments' },
  tool: 'add-comment',
  expose: 'all',
  approvalNote: 'Some records ask the user to approve a comment the assistant adds.',
  verb: { do: 'comment on', did: 'commented on' },
  touches: [],
});

/** comment.edit: the author changes their comment's text. */
export const EditCommentSpec = commandSpec({
  name: 'comment.edit',
  description: "Change your comment's text. People newly mentioned are told.",
  input: z.object({ commentId: z.uuid(), body }),
  output: Comment,
  http: { method: 'PATCH', path: '/api/comments/:commentId' },
  expose: 'human',
  verb: { do: 'edit a comment on', did: 'edited a comment on' },
  touches: [],
});

/** comment.remove: the author, or a moderator, removes a comment. */
export const RemoveCommentSpec = commandSpec({
  name: 'comment.remove',
  description: 'Remove a comment: your own, or any with comments.moderate.',
  input: z.object({ commentId: z.uuid() }),
  output: z.object({ id: z.string(), removed: z.literal(true) }),
  http: { method: 'DELETE', path: '/api/comments/:commentId' },
  expose: 'human',
  verb: { do: 'remove a comment on', did: 'removed a comment on' },
  touches: [],
});

/** "true" or "false" in a query string. */
const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

/** GET /api/comments: one record's comments, newest first. */
export const ListCommentsQuery = z.object({
  entity: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCommentsQuery = z.input<typeof ListCommentsQuery>;

export const CommentPage = z.object({
  items: z.array(Comment),
  /** Older comments: pass it as `cursor`. */
  nextCursor: z.string().nullable(),
});
export type CommentPage = z.infer<typeof CommentPage>;

/** GET /api/comments/mentionable: who a comment on this record may name. */
export const MentionableQuery = z.object({
  entity: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  /** The start of a word of their name. */
  q: z.string().trim().max(100).optional(),
  /** For a team-only comment. */
  internal: flag,
});
export type MentionableQuery = z.input<typeof MentionableQuery>;

export const MentionablePage = z.object({ items: z.array(Mention) });
export type MentionablePage = z.infer<typeof MentionablePage>;

/** What the framework's comments let a role do besides commenting on what it reads. */
export const CommentCapabilities = {
  /** Read, write and be mentioned in team-only comments. */
  internal: defineCapability({
    name: 'comments.internal',
    label: {
      en: 'Read and write team-only comments',
      hi: 'केवल टीम वाली टिप्पणियाँ पढ़ें और लिखें',
      te: 'టీమ్‌కు మాత్రమే ఉండే వ్యాఖ్యలను చదవండి, రాయండి',
    },
    roles: ['owner', 'admin', 'ops', 'staff'],
  }),
  /** Remove anyone's comment on a record you can read. */
  moderate: defineCapability({
    name: 'comments.moderate',
    label: {
      en: "Remove other people's comments",
      hi: 'दूसरों की टिप्पणियाँ हटाएँ',
      te: 'ఇతరుల వ్యాఖ్యలను తొలగించండి',
    },
    roles: ['owner', 'admin'],
  }),
} as const;

capabilities.register(...Object.values(CommentCapabilities));
