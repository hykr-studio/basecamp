import type { Approval } from '@app/contracts';
import { type Labels, type Lang, pick } from '@app/i18n';
import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { colors, space, styles } from '../theme';
import { dayLabel } from './dates';
import { type EntityName, entityApi, specs } from './hooks';
import { useT } from './lang';

/** The resource as people say it: "to-do", not "todo". */
export const labelOf = (type: string) =>
  Object.values(specs).find((s) => s.name === type)?.label ?? type;
const pluralOf = (type: string) =>
  (Object.entries(specs).find(([, s]) => s.name === type)?.[0] as EntityName | undefined) ?? null;

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
  const spec = type ? Object.values(specs).find((s) => s.name === type) : undefined;
  const labels = (spec?.fieldLabels as Record<string, Labels | undefined> | undefined)?.[key];
  if (labels) return pick(labels, lang);
  return refOf(key) ? humanize(key.slice(0, -2)) : humanize(key);
}

/** A field that points at another entity ("meetingId") and the list it lives in. */
const refOf = (key: string): EntityName | null => {
  if (!key.endsWith('Id')) return null;
  const plural = `${key.slice(0, -2)}s`;
  return plural in specs ? (plural as EntityName) : null;
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

function Value({ name, value }: { name: string; value: unknown }) {
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

/** "Meeting: Supplier call 1" rather than an id. */
function RefValue({ list, id }: { list: EntityName; id: string }) {
  const q = useQuery({
    queryKey: [list, 'get', id],
    queryFn: () => entityApi(list).get(id),
    retry: false,
  });
  const title = (q.data as { title?: string } | undefined)?.title;
  return (
    <Text style={styles.text}>
      {title ?? (q.isError ? `A ${labelOf(specs[list].name)} that no longer exists` : '…')}
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
