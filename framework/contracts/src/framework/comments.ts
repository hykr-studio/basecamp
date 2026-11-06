import type { z } from 'zod';
import type { ApprovalRule, EntitySpec } from './spec.js';

/**
 * Comments on records (the framework's comments feature): every record a person can read takes
 * comments, unless its entity says `comments: false`. The object form says when an added comment
 * waits for approval, and what a comment's anchor may hold on this entity's records:
 *
 *   traits: { comments: { approval: (p) => p.actor.kind === 'agent', anchor: z.object({ version: z.number() }) } }
 */
declare module './traits.js' {
  interface EntityTraits {
    comments?: false | CommentsPolicy;
  }
}

/** How an entity's records take comments. */
export interface CommentsPolicy {
  /**
   * When an added comment waits for approval, checked with the action `comment`, the input
   * (body, internal, anchor) and the record. Its object form also says who decides. Default:
   * never.
   */
  approval?: ApprovalRule;
  /**
   * What an anchor (a JSON object) may hold: a version, a point on a drawing. Validated on every
   * add. Without it, a comment here has no anchor.
   */
  anchor?: z.ZodType;
}

/** An entity's comment policy, or null when its records take no comments. */
export function commentsPolicyOf(spec: Pick<EntitySpec, 'traits'>): CommentsPolicy | null {
  const trait = spec.traits?.comments;
  return trait === false ? null : (trait ?? {});
}

/* ── Mention tokens ────────────────────────────────────────────────────────── */

/** The longest text a comment holds, in characters. */
export const COMMENT_BODY_MAX = 4000;
/** The most different people (or agents) one comment names. */
export const MAX_MENTIONS = 20;
/** The longest label a mention token keeps. */
export const MENTION_LABEL_MAX = 100;

/** A mention kind: 'user'; a feature adds its own ('agent'). */
export const MENTION_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/** Someone a comment names, by kind and id. */
export type MentionRef = { kind: string; id: string };
/** A mention as it is shown: with the name the server knows. */
export type MentionWithLabel = MentionRef & { label: string };

/** `@[Ana Rao](user:4b1…)`: a label, then the kind and id. */
const TOKEN = /@\[([^\]\n]{1,100})\]\(([a-z][a-z0-9_-]{0,31}):([^)\s]{1,128})\)/g;

/** One token as it appears in a body. */
export type MentionToken = MentionWithLabel & { start: number; end: number; text: string };

/** The mention tokens in a body, in order (a repeat is listed again). */
export function mentionTokens(body: string): MentionToken[] {
  return [...body.matchAll(TOKEN)].map((m) => {
    const start = m.index ?? 0;
    return { label: m[1], kind: m[2], id: m[3], start, end: start + m[0].length, text: m[0] };
  });
}

/** The different targets a body names, in order of first mention. */
export function mentionRefs(body: string): MentionRef[] {
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  for (const t of mentionTokens(body)) {
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: t.kind, id: t.id });
  }
  return out;
}

/** A label that fits in a token: no brackets or line breaks, at most 100 characters. */
export function mentionLabel(name: string): string {
  const clean = name
    .replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'))
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || '?').slice(0, MENTION_LABEL_MAX);
}

/** The token for a mention: `@[label](kind:id)`. */
export const mentionToken = (m: MentionWithLabel) =>
  `@[${mentionLabel(m.label)}](${m.kind}:${m.id})`;

/**
 * The body with each token replaced by what `replace` returns for it (undefined keeps the token
 * as it is). Text between tokens is kept.
 */
export function rewriteMentions(
  body: string,
  replace: (token: MentionToken) => string | undefined,
): string {
  let out = '';
  let at = 0;
  for (const t of mentionTokens(body)) {
    out += body.slice(at, t.start) + (replace(t) ?? t.text);
    at = t.end;
  }
  return out + body.slice(at);
}

/** The body as plain text: each token as `@label`. */
export const plainComment = (body: string) => rewriteMentions(body, (t) => `@${t.label}`);

/** The first characters of a comment as plain text, on one line, for a notification. */
export function commentExcerpt(body: string, max = 200): string {
  const text = plainComment(body).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
