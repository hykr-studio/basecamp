import type { Approval } from '@hykr/contracts';
import { firstFew, type Labels, type Lang, moneyText, pick } from '@hykr/i18n';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { colors, space, styles } from '../theme';
import { dayLabel } from './dates';
import { type EntityName, entityApi, specs } from './hooks';
import { useT } from './lang';

/** The resource as people say it: its label ("to-do"), not its name ("todo"). */
export const labelOf = (type: string) =>
  Object.values(specs()).find((s) => s.name === type)?.label ?? type;
const pluralOf = (type: string) =>
  (Object.entries(specs()).find(([, s]) => s.name === type)?.[0] as EntityName | undefined) ?? null;

/** camelCase → "Action items" */
const humanize = (key: string) => {
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
/**
 * What people call a field, in their language: the entity's fieldLabels, or the field's own
 * name made readable when the spec gives none.
 */
function fieldName(type: string | undefined, key: string, lang: Lang) {
  const spec = type ? Object.values(specs()).find((s) => s.name === type) : undefined;
  const labels = (spec?.fieldLabels as Record<string, Labels | undefined> | undefined)?.[key];
  if (labels) return pick(labels, lang);
  return refOf(key) ? humanize(key.slice(0, -2)) : humanize(key);
}

/** A field that points at another entity ("<entity>Id") and the list it lives in. */
const refOf = (key: string): EntityName | null => {
  if (!key.endsWith('Id')) return null;
  const plural = `${key.slice(0, -2)}s`;
  return plural in specs() ? (plural as EntityName) : null;
};
const hidden = (key: string) =>
  key === 'id' || (key.endsWith('Id') && !refOf(key)) || key === 'createdAt' || key === 'updatedAt';
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function show(key: string, value: unknown): string {
  if (key === 'createdBy') return value === 'assistant' ? 'The assistant' : 'You';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if ((key === 'dueOn' || key.endsWith('On')) && typeof value === 'string') return dayLabel(value);
  if (key.endsWith('At') && typeof value === 'string')
    return new Date(value).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  return String(value);
}

/** An amount as the framework moves it: whole minor units and an ISO 4217 currency. */
type MoneyValue = { minor: number; currency: string };
const isMoney = (v: unknown): v is MoneyValue =>
  typeof v === 'object' &&
  v !== null &&
  Number.isSafeInteger((v as MoneyValue).minor) &&
  typeof (v as MoneyValue).currency === 'string' &&
  /^[A-Z]{3}$/.test((v as MoneyValue).currency) &&
  Object.keys(v).length === 2;

/** Arrays longer than this are summed up instead of listed. */
const LIST_AT_MOST = 5;

type Row = Record<string, unknown>;
const titleOf = (item: Row) => (typeof item.title === 'string' ? item.title : null);

/** Every object in a list and under it (`children`), counted once. */
function walk(items: readonly unknown[], out: Row[] = []): Row[] {
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    out.push(item as Row);
    const children = (item as Row).children;
    if (Array.isArray(children)) walk(children, out);
  }
  return out;
}

/** Each money field's sum, where every value of it is in one currency. */
function sums(rows: readonly Row[]): { key: string; total: MoneyValue }[] {
  const keys = new Set(rows.flatMap((r) => Object.keys(r).filter((k) => isMoney(r[k]))));
  const out: { key: string; total: MoneyValue }[] = [];
  for (const key of keys) {
    const values = rows.map((r) => r[key]).filter(isMoney);
    const currency = values[0]?.currency;
    if (!currency || values.some((v) => v.currency !== currency)) continue;
    // Exact while the sum stays within 2^53, as minor units do.
    out.push({ key, total: { minor: values.reduce((a, v) => a + v.minor, 0), currency } });
  }
  return out;
}

/** A long list in a few lines: how many, the first few titles, and the money it adds up to. */
function ListSummary({ name, items }: { name: string; items: readonly unknown[] }) {
  const { lang } = useT();
  const rows = walk(items);
  const titles = rows.map(titleOf).filter((t): t is string => t !== null);
  return (
    <View style={{ gap: 2 }}>
      <Text style={styles.text}>
        {rows.length === items.length
          ? `${items.length} ${fieldName(undefined, name, lang).toLowerCase()}`
          : `${items.length} ${fieldName(undefined, name, lang).toLowerCase()}, ${rows.length} in all`}
      </Text>
      {titles.length > 0 && <Text style={styles.muted}>{firstFew(titles, lang)}</Text>}
      {sums(rows).map(({ key, total }) => (
        <Text key={key} style={styles.text}>
          {`${fieldName(undefined, key, lang)}: ${moneyText(total, lang)}`}
        </Text>
      ))}
    </View>
  );
}

