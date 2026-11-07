import {
  type EntitySpec,
  statesOf,
  type TransitionDecl,
  transitionLabel,
  transitionsFrom,
} from '@hykr/contracts';
import type { Labels } from '@hykr/i18n';
import { pick } from '@hykr/i18n';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components/Button';
import { errorMessage } from '../../framework/hooks';
import { useT } from '../../framework/lang';
import { colors, space, styles } from '../../theme';
import { useActingPrincipal, useTransition } from './hooks';

/** camelCase → "Cancel reason", for a field without a label. */
const humanize = (key: string) => {
  const words = key
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The moves a person can make on a record from where it stands: one button per transition out
 * of its state that people may ask for (not the server's own, nor one needing a capability they
 * lack). A move its guard refuses is greyed, with the reason. A move that takes fields (a
 * reason) asks for them first. A move that waits for approval says so. The server checks
 * everything again.
 */
export function TransitionBar({
  spec,
  row,
}: {
  spec: EntitySpec;
  row: Readonly<Record<string, unknown>> & { id: string };
}) {
  const { lang } = useT();
  const me = useActingPrincipal();
  const held = me?.capabilities;
  const move = useTransition(spec);
  const [asking, setAsking] = useState<TransitionDecl | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [waiting, setWaiting] = useState<string | null>(null);
  const trait = statesOf(spec);
  if (!trait) return null;
  const offered = transitionsFrom(trait, row[trait.field]).filter(
    (t) => (t.expose ?? 'all') !== 'system' && (!t.can || !held || held.includes(t.can)),
  );
  if (!offered.length) return null;
  const labelOf = (field: string) => {
    const l = (spec.fieldLabels as Record<string, Labels | undefined> | undefined)?.[field];
    return l ? pick(l, lang) : humanize(field);
  };
  const run = (t: TransitionDecl, input: Record<string, unknown> = {}) => {
    setWaiting(null);
    move.mutate(
      { id: row.id, transition: t.name, input },
      {
        onSuccess: (r) => {
          setAsking(null);
          setValues({});
          if (r.status === 'needs_approval')
            setWaiting(r.approval.summary ?? `${transitionLabel(t, lang)} waits for approval`);
        },
      },
    );
  };
  const missing = (t: TransitionDecl) => (t.requires ?? []).some((f) => !values[f]?.trim());
  // The guard, on the record as it is (fields asked for later are checked by the server).
  const refusedBy = (t: TransitionDecl) => (me && t.guard ? t.guard(row, {}, me) : null);
  const refusals = offered.map(refusedBy).filter((r): r is NonNullable<typeof r> => r !== null);
  return (
    <View style={{ gap: space.sm }}>
      {asking ? (
        <View style={[styles.card, { gap: space.sm }]}>
          <Text style={styles.heading}>{transitionLabel(asking, lang)}</Text>
          {(asking.fields ?? []).map((f) => (
            <View key={f} style={{ gap: 2 }}>
              <Text style={styles.label}>
                {labelOf(f)}
                {(asking.requires ?? []).includes(f) ? '' : ' (optional)'}
              </Text>
              <TextInput
                style={styles.input}
                value={values[f] ?? ''}
                onChangeText={(v) => setValues((x) => ({ ...x, [f]: v }))}
                accessibilityLabel={labelOf(f)}
              />
            </View>
          ))}
          <View style={styles.row}>
            <Button
              title={transitionLabel(asking, lang)}
              busy={move.isPending}
              disabled={missing(asking)}
              onPress={() =>
                run(
                  asking,
                  Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== '')),
                )
              }
            />
            <Button title="Back" variant="subtle" onPress={() => setAsking(null)} />
          </View>
        </View>
      ) : (
        <View style={[styles.row, { flexWrap: 'wrap' }]}>
          {offered.map((t, i) => (
            <Button
              key={t.name}
              title={transitionLabel(t, lang)}
              variant={i === 0 ? 'primary' : 'secondary'}
              disabled={refusedBy(t) !== null}
              busy={move.isPending && move.variables?.transition === t.name}
              onPress={() => (t.fields?.length ? setAsking(t) : run(t))}
            />
          ))}
        </View>
      )}
      {!asking && refusals.length ? (
        <Text style={styles.muted}>{[...new Set(refusals.map((r) => r.reason))].join(' ')}</Text>
      ) : null}
      {waiting ? (
        <Text style={[styles.text, { color: colors.approvalText }]}>
          Waiting for approval: {waiting}
        </Text>
      ) : null}
      {move.error ? <Text style={styles.error}>{errorMessage(move.error)}</Text> : null}
    </View>
  );
}
