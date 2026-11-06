import {
  type Comment,
  CommentCapabilities,
  type CommentOn,
  type CommentPage,
  type CommentsPolicy,
  commentsPolicyOf,
  type ListCommentsQuery,
  MAX_MENTIONS,
  type Mention,
  type MentionablePage,
  type MentionableQuery,
  mentionLabel,
  mentionRefs,
  mentionToken,
  type Principal,
  rewriteMentions,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  type Conn,
  entityDef,
  PrincipalResolver,
  projectRead,
} from '@hykr/core';
import { comments, type Database, memberships, user } from '@hykr/db';
import { can, userIdOf } from '@hykr/policy';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { ServerContext } from '../../hooks.js';
import { DB } from '../../infra/db.module.js';
import { serverContext } from '../../queues/jobs.service.js';
import { decodeKeyset, encodeKeyset, olderThan } from '../inbox/cursor.js';
import { type MentionContext, type MentionKind, mentionKinds } from './mention-kinds.js';

export type CommentRow = typeof comments.$inferSelect;

/** The record a comment is on, as the caller reads it. */
export interface Parent {
  def: AnyEntityDef;
  row: Record<string, unknown>;
  on: CommentOn;
  /** How its entity takes comments; null: it takes none. */
  policy: CommentsPolicy | null;
}

/** What a body's mentions come to: the body with checked labels, who it names, and whether any is refused. */
export interface ResolvedMentions {
  body: string;
  mentions: Mention[];
  refused: boolean;
}

const notFound = (label: string) =>
  new NotFoundException({ error: 'not_found', message: `No such ${label}` });

const internalOk = (p: Principal) => can(p, CommentCapabilities.internal);

/** `%` and `_` typed by a person match themselves. */
const likeEscaped = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

let current: CommentsService | undefined;

/** The comments service of this process (the comment commands read it when they run). */
export function commentsService(): CommentsService {
  if (!current) throw new Error('The comments feature is not loaded');
  return current;
}

/**
 * Comments on records: a comment is reached only through the record it is on, by whoever may read
 * that record now (and team-only ones by holders of comments.internal). The commands write them
 * (commands.ts); this reads them, checks mentions, and answers the live stream.
 */
@Injectable()
export class CommentsService implements OnModuleInit {
  readonly ctx: ServerContext;

  constructor(
    @Inject(DB) readonly db: Database,
    @Inject(ModuleRef) ref: ModuleRef,
    private readonly resolver: PrincipalResolver,
  ) {
    this.ctx = serverContext(ref);
  }

  onModuleInit() {
    current = this;
  }

  /**
   * The record p means, read as p reads it: an entity this server serves, and a row p reaches
   * (the entity's scoped read, as GET does; the assistant also needs the entity's get exposed to
   * it). Anything else is 404; an unknown entity is 400.
   */
  async parent(conn: Conn, p: Principal, on: CommentOn): Promise<Parent> {
    const def = entityDef(on.entity);
    if (!def)
      throw new BadRequestException({
        error: 'unknown_entity',
        message: `There is no record type "${on.entity}"`,
      });
    const label = def.spec.label;
    if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') throw notFound(label);
    const row = await def.repo.find(conn, p, on.id);
    if (!row) throw notFound(label);
    return {
      def,
      row: row as Record<string, unknown>,
      on: { entity: def.name, id: on.id },
      policy: commentsPolicyOf(def.spec),
    };
  }

  /** May p read this comment now: its record, its audience, comments still taken there. */
  async readable(conn: Conn, p: Principal, row: CommentRow): Promise<boolean> {
    if (row.internal && !internalOk(p)) return false;
    const def = entityDef(row.resourceType);
    if (!def || !commentsPolicyOf(def.spec)) return false;
    if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') return false;
    return !!(await def.repo.find(conn, p, row.resourceId));
  }

  /** One comment of p's business by id, if p may read it; else 404. */
  async load(conn: Conn, p: Principal, id: string): Promise<CommentRow> {
    const [row] = await conn
      .select()
      .from(comments)
      .where(and(eq(comments.id, id), eq(comments.tenantId, p.tenantId ?? '')))
      .limit(1);
    if (!row || !(await this.readable(conn, p, row))) throw notFound('comment');
    return row;
  }

