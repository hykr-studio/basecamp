import type { Lang, Noun } from './lang.js';
import { t } from './messages.js';

/**
 * Words for dates, times and counts, in the person's language and time zone; no ids, no ISO
 * strings. English keeps the day-month order people here read ("Mon 5 Oct, 14:30").
 */
const LOCALE: Record<Lang, string> = { en: 'en-GB', hi: 'hi-IN', te: 'te-IN' };
export const localeOf = (lang: Lang) => LOCALE[lang];

/** "Mon 5 Oct", from YYYY-MM-DD. */
export function dayText(ymd: string, lang: Lang = 'en'): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString(LOCALE[lang], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "Mon 5 Oct, 14:30", from an ISO date-time. */
export function whenText(iso: string, timeZone: string, lang: Lang = 'en'): string {
  return new Date(iso).toLocaleString(LOCALE[lang], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/** "14:30". */
export function clockText(iso: string, timeZone: string, lang: Lang = 'en'): string {
  return new Date(iso).toLocaleTimeString(LOCALE[lang], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/**
 * "Monday 5 October at 2:30 pm": the form to say aloud. Spoken, the short forms ("Mon",
 * "02:30") read as clipped words and digits.
 */
export function spokenWhen(iso: string, timeZone: string, lang: Lang = 'en'): string {
  return new Date(iso).toLocaleString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

/** "Monday 5 October", from YYYY-MM-DD, to say aloud. */
export function spokenDay(ymd: string, lang: Lang = 'en'): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** Singular or plural: Intl's rule where the runtime has it (Hermes may not), else n === 1. */
function isOne(n: number, lang: Lang) {
  return typeof Intl.PluralRules === 'function'
    ? new Intl.PluralRules(LOCALE[lang]).select(n) === 'one'
    : n === 1;
}

/** "3 to-dos", "1 to-do"; "3 काम". */
export function count(n: number, noun: Noun, lang: Lang = 'en'): string {
  const [one, many] = noun[lang];
  return `${n} ${isOne(n, lang) ? one : many}`;
}

/** The first few names, then "and N more". */
export function firstFew(names: string[], lang: Lang = 'en', n = 3): string {
  if (names.length <= n) return names.join(', ');
  return `${names.slice(0, n).join(', ')}, ${t(lang, 'said.andMore', { n: names.length - n })}`;
}
