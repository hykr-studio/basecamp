import type { Approval } from '@app/contracts';
import { Text, View } from 'react-native';
import { colors, space, styles } from '../theme';
import { specs } from './hooks';

/** The resource as people say it: "to-do", not "todo". */
const labelOf = (type: string) => Object.values(specs).find((s) => s.name === type)?.label ?? type;

/** camelCase → "Action items" */
const humanize = (key: string) => {
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const hidden = (key: string) => key === 'id' || key.endsWith('Id');
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function Value({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <View style={{ gap: 2 }}>
        {value.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a read-only preview in input order
          <Text key={i} style={styles.text}>
            {'•  '}
            {typeof item === 'object' && item
              ? [
                  (item as { title?: string }).title,
                  (item as { dueOn?: string }).dueOn
                    ? `due ${(item as { dueOn: string }).dueOn}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' — ') || JSON.stringify(item)
              : String(item)}
          </Text>
        ))}
      </View>
    );
  }
  if (typeof value === 'boolean') return <Text style={styles.text}>{value ? 'Yes' : 'No'}</Text>;
  if (typeof value === 'object' && value)
    return <Preview input={value as Record<string, unknown>} />;
  return <Text style={styles.text}>{String(value)}</Text>;
}

function Preview({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([k, v]) => !hidden(k) && !isEmpty(v));
  return (
    <View style={{ gap: space.md }}>
      {entries.map(([key, value]) => (
        <View key={key} style={{ gap: 2 }}>
          <Text style={[styles.label, { color: colors.warnText }]}>{humanize(key)}</Text>
          <Value value={value} />
        </View>
      ))}
    </View>
  );
}

/**
 * Exactly what approving will write, read from the parked input. Generic: it renders any
 * command's or entity action's input, so new commands need no new UI here.
 */
export function ApprovalPreview({ approval }: { approval: Approval }) {
  const verb = approval.action.split('.').pop();
  const input = (approval.input ?? {}) as Record<string, unknown>;
  const visible = Object.entries(input).filter(([k, v]) => !hidden(k) && !isEmpty(v));
  if (visible.length === 0) {
    return (
      <Text style={styles.text}>
        {verb === 'delete'
          ? `Approving removes this ${labelOf(approval.resourceType)} permanently.`
          : `Approving runs ${approval.action} with no further changes.`}
      </Text>
    );
  }
  return <Preview input={input} />;
}