  /** The person's name, as comments show it. */
  async nameOf(conn: Conn, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const [row] = await conn.select({ name: user.name }).from(user).where(eq(user.id, userId));
    return row?.name ?? null;
  }

  /** Comments as p reads them: authors' names, and what p may do with each. */
  async present(conn: Conn, rows: readonly CommentRow[], p: Principal): Promise<Comment[]> {
    const ids = [...new Set(rows.flatMap((r) => (r.authorId ? [r.authorId] : [])))];
    const names = new Map(
      ids.length
        ? (
            await conn
              .select({ id: user.id, name: user.name })
              .from(user)
              .where(inArray(user.id, ids))
          ).map((u) => [u.id, u.name])
        : [],
    );
    const me = p.actor.kind === 'user' ? userIdOf(p) : null;
    const moderator = can(p, CommentCapabilities.moderate);
    return rows.map((r) => {
      const mine = !!me && r.authorId === me;
      const comment: Comment = {
        id: r.id,
        on: { entity: r.resourceType, id: r.resourceId },
        body: r.body,
        mentions: (r.mentions ?? []) as Mention[],
        internal: r.internal,
        anchor: r.anchor ?? null,
        author: { id: r.authorId, name: r.authorId ? (names.get(r.authorId) ?? null) : null },
        createdBy: r.createdBy,
        editedAt: r.editedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        can: { edit: mine, remove: !!me && (mine || moderator) },
      };
      return projectRead('comment', comment as unknown as Record<string, unknown>, p) as Comment;
    });
  }

