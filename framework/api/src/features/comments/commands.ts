// The comment commands: add, edit and remove, through the write path. Each one's own audit row
// names the record the comment is on (its entity and id), so the record's history shows it; the
// comment row is audited as `comment` besides. docs/decisions/B16.md.
import {
  AddCommentSpec,
  type ApprovalRule,
  type Approver,
  approverOf,
  type CommandSpec,
  type Comment,
  CommentCapabilities,
  commentExcerpt,
  type DecisionDetails,
  EditCommentSpec,
  type Mention,
  parksFor,
  RemoveCommentSpec,
} from '@hykr/contracts';
import {
  allow,
  type CommandConfig,
  type CommandDef,
  defineCommand,
  deny,
  type NamedEvent,
  needsApproval,
  subjectOrThrow,
  toJson,
} from '@hykr/core';
import { comments } from '@hykr/db';
import { can, userIdOf } from '@hykr/policy';
import { BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { type CommentRow, commentsService, type Parent } from './comments.service.js';

/** The largest anchor kept, as JSON. */
const ANCHOR_MAX_BYTES = 2048;

/** A comment row as events and audit keep it: the record it is on, never the reader's view. */
export function storedComment(row: CommentRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    on: { entity: row.resourceType, id: row.resourceId },
    authorId: row.authorId,
    createdBy: row.createdBy,
    body: row.body,
    mentions: row.mentions,
    internal: row.internal,
    anchor: row.anchor,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** comment.added, comment.edited, comment.removed and comment.mentioned, about one comment. */
export class CommentEvent implements NamedEvent {
  readonly resourceType = 'comment';
  constructor(
    readonly eventName: string,
    readonly row: Record<string, unknown> & { id: string },
    readonly before?: unknown,
  ) {}
  get resourceId() {
    return this.row.id;
  }
}

/** One `comment.mentioned` per target the comment newly names (never its own author). */
function mentioned(
  row: CommentRow,
  targets: readonly Mention[],
  author: { id: string | null; name: string | null },
): CommentEvent[] {
  const excerpt = commentExcerpt(row.body);
  return targets
    .filter((t) => !(t.kind === 'user' && t.id === row.authorId))
    .map(
      (target) =>
        new CommentEvent('comment.mentioned', {
          id: row.id,
          tenantId: row.tenantId,
          commentId: row.id,
          on: { entity: row.resourceType, id: row.resourceId },
          target,
          author,
          internal: row.internal,
          excerpt,
        }),
    );
}

/** Targets in `now` that `before` did not name. */
const added = (now: readonly Mention[], before: readonly Mention[]) =>
  now.filter((m) => !before.some((b) => b.kind === m.kind && b.id === m.id));

/**
 * What a parked comment says from the trait's rule (its object form): who decides, where, how
 * surely, and the application's approval level it parks at.
 */
function parkDetails(rule: ApprovalRule | undefined): DecisionDetails | undefined {
  const { by, channels, minAssurance, level } = approverOf(rule);
  const approver: Approver = {};
  if (by) approver.by = by;
  if (channels) approver.channels = [...channels];
  if (minAssurance) approver.minAssurance = minAssurance;
  const out: DecisionDetails = {};
  if (Object.keys(approver).length) out.approver = approver;
  if (level) out.level = level;
  return Object.keys(out).length ? out : undefined;
}

type OnRecord = { parent: Parent };

/**
 * A command about a comment whose own audit row and approval name the record the comment is on:
 * its `resource` is that record, known once `load` has read it.
 */
function onRecord<S extends CommandSpec, L extends OnRecord, V>(
  spec: S,
  config: Omit<CommandConfig<S, L, V>, 'resource'>,
): CommandDef<S, L, V> {
  const base = defineCommand(spec, {
    ...config,
    resource: { type: 'comment', id: (_input, loaded) => loaded.parent.on.id },
  });
  return {
    ...base,
    op: () => {
      const op = base.op();
      const load = op.load;
      let type = 'comment';
      return Object.defineProperty(
        {
          ...op,
          load: async (tx, p, input) => {
            const loaded = (await load?.(tx, p, input)) as L;
            type = loaded.parent.def.name;
            return loaded;
          },
        } as typeof op,
        'resourceType',
        { get: () => type, enumerable: true },
      );
    },
  };
}

/** The value as the writer reads it (the read projectors, as `comment`). */
const present = (value: Comment) => value;

type AddLoaded = OnRecord & {
  body: string;
  mentions: Mention[];
  refused: boolean;
  author: { id: string; name: string | null };
};

/** comment.add: a comment on a record the writer can read. */
export const AddComment = onRecord(AddCommentSpec, {
  load: async (tx, p, input): Promise<AddLoaded> => {
    const svc = commentsService();
    const authorId = subjectOrThrow(p);
    const parent = await svc.parent(tx, p, { entity: input.entity, id: input.recordId });
    if (input.anchor !== undefined) {
      const schema = parent.policy?.anchor;
      if (!schema)
        throw new BadRequestException({
          error: 'anchor_not_accepted',
          message: `A comment on a ${parent.def.spec.label} has no anchor`,
        });
      const parsed = schema.safeParse(input.anchor);
      if (!parsed.success || JSON.stringify(input.anchor).length > ANCHOR_MAX_BYTES)
        throw new BadRequestException({
          error: 'bad_anchor',
          message: `That anchor does not fit a ${parent.def.spec.label}`,
        });
    }
    const resolved = await svc.mentions(tx, p, parent, input.body, input.internal ?? false);
    return { parent, ...resolved, author: { id: authorId, name: await svc.nameOf(tx, authorId) } };
  },
  authorize: (p, loaded, input) => {
    const { parent } = loaded;
    const label = parent.def.spec.label;
    if (!parent.policy) return deny('comments_off', `A ${label} takes no comments`);
    if (input.internal && !can(p, CommentCapabilities.internal))
      return deny('internal_comments', 'Only the team writes team-only comments');
    if (loaded.refused)
      return deny(
        'mention_not_allowed',
        'Someone you mentioned cannot see this here. Remove the mention, or let them see it first.',
      );
    const rule = parent.policy.approval;
    const at = parent.def.toRead(parent.row, p) as Record<string, unknown>;
    if (parksFor(rule, p, { action: 'comment', input: { ...input }, row: at })) {
      return needsApproval(
        'comment_needs_approval',
        `Comments by the ${p.actor.kind === 'agent' ? 'assistant' : 'requester'} on this ${label} need approval`,
        parkDetails(rule),
      );
    }
    return allow('comment_on_readable', 'Comments on a record they can read');
  },
  summarize: (_input, loaded) =>
    `Comment on ${loaded.parent.def.spec.label}: "${commentExcerpt(loaded.body, 120)}"`,
  run: async ({ tx, principal, input, loaded }) => {
    const [row] = await tx
      .insert(comments)
      .values({
        tenantId: principal.tenantId ?? '',
        resourceType: loaded.parent.on.entity,
        resourceId: loaded.parent.on.id,
        authorId: loaded.author.id,
        createdBy: principal.actor.kind === 'agent' ? 'assistant' : 'person',
        body: loaded.body,
        mentions: loaded.mentions,
        internal: input.internal ?? false,
        anchor: input.anchor ?? null,
      })
      .returning();
    const stored = storedComment(row);
    const [value] = await commentsService().present(tx, [row], principal);
    return {
      value,
      touched: [{ type: 'comment', id: row.id, change: 'created', after: toJson(stored) }],
      events: [
        new CommentEvent('comment.added', stored),
        ...mentioned(row, loaded.mentions, loaded.author),
      ],
    };
  },
  present,
});

type EditLoaded = OnRecord & {
  comment: CommentRow;
  body: string;
  mentions: Mention[];
  refused: boolean;
  author: { id: string | null; name: string | null };
};

/** comment.edit: the author's new text. People newly named are told. */
export const EditComment = onRecord(EditCommentSpec, {
  load: async (tx, p, input): Promise<EditLoaded> => {
    const svc = commentsService();
    subjectOrThrow(p);
    const comment = await svc.load(tx, p, input.commentId);
    const parent = await svc.parent(tx, p, {
      entity: comment.resourceType,
      id: comment.resourceId,
    });
    const resolved = await svc.mentions(tx, p, parent, input.body, comment.internal);
    const author = { id: comment.authorId, name: await svc.nameOf(tx, comment.authorId) };
    return { parent, comment, ...resolved, author };
  },
  authorize: (p, loaded) => {
    if (!loaded.comment.authorId || loaded.comment.authorId !== userIdOf(p))
      return deny('not_author', 'Only its author edits a comment');
    if (loaded.refused)
      return deny(
        'mention_not_allowed',
        'Someone you mentioned cannot see this here. Remove the mention, or let them see it first.',
      );
    return allow('author_edits', 'The author edits their comment');
  },
  summarize: (_input, loaded) => `Edit a comment on ${loaded.parent.def.spec.label}`,
  run: async ({ tx, principal, loaded }) => {
    const before = loaded.comment;
    const [row] = await tx
      .update(comments)
      .set({ body: loaded.body, mentions: loaded.mentions, editedAt: new Date() })
      .where(and(eq(comments.id, before.id), eq(comments.tenantId, before.tenantId)))
      .returning();
    const stored = storedComment(row);
    const previous = storedComment(before);
    const [value] = await commentsService().present(tx, [row], principal);
    return {
      value,
      touched: [
        {
          type: 'comment',
          id: row.id,
          change: 'updated',
          before: toJson(previous),
          after: toJson(stored),
        },
      ],
      events: [
        new CommentEvent('comment.edited', stored, previous),
        ...mentioned(row, added(loaded.mentions, before.mentions as Mention[]), loaded.author),
      ],
    };
  },
  present,
});

type RemoveLoaded = OnRecord & { comment: CommentRow };

/** comment.remove: the author's own, or anyone's with comments.moderate. */
export const RemoveComment = onRecord(RemoveCommentSpec, {
  load: async (tx, p, input): Promise<RemoveLoaded> => {
    const svc = commentsService();
    subjectOrThrow(p);
    const comment = await svc.load(tx, p, input.commentId);
    const parent = await svc.parent(tx, p, {
      entity: comment.resourceType,
      id: comment.resourceId,
    });
    return { parent, comment };
  },
  authorize: (p, { comment }) => {
    const mine = !!comment.authorId && comment.authorId === userIdOf(p);
    if (mine) return allow('author_removes', 'The author removes their comment');
    if (can(p, CommentCapabilities.moderate))
      return allow('moderator_removes', 'A moderator removes a comment');
    return deny('not_author', 'Only its author, or a moderator, removes a comment');
  },
  summarize: (_input, loaded) => `Remove a comment on ${loaded.parent.def.spec.label}`,
  run: async ({ tx, loaded }) => {
    const before = loaded.comment;
    await tx
      .delete(comments)
      .where(and(eq(comments.id, before.id), eq(comments.tenantId, before.tenantId)));
    const previous = storedComment(before);
    return {
      value: { id: before.id, removed: true as const },
      touched: [{ type: 'comment', id: before.id, change: 'deleted', before: toJson(previous) }],
      events: [new CommentEvent('comment.removed', previous, previous)],
    };
  },
});
