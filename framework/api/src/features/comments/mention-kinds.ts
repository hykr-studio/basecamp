// Who a comment may name, by kind. Nothing here reads the configuration or loads Nest: safe to
// import from an application module or another feature at load time.
import { createHookRegistry, type Principal } from '@hykr/contracts';
import type { Conn } from '@hykr/core';
import type { ServerContext } from '../../hooks.js';

declare module '@hykr/contracts' {
  interface Contributions {
    mentionKinds: readonly MentionKind[];
  }
}

/** The comment a mention is checked for. */
export interface MentionContext {
  /** Who writes the comment. */
  principal: Principal;
  /** The comment's business. */
  tenantId: string;
  /** The record the comment is on: its entity's name and id. */
  on: { entity: string; id: string };
  /** A team-only comment (its audience holds comments.internal). */
  internal: boolean;
  /** Where to read: the write's transaction, or the database. */
  conn: Conn;
  ctx: ServerContext;
}

/**
 * One kind of mention target: people ('user', the framework's), or a feature's own (agents).
 * Only the targets `resolve` returns may be named; any other id refuses the comment, so a
 * notification never carries a comment to someone who cannot open the record.
 */
export interface MentionKind {
  /** As tokens name it: @[Name](<kind>:<id>). Lower case, unique. */
  kind: string;
  /**
   * Of these ids, the ones this comment may name, each with the name to show: in the comment's
   * business, and allowed to read the record (and, for a team-only comment, team-only comments).
   */
  resolve(a: MentionContext & { ids: readonly string[] }): Promise<ReadonlyMap<string, string>>;
  /** Who to offer for a word typed after @ (at most `limit`), each allowed as `resolve` says. */
  suggest?(
    a: MentionContext & { q: string; limit: number },
  ): Promise<readonly { id: string; label: string }[]>;
}

/** Mention kinds, by kind. Contribute them as `mentionKinds`. */
export const mentionKinds = createHookRegistry<MentionKind>('mention kind', (k) => k.kind, {
  collects: 'mentionKinds',
});
