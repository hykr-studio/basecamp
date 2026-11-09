import { type Labels, type Lang, pick } from '@hykr/i18n';

type LabelMap = Readonly<Record<string, Labels | undefined>>;
type SpecLike = {
  readonly fieldLabels?: unknown;
  readonly traits?: { readonly parent?: { readonly entity?: string } };
};

/**
 * The labels of the records that sit under a `type` record (entities whose `parent` trait names
 * it): what an approval's list of lines calls each field. Generic: the module named them.
 */
export function childLabels(specs: readonly SpecLike[], type: string | undefined): LabelMap {
  if (!type) return {};
  const out: Record<string, Labels | undefined> = {};
  for (const spec of specs) {
    if (spec.traits?.parent?.entity !== type || !spec.fieldLabels) continue;
    Object.assign(out, spec.fieldLabels as LabelMap);
  }
  return out;
}

/**
 * An item's fields that its entity names, as "Label value" parts after its title: a line's
 * quantity and price, in the module's words. A field nobody named (a key, a position) is left
 * out, and so is anything but a number or a short text.
 */
export function labelledParts(
  item: Readonly<Record<string, unknown>>,
  labels: LabelMap,
  lang: Lang,
  skip: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(item)) {
    const label = labels[key];
    if (!label || skip.has(key)) continue;
    const shown =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string' && value.length > 0 && value.length <= 40
          ? value
          : null;
    if (shown !== null) out.push(`${pick(label, lang)} ${shown}`);
  }
  return out;
}
