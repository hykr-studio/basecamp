// Keys someone sends (a query string's, a body's, a route's) may name what every plain object
// already has. Written into an object they reach its prototype; read from one they find a
// built-in instead of nothing (docs/decisions/V1.md).

/** Every name a plain object has before anything is put in it, and `prototype`. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]);

/** Is this a name a plain object already has (`__proto__`, `constructor`, `toString`, …)? */
export const isPrototypeKey = (key: string): boolean => PROTOTYPE_KEYS.has(key);

/** What the object holds under this key itself; never what its prototype gives. */
export const ownValue = (o: object, key: string): unknown =>
  Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;

// Text Postgres cannot keep (docs/decisions/V10.md). Its text and jsonb hold no NUL (U+0000):
// one in a query or a write is an error (22021, 22P05). jsonb refuses a lone UTF-16 surrogate
// too (22P05), and text turns one into U+FFFD without a word.

/** Why a string cannot be kept as sent, as the rule a refusal names. */
export type TextFault = 'nul_character' | 'lone_surrogate';

/** What a refusal says for each fault. */
export const TEXT_FAULTS: Readonly<Record<TextFault, string>> = {
  nul_character: 'Text may not hold the NUL character (U+0000)',
  lone_surrogate: 'Text may not hold half of a UTF-16 surrogate pair',
};

const NUL = '\u0000';
const REPLACEMENT = '\uFFFD';

/** Every surrogate in a pair: Hermes has no `String.prototype.isWellFormed`. */
function wellFormed(s: string): boolean {
  const native = (s as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === 'function') return native.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = s.charCodeAt(i + 1);
    if (c > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return false;
    i++;
  }
  return true;
}

/** What is wrong with this text for Postgres, or null. */
export function textFault(s: string): TextFault | null {
  if (s.includes(NUL)) return 'nul_character';
  return wellFormed(s) ? null : 'lone_surrogate';
}

/** The text with each character Postgres cannot keep replaced by U+FFFD, so it can be shown. */
export function storableText(s: string): string {
  if (!textFault(s)) return s;
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out.push(REPLACEMENT);
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff
    )
      out.push(s[i], s[++i]);
    else out.push(c >= 0xd800 && c <= 0xdfff ? REPLACEMENT : s[i]);
  }
  return out.join('');
}

/** Plain data as a parser leaves it: arrays and plain objects; never a Buffer or a class. */
const plainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Where the first text Postgres cannot keep is in a parsed value (`body.lines[2].title`, a key
 * or a string, at any depth), and why; or null. Walks with its own stack, so a deeply nested
 * value cannot overflow the call stack.
 */
export function unstorableTextAt(
  value: unknown,
  root: string,
): { where: string; rule: TextFault } | null {
  const stack: [unknown, string][] = [[value, root]];
  while (stack.length) {
    const [v, at] = stack.pop() as [unknown, string];
    if (typeof v === 'string') {
      const rule = textFault(v);
      if (rule) return { where: at, rule };
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], `${at}[${i}]`]);
    } else if (plainObject(v)) {
      for (const key of Object.keys(v)) {
        const rule = textFault(key);
        const named = `${at}.${storableText(key.replaceAll(NUL, '\\u0000'))}`;
        if (rule) return { where: named, rule };
        stack.push([v[key], named]);
      }
    }
  }
  return null;
}

/**
 * A copy of parsed data with every key and string made storable (`storableText`): what a report
 * of a row that could not be kept may hold. Other values are kept as they are.
 */
export function storableData(value: unknown): unknown {
  const top: Record<string, unknown> = { v: value };
  const stack: [Record<string, unknown> | unknown[], string | number][] = [[top, 'v']];
  const put = (holder: Record<string, unknown> | unknown[], key: string | number, v: unknown) =>
    Object.defineProperty(holder, key, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  while (stack.length) {
    const [holder, key] = stack.pop() as [Record<string, unknown>, string];
    const v = holder[key];
    if (typeof v === 'string') put(holder, key, storableText(v));
    else if (Array.isArray(v)) {
      const copy = v.slice();
      put(holder, key, copy);
      for (let i = 0; i < copy.length; i++) stack.push([copy, i]);
    } else if (plainObject(v)) {
      const copy: Record<string, unknown> = {};
      put(holder, key, copy);
      for (const k of Object.keys(v)) {
        const name = storableText(k);
        put(copy, name, v[k]);
        stack.push([copy, name]);
      }
    }
  }
  return top.v;
}