  /** One record's comments, newest first, as p may read them. */
  async list(p: Principal, q: z.output<typeof ListCommentsQuery>): Promise<CommentPage> {
    const parent = await this.parent(this.db, p, { entity: q.entity, id: q.id });
    if (!parent.policy) return { items: [], nextCursor: null };
    const rows = await this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.tenantId, p.tenantId ?? ''),
          eq(comments.resourceType, parent.on.entity),
          eq(comments.resourceId, parent.on.id),
          internalOk(p) ? undefined : eq(comments.internal, false),
          q.cursor ? olderThan(decodeKeyset(q.cursor), comments.createdAt, comments.id) : undefined,
        ),
      )
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: await this.present(this.db, items, p),
      nextCursor: rows.length > q.limit && last ? encodeKeyset(last) : null,
    };
  }

  private context(conn: Conn, p: Principal, parent: Parent, internal: boolean): MentionContext {
    return {
      principal: p,
      tenantId: p.tenantId ?? '',
      on: parent.on,
      internal,
      conn,
      ctx: this.ctx,
    };
  }

  /** Who a comment on this record may name, for a word typed after @. */
  async mentionable(p: Principal, q: z.output<typeof MentionableQuery>): Promise<MentionablePage> {
    const parent = await this.parent(this.db, p, { entity: q.entity, id: q.id });
    if (!parent.policy || (q.internal && !internalOk(p))) return { items: [] };
    const items: Mention[] = [];
    for (const kind of mentionKinds.all()) {
      if (!kind.suggest) continue;
      const found = await kind.suggest({
        ...this.context(this.db, p, parent, q.internal),
        q: q.q ?? '',
        limit: 10,
      });
      items.push(
        ...found.map((m) => ({ kind: kind.kind, id: m.id, label: mentionLabel(m.label) })),
      );
    }
    return { items: items.slice(0, 10) };
  }

  /**
   * A body's mentions, checked: each target must be one its kind lets this comment name. Labels
   * become the names the server knows. A token of an unknown kind, or a target its kind refuses,
   * makes `refused` true; more than MAX_MENTIONS targets is 400.
   */
  async mentions(
    conn: Conn,
    p: Principal,
    parent: Parent,
    body: string,
    internal: boolean,
  ): Promise<ResolvedMentions> {
    const refs = mentionRefs(body);
    if (refs.length > MAX_MENTIONS)
      throw new BadRequestException({
        error: 'too_many_mentions',
        message: `A comment names at most ${MAX_MENTIONS} people`,
      });
    const labels = new Map<string, string>();
    let refused = false;
    const byKind = new Map<string, string[]>();
    for (const r of refs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
    for (const [kindName, ids] of byKind) {
      const kind = mentionKinds.get(kindName);
      if (!kind) {
        refused = true;
        continue;
      }
      const allowed = await kind.resolve({ ...this.context(conn, p, parent, internal), ids });
      for (const id of ids) {
        const label = allowed.get(id);
        if (label === undefined) refused = true;
        else labels.set(`${kindName}:${id}`, mentionLabel(label));
      }
    }
    const mentions = refs.flatMap((r) => {
      const label = labels.get(`${r.kind}:${r.id}`);
      return label === undefined ? [] : [{ kind: r.kind, id: r.id, label }];
    });
    const rewritten = rewriteMentions(body, (t) => {
      const label = labels.get(`${t.kind}:${t.id}`);
      return label === undefined ? undefined : mentionToken({ ...t, label });
    });
    return { body: rewritten, mentions, refused };
  }

  /** A member of this business as a principal of their own (their roles here, today). */
  async memberPrincipal(userId: string, tenantId: string): Promise<Principal | undefined> {
    try {
      const standing = await this.resolver.forUser(userId, { tenantId, channel: 'app' });
      return { actor: { kind: 'user', id: userId }, ...standing, scopes: [], channel: 'app' };
    } catch {
      return undefined;
    }
  }

  /** May this member read the record (and, for a team-only comment, team-only comments)? */
  async memberMayRead(
    conn: Conn,
    member: Principal,
    on: CommentOn,
    internal: boolean,
  ): Promise<boolean> {
    if (internal && !internalOk(member)) return false;
    const def = entityDef(on.entity);
    if (!def) return false;
    return !!(await def.repo.find(conn, member, on.id));
  }

  /** The live stream's check: may p read this comment now? */
  async visible(p: Principal, id: string): Promise<boolean> {
    try {
      await this.load(this.db, p, id);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * People: members of the comment's business who may read the record now (and, for a team-only
 * comment, hold comments.internal), named as their account is.
 */
@Injectable()
export class UserMentions implements MentionKind, OnModuleInit {
  readonly kind = 'user';

  constructor(private readonly comments: CommentsService) {}

  onModuleInit() {
    if (mentionKinds.get(this.kind) !== this) mentionKinds.register(this);
  }

  /** Members among these ids, with their names. */
  private async members(conn: Conn, tenantId: string, where: SQL | undefined, limit: number) {
    return conn
      .select({ id: user.id, name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), where))
      .orderBy(user.name)
      .limit(limit);
  }

  private async allowed(a: MentionContext, member: { id: string }) {
    const p = await this.comments.memberPrincipal(member.id, a.tenantId);
    return !!p && (await this.comments.memberMayRead(a.conn, p, a.on, a.internal));
  }

  async resolve(a: MentionContext & { ids: readonly string[] }) {
    const out = new Map<string, string>();
    if (!a.ids.length) return out;
    const found = await this.members(
      a.conn,
      a.tenantId,
      inArray(user.id, [...a.ids]),
      a.ids.length,
    );
    for (const m of found) if (await this.allowed(a, m)) out.set(m.id, m.name);
    return out;
  }

  async suggest(a: MentionContext & { q: string; limit: number }) {
    const q = likeEscaped(a.q.trim());
    const where = q ? or(ilike(user.name, `${q}%`), ilike(user.name, `% ${q}%`)) : undefined;
    const out: { id: string; label: string }[] = [];
    // Look at a bounded number of names: each needs an access check.
    for (const m of await this.members(a.conn, a.tenantId, where, 50)) {
      if (out.length >= a.limit) break;
      if (await this.allowed(a, m)) out.push({ id: m.id, label: m.name });
    }
    return out;
  }
}
