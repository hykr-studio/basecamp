import type { Lang } from './lang.js';
import { type MessagePart, mergeMessages } from './messages/define.js';
import * as parts from './messages/index.js';

/**
 * The framework's own words: what the assistant says about the screen, approvals, the voice
 * controls and the channels. Each feature keeps its phrases in messages/<feature>.ts
 * (`defineMessages`), listed in messages/index.ts. A domain's words (view titles, field names,
 * its verbs) live with the domain, as Labels. `{name}` is filled by t().
 */
type Parts = typeof parts;

/** Every framework phrase's key: the keys of every part. */
export type MessageKey = {
  [P in keyof Parts]: Parts[P] extends MessagePart<infer K> ? K : never;
}[keyof Parts];
type Catalog = Readonly<Record<MessageKey, string>>;

export const catalogs = mergeMessages(Object.values(parts)) as Readonly<Record<Lang, Catalog>>;

/** A framework phrase in this language, with {name} filled from vars. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const phrase = catalogs[lang][key] || catalogs.en[key];
  return phrase.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
