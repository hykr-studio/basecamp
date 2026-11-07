import { ShareError } from '@hykr/api-client';
import type { FormField, SharedForm } from '@hykr/contracts';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { DateField } from '../../framework/DateField';
import { Field } from '../../framework/Field';
import { useT } from '../../framework/lang';
import { colors, space, styles } from '../../theme';
import type { shareClientFor } from './client';

type Client = ReturnType<typeof shareClientFor>;

/** A typed-in answer as it is sent: numbers as numbers, amounts as decimals, empty as nothing. */
function answerOf(field: FormField, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return undefined;
  if (field.type === 'number' || field.type === 'integer') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

/** Yes and no, or a field's options, as buttons to pick one. */
function Choices({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { t } = useT();
  const options: { value: unknown; label: string }[] =
    field.type === 'boolean'
      ? [
          { value: true, label: t('share.form.yes') },
          { value: false, label: t('share.form.no') },
        ]
      : (field.options ?? []).map((o) => ({ value: o, label: o }));
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(on && !field.required ? undefined : o.value)}
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: on ? colors.primary : colors.border,
              backgroundColor: on ? colors.primaryTint : colors.card,
            }}
          >
            <Text style={{ color: on ? colors.primary : colors.text }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A public form (decisions B9): the application's questions and the business's own, in the
 * guest's language; each answer creates one record. The server checks every value again.
 */
export function PublicForm({ client, form }: { client: Client; form: SharedForm }) {
  const { t, pick } = useT();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const set = (key: string, v: unknown) => setAnswers((a) => ({ ...a, [key]: v }));
  if (sent) return <Text style={styles.heading}>{t('share.form.sent')}</Text>;
  if (form.remaining === 0) return <Text style={styles.text}>{t('share.used')}</Text>;

  const submit = async () => {
    const missing = form.fields.find(
      (f) => f.required && answerOf(f, answers[f.key]) === undefined,
    );
    if (missing) {
      setError(t('share.form.required', { field: pick(missing.label) }));
      return;
    }
    const values: Record<string, unknown> = {};
    const custom: Record<string, string | number | boolean> = {};
    for (const f of form.fields) {
      const v = answerOf(f, answers[f.key]);
      if (v === undefined) continue;
      if (f.custom) custom[f.key] = v as string | number | boolean;
      else values[f.key] = v;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await client.submit({
        values,
        ...(Object.keys(custom).length ? { custom } : {}),
      });
      if (r.status === 'done') setSent(true);
    } catch (e) {
      const body =
        e instanceof ShareError ? (e.body as { message?: string; error?: string }) : null;
      setError(
        body?.error === 'link_used'
          ? t('share.used')
          : (body?.message ?? (e instanceof Error ? e.message : String(e))),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.card, { gap: space.md }]}>
      <Text style={styles.heading}>{pick(form.label)}</Text>
      {form.description ? <Text style={styles.muted}>{pick(form.description)}</Text> : null}
      {form.fields.map((f) => {
        const label = `${pick(f.label)}${f.required ? ' *' : ''}`;
        const value = answers[f.key];
        if (f.type === 'boolean' || f.type === 'select')
          return (
            <View key={f.key} style={{ gap: space.xs }}>
              <Text style={styles.label}>{label}</Text>
              <Choices field={f} value={value} onChange={(v) => set(f.key, v)} />
            </View>
          );
        if (f.type === 'date')
          return (
            <DateField
              key={f.key}
              label={label}
              value={typeof value === 'string' ? value : ''}
              onChange={(v) => set(f.key, v)}
              optional={!f.required}
            />
          );
        return (
          <Field
            key={f.key}
            label={
              f.type === 'money'
                ? `${label} · ${t('share.form.amount', { currency: form.currency })}`
                : label
            }
            value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
            onChangeText={(v) => set(f.key, v)}
            keyboardType={
              f.type === 'number' || f.type === 'integer' || f.type === 'money'
                ? 'decimal-pad'
                : 'default'
            }
            multiline={f.type === 'longText'}
            multilineHeight={f.type === 'longText' ? 96 : undefined}
            maxLength={f.max && (f.type === 'text' || f.type === 'longText') ? f.max : undefined}
          />
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title={t('share.form.send')} icon="send" busy={busy} onPress={submit} />
    </View>
  );
}
