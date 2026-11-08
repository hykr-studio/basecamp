// Changing a business's settings (docs/decisions/H2.md): a JSON merge patch (RFC 7396) of what
// the business stored, parsed by the section's schema, every key the schema does not know
// refused. Pure, so an app can check a change before it sends it.
import { z } from 'zod';
import { TenantSettings } from '../principal.js';
import {
  editableSection,
  GENERAL_SETTINGS,
  type SettingsKey,
  type TenantSettingsSections,
} from './sections.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys no setting may have: they would reach an object's prototype. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A change to a settings value: an object changes key by key, `null` removes a key (its default
 * applies again), anything else (a list included) replaces the value.
 */
export type SettingsPatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: SettingsPatch<T[K]> | null }
    : T;

/** The patch applied to the target (RFC 7396). Neither is changed. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The merge patch that turns `before` into `after` (both objects): keys `after` lacks become
 * `null`, changed values are sent whole (a nested object as its own patch), equal ones are left
 * out. An editor that shows a section's value sends this, so what the business did not change
 * stays as it was stored.
 */
export function patchBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(before)) if (!(k in after)) out[k] = null;
  for (const [k, v] of Object.entries(after)) {
    const was = before[k];
    if (isObject(was) && isObject(v)) {
      const inner = patchBetween(was, v);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (!same(was, v)) out[k] = v;
  }
  return out;
}

const join = (at: string, key: string) => (at ? `${at}.${key}` : key);

/**
 * The paths of a patch its parsed result does not have: keys the schema does not know, which a
 * parse drops without a word. A key the patch removes (`null`) is not looked for.
 */
export function unknownSettings(patch: unknown, parsed: unknown, at = ''): string[] {
  if (!isObject(patch)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const path = join(at, k);
    if (FORBIDDEN.has(k)) {
      out.push(path);
      continue;
    }
    if (v === null) continue;
    if (!isObject(parsed) || !Object.hasOwn(parsed, k)) {
      out.push(path);
      continue;
    }
    const got = parsed[k];
    if (isObject(v)) out.push(...unknownSettings(v, got, path));
    else if (Array.isArray(v) && Array.isArray(got))
      v.forEach((item, i) => {
        if (isObject(item)) out.push(...unknownSettings(item, got[i], `${path}[${i}]`));
      });
  }
  return out;
}

/** A parse's issues as problems, one per issue, by dotted path under `prefix`. */
export function settingsIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    return `${path}: ${issue.message}`;
  });
}

/** A section's next value, or why there is none. */
export type PatchedSettings<T> =
  | { ok: true; stored: unknown; value: T }
  | { ok: false; problems: string[] };

/**
 * What a business's patch makes of one settings value: `stored` (what the business had set)
 * merged with `patch`, which is what is kept, and `value`, its parse (defaults applied). Fails
 * with the problems: the parse's issues and every key the schema does not know.
 */
export function patchSettings<T>(
  schema: z.ZodType<T>,
  stored: unknown,
  patch: Record<string, unknown>,
  prefix: string,
): PatchedSettings<T> {
  const merged = mergePatch(stored === undefined ? {} : stored, patch);
  const parsed = schema.safeParse(merged);
  if (!parsed.success) return { ok: false, problems: settingsIssues(parsed.error, prefix) };
  const unknown = unknownSettings(patch, parsed.data, prefix);
  if (unknown.length) return { ok: false, problems: unknown.map((p) => `${p}: not a setting`) };
  return { ok: true, stored: merged, value: parsed.data };
}

/* ── The base settings a business changes: `general` ───────────────────── */

/** The base settings the `general` section covers, as top-level keys of the stored settings. */
export const GENERAL_KEYS = ['timeZone', 'quietHours', 'replyTime', 'marketingPerWeek'] as const;
export type GeneralKey = (typeof GENERAL_KEYS)[number];

/** Is this a time zone the runtime knows ('Europe/Berlin', 'UTC')? */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * The base settings a business changes itself, defaults applied, checked more strictly than
 * stored settings are read: a zone the runtime knows (an unknown one would stop every clock
 * counted in business hours) and times of day.
 */
export const GeneralSettings = TenantSettings.pick({
  timeZone: true,
  quietHours: true,
  replyTime: true,
  marketingPerWeek: true,
}).superRefine((s, ctx) => {
  if (!isTimeZone(s.timeZone))
    ctx.addIssue({
      code: 'custom',
      path: ['timeZone'],
      message: `"${s.timeZone}" is not a time zone (use one such as "Europe/Berlin" or "UTC")`,
    });
  for (const end of ['from', 'to'] as const)
    if (!TimeOfDay.safeParse(s.quietHours[end]).success)
      ctx.addIssue({
        code: 'custom',
        path: ['quietHours', end],
        message: 'A time of day: HH:MM',
      });
  if (s.replyTime.trim().length === 0 || s.replyTime.length > 60)
    ctx.addIssue({ code: 'custom', path: ['replyTime'], message: 'Say it in 1 to 60 characters' });
  if (s.marketingPerWeek > 100)
    ctx.addIssue({ code: 'custom', path: ['marketingPerWeek'], message: 'At most 100 a week' });
});
export type GeneralSettings = z.infer<typeof GeneralSettings>;

/** The `general` keys of stored settings, as the business set them. */
export function storedGeneral(settings: unknown): Record<string, unknown> {
  const stored = isObject(settings) ? settings : {};
  return Object.fromEntries(GENERAL_KEYS.filter((k) => k in stored).map((k) => [k, stored[k]]));
}

/* ── Types for clients ─────────────────────────────────────────────────── */

/** What the generic writer changes: an editable section, or the base settings' `general`. */
export type EditableSettingsKey = SettingsKey | typeof GENERAL_SETTINGS;

/** The value of an editable section, defaults applied. */
export type EditableSettingsValue<K extends EditableSettingsKey> = K extends SettingsKey
  ? TenantSettingsSections[K]
  : GeneralSettings;

/** Is this a section the generic writer changes (an editable section, or `general`)? */
export const isEditableSettings = (key: string): boolean =>
  key === GENERAL_SETTINGS || editableSection(key) !== undefined;
