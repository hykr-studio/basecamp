// A business's custom fields in the app (A11): its definitions for an entity, a record's values
// shown with their labels, and inputs to change them. The server checks every value again.
import { type CustomField, CustomFieldSpec, type CustomFieldsInput } from '@hykr/contracts';
import { pick } from '@hykr/i18n';
import { useQuery } from '@tanstack/react-query';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../../api';
import { useLang } from '../../framework/lang';
import { colors, space, styles } from '../../theme';

/** The business's custom fields of one entity ('todo'), in their order. Empty while loading. */
export function useCustomFields(entity: string): CustomField[] {
  const q = useQuery({
    queryKey: ['custom-fields', entity],
    queryFn: () => api.entity(CustomFieldSpec).list({ entity, limit: 200 }),
    staleTime: 60_000,
  });
  return (q.data?.items ?? []) as CustomField[];
}

/** A field's label in the reader's language (English when it has none). */
export function useFieldLabel() {
  const { lang } = useLang();
  return (f: Pick<CustomField, 'label'>) =>
    pick({ hi: f.label.en, te: f.label.en, ...f.label }, lang);
}

const shown = (value: unknown) =>
  typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

/**
 * A record's custom values, as small "Label: value" chips: only fields the business still
 * defines, in its order. Nothing when there is none.
 */
export function CustomFieldValues({
  entity,
  values,
}: {
  entity: string;
  values: Readonly<Record<string, unknown>> | null | undefined;
}) {
  const fields = useCustomFields(entity);
  const label = useFieldLabel();
  const set = fields.filter((f) => values?.[f.key] !== undefined && values?.[f.key] !== '');
  if (!set.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
      {set.map((f) => (
        <Text
          key={f.key}
          style={[
            styles.muted,
            { backgroundColor: colors.primaryTint, borderRadius: 6, paddingHorizontal: space.sm },
          ]}
        >
          {label(f)}: {shown(values?.[f.key])}
        </Text>
      ))}
    </View>
  );
}

/**
 * Inputs for a record's custom values: a choice for a select or yes/no, text otherwise. It
 * reports a patch (`{ key: value }`, null to clear one), ready for the record's `custom`.
 */
export function CustomFieldInputs({
  entity,
  values,
  onChange,
}: {
  entity: string;
  values: Readonly<Record<string, unknown>> | null | undefined;
  onChange: (patch: CustomFieldsInput) => void;
}) {
  const fields = useCustomFields(entity);
  const label = useFieldLabel();
  if (!fields.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {fields.map((f) => {
        const value = values?.[f.key];
        const choices =
          f.type === 'select' ? f.options : f.type === 'boolean' ? ['true', 'false'] : null;
        return (
          <View key={f.key} style={{ gap: space.xs }}>
            <Text style={styles.label}>
              {label(f)}
              {f.required ? ' *' : ''}
            </Text>
            {choices ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                {choices.map((c) => {
                  const typed = f.type === 'boolean' ? c === 'true' : c;
                  const on = value === typed;
                  return (
                    <Pressable
                      key={c}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      onPress={() => onChange({ [f.key]: on && !f.required ? null : typed })}
                      style={{
                        paddingHorizontal: space.md,
                        paddingVertical: space.xs,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: on ? colors.primary : colors.border,
                        backgroundColor: on ? colors.primaryTint : colors.card,
                      }}
                    >
                      <Text style={{ color: on ? colors.primary : colors.text }}>
                        {f.type === 'boolean' ? shown(typed) : c}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={label(f)}
                defaultValue={value === undefined ? '' : String(value)}
                placeholder={f.type === 'date' ? 'YYYY-MM-DD' : undefined}
                placeholderTextColor={colors.placeholder}
                keyboardType={f.type === 'number' ? 'numeric' : 'default'}
                onEndEditing={(e) => {
                  const text = e.nativeEvent.text.trim();
                  if (!text) return onChange({ [f.key]: null });
                  onChange({ [f.key]: f.type === 'number' ? Number(text) : text });
                }}
                style={styles.input}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}
