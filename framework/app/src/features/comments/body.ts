// A comment's text in the app, without React Native: its parts to draw, the word being typed
// after @, and the tokens a sent comment carries for the people picked.
import { type MentionWithLabel, mentionToken, mentionTokens } from '@hykr/contracts';

/** One run of a comment's text: words, or a person (or agent) it names. */
export type BodyPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; label: string; ref: { kind: string; id: string } };

/** A body as text and mentions, in order. */
export function bodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let at = 0;
  for (const t of mentionTokens(body)) {
    if (t.start > at) parts.push({ kind: 'text', text: body.slice(at, t.start) });
    parts.push({ kind: 'mention', label: t.label, ref: { kind: t.kind, id: t.id } });
    at = t.end;
  }
  if (at < body.length) parts.push({ kind: 'text', text: body.slice(at) });
  return parts;
}

/**
 * The word being typed after @, before the cursor: `{ start, q }` where `start` is the @'s
 * index. An @ counts at the start or after a space or line break, and the word has no line
 * break and at most 40 characters.
 */
export function mentionQuery(
  text: string,
  cursor = text.length,
): { start: number; q: string } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([^\s@][^\n@]{0,39})?$/.exec(before);
  if (!m) return null;
  const q = m[2] ?? '';
  return { start: before.length - q.length - 1, q };
}

/** The text with the @word at `start` (and `q` after it) replaced by `@Label `. */
export function pickMention(text: string, at: { start: number; q: string }, label: string) {
  const end = at.start + 1 + at.q.length;
  return `${text.slice(0, at.start)}@${label} ${text.slice(end)}`;
}

/**
 * The body to send: each picked person's `@Label`, where it is still in the text, becomes their
 * token. A name typed without picking stays plain text, and so does a pick deleted since.
 */
export function composeBody(text: string, picked: readonly MentionWithLabel[]): string {
  let out = text;
  const done = new Set<string>();
  for (const m of picked) {
    const key = `${m.kind}:${m.id}`;
    if (done.has(key)) continue;
    const plain = `@${m.label}`;
    const token = mentionToken(m);
    if (!out.includes(plain)) continue;
    out = out.split(plain).join(token);
    done.add(key);
  }
  return out.trim();
}