function Value({ name, value }: { name: string; value: unknown }) {
  const { lang } = useT();
  if (isMoney(value)) return <Text style={styles.text}>{moneyText(value, lang)}</Text>;
  if (Array.isArray(value) && value.length > LIST_AT_MOST)
    return <ListSummary name={name} items={value} />;
  if (Array.isArray(value)) {
    return (
      <View style={{ gap: 2 }}>
        {value.map((item, i) => {
          const text =
            typeof item === 'object' && item
              ? [
                  (item as { title?: string }).title,
                  (item as { dueOn?: string }).dueOn
                    ? `due ${dayLabel((item as { dueOn: string }).dueOn)}`
                    : null,
                  ...Object.values(item as Row)
                    .filter(isMoney)
                    .map((m) => moneyText(m, lang)),
                ]
                  .filter(Boolean)
                  .join(' · ') || JSON.stringify(item)
              : String(item);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a read-only preview in input order; items may repeat
            <Text key={`${i}:${text}`} style={styles.text}>
              {'•  '}
              {text}
            </Text>
          );
        })}
      </View>
    );
  }
  if (typeof value === 'object' && value)
    return <Fields input={value as Record<string, unknown>} />;
  return <Text style={styles.text}>{show(name, value)}</Text>;
}

/** "<Label>: <title>" rather than an id. */
function RefValue({ list, id }: { list: EntityName; id: string }) {
  const q = useQuery({
    queryKey: [list, 'get', id],
    queryFn: () => entityApi(list).get(id),
    retry: false,
  });
  const title = (q.data as { title?: string } | undefined)?.title;
  return (
    <Text style={styles.text}>
      {title ?? (q.isError ? `A ${labelOf(specs()[list].name)} that no longer exists` : '…')}
    </Text>
  );
}

/**
 * A record (for a delete) hides "no" flags, which say nothing about what goes; parked input
 * keeps them, since there a false is the change being asked for.
 */
function Fields({
  input,
  record,
  type,
}: {
  input: Record<string, unknown>;
  record?: boolean;
  /** The entity the fields belong to, for its field labels. */
  type?: string;
}) {
  const { lang } = useT();
  const entries = Object.entries(input).filter(
    ([k, v]) => !hidden(k) && !isEmpty(v) && !(record && v === false),
  );
  return (
    <View style={{ gap: space.md }}>
      {entries.map(([key, value]) => (
        <View key={key} style={{ gap: 2 }}>
          <Text style={[styles.label, { color: colors.approvalText }]}>
            {fieldName(type, key, lang)}
          </Text>
          {refOf(key) && typeof value === 'string' ? (
            <RefValue list={refOf(key) as EntityName} id={value} />
          ) : (
            <Value name={key} value={value} />
          )}
        </View>
      ))}
    </View>
  );
}

/** For a delete: the record itself, so the person sees exactly what goes. */
function RecordPreview({ approval }: { approval: Approval }) {
  const plural = pluralOf(approval.resourceType);
  const id = approval.resourceId;
  const q = useQuery({
    queryKey: [plural, 'get', id],
    queryFn: () => entityApi(plural as EntityName).get(id as string),
    enabled: Boolean(plural && id),
    retry: false,
  });
  const label = labelOf(approval.resourceType);
  return (
    <View style={{ gap: space.md }}>
      <Text style={[styles.text, { fontWeight: '600', color: colors.danger }]}>
        Approving deletes this {label} permanently.
      </Text>
      {q.data ? (
        <Fields record type={approval.resourceType} input={q.data as Record<string, unknown>} />
      ) : q.isError ? (
        <Text style={styles.muted}>This {label} no longer exists.</Text>
      ) : (
        <Text style={styles.muted}>Loading the {label}…</Text>
      )}
    </View>
  );
}

/**
 * Exactly what approving will do, read from the parked input (or, for a delete, the record
 * itself). Generic: any command's or entity action's input renders here with no new UI.
 */
export function ApprovalPreview({ approval }: { approval: Approval }) {
  if (approval.action.endsWith('.delete')) return <RecordPreview approval={approval} />;
  const input = (approval.input ?? {}) as Record<string, unknown>;
  const visible = Object.entries(input).filter(([k, v]) => !hidden(k) && !isEmpty(v));
  if (visible.length === 0)
    return <Text style={styles.text}>Approving runs it with no further changes.</Text>;
  return <Fields type={approval.resourceType} input={input} />;
}
